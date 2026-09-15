"use strict";

const https = require("node:https");
const dns = require("node:dns").promises;
const net = require("node:net");
const zlib = require("node:zlib");
const LIMITS = Object.freeze({
  urlChars: 4096,
  redirects: 3,
  pageBytes: 1024 * 1024,
  imageBytes: 5 * 1024 * 1024,
  textChars: 24000,
  titleChars: 500,
  links: 100,
  images: 64,
  jsonNodes: 2000,
});
class ImageSourceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ImageSourceError";
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}
const fail = (status, code, message) => {
  throw new ImageSourceError(status, code, message);
};
function ipv4Number(address) {
  return address
    .split(".")
    .reduce((value, octet) => value * 256 + Number(octet), 0);
}
function ipv6Number(address) {
  const sides = address.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  return [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ].reduce((value, word) => (value << 16n) + BigInt(`0x${word}`), 0n);
}
// Conservative exclusions based on IANA special-purpose registries. Transition
// and mapped IPv6 ranges are excluded even when they embed a public IPv4 address.
function isPublicAddress(address) {
  const family = typeof address === "string" ? net.isIP(address) : 0;
  if (family === 4) {
    const value = ipv4Number(address);
    const excluded = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !excluded.some(
      ([base, bits]) =>
        Math.floor(value / 2 ** (32 - bits)) ===
        Math.floor(ipv4Number(base) / 2 ** (32 - bits)),
    );
  }
  if (family !== 6 || address.includes(".") || address.includes("%"))
    return false;
  const value = ipv6Number(address);
  const inRange = (base, bits) =>
    value >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits);
  return (
    inRange("2000::", 3) &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([base, bits]) => inRange(base, bits))
  );
}
function sourceURL(value, base) {
  const invalid = () =>
    fail(
      400,
      "unsafe_source_url",
      "Use a public HTTPS product source URL without credentials or a custom port.",
    );
  if (
    typeof value !== "string" ||
    !value ||
    value.length > LIMITS.urlChars ||
    /[\u0000-\u0020\u007F\\]/.test(value)
  )
    invalid();
  let url;
  try {
    url = new URL(value, base);
  } catch {
    invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.href.length > LIMITS.urlChars
  )
    invalid();
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (
    !hostname ||
    /(^|\.)(localhost|local|internal|home|lan|localdomain)$/.test(hostname)
  )
    invalid();
  const family = net.isIP(hostname);
  if (
    family
      ? !isPublicAddress(hostname)
      : !hostname.includes(".") ||
        !/^[a-z0-9.-]+$/.test(hostname) ||
        hostname
          .split(".")
          .some(
            (label) =>
              !label ||
              label.length > 63 ||
              label.startsWith("-") ||
              label.endsWith("-"),
          )
  )
    invalid();
  url.hash = "";
  if (!family) url.hostname = hostname;
  return url;
}
function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
async function resolvePublic(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  if (
    !Array.isArray(addresses) ||
    !addresses.length ||
    addresses.length > 64 ||
    addresses.some(
      (record) =>
        !record ||
        !isPublicAddress(record.address) ||
        net.isIP(record.address) !== record.family,
    )
  )
    fail(
      400,
      "unsafe_source_address",
      "The product source must resolve only to public internet addresses.",
    );
  return addresses.find((record) => record.family === 4) || addresses[0];
}
function requestResponse(url, address, requestImpl, signal, kind) {
  let req;
  const pending = new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const pinnedLookup = (requestedHost, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      if (
        requestedHost.replace(/^\[|\]$/g, "").toLowerCase() !==
        hostname.toLowerCase()
      ) {
        callback(new Error("Unexpected source hostname"));
        return;
      }
      if (options?.all)
        callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    req = requestImpl(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup,
        family: address.family,
        autoSelectFamily: false,
        servername: net.isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          "user-agent": "AlabamaWholesaleProductImages/1.0",
          accept:
            kind === "page"
              ? "text/html,application/xhtml+xml"
              : "image/png,image/jpeg,image/webp",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (response) => {
        if (signal.aborted) response.destroy();
        else resolve(response);
      },
    );
    req.on("error", reject);
    req.end();
  });
  return withAbort(pending, signal).catch((error) => {
    req?.destroy();
    throw error;
  });
}
async function responseBytes(response, limit, signal) {
  const declared = response.headers["content-length"];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(String(declared)) || Number(declared) > limit)
  ) {
    response.destroy();
    fail(
      413,
      "source_too_large",
      "The product source is larger than the supported size.",
    );
  }
  const encoding = String(response.headers["content-encoding"] || "identity")
    .trim()
    .toLowerCase();
  if (!["identity", "gzip", "deflate", "br"].includes(encoding)) {
    response.destroy();
    fail(
      415,
      "unsupported_source_type",
      "The product source uses an unsupported encoding.",
    );
  }
  const chunks = [];
  let total = 0;
  const iterator = response[Symbol.asyncIterator]();
  try {
    while (true) {
      const { value, done } = await withAbort(iterator.next(), signal);
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.length;
      if (total > limit)
        fail(
          413,
          "source_too_large",
          "The product source is larger than the supported size.",
        );
      chunks.push(chunk);
    }
  } finally {
    if (!response.readableEnded) response.destroy();
  }
  const encoded = Buffer.concat(chunks, total);
  if (encoding === "identity") return encoded;
  try {
    const decode =
      encoding === "gzip"
        ? zlib.gunzipSync
        : encoding === "deflate"
          ? zlib.inflateSync
          : zlib.brotliDecompressSync;
    return decode(encoded, { maxOutputLength: limit });
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE")
      fail(
        413,
        "source_too_large",
        "The decompressed product source is larger than the supported size.",
      );
    fail(
      502,
      "invalid_source_response",
      "The product source could not be decoded.",
    );
  }
}
function decodeEntities(value) {
  const names = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|quot|apos|lt|gt|nbsp);/gi,
    (whole, entity) => {
      if (entity[0] !== "#") return names[entity.toLowerCase()] || whole;
      const point =
        entity[1].toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return point > 0 &&
        point <= 0x10ffff &&
        !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "";
    },
  );
}
function plainText(value, limit) {
  return decodeEntities(value.replace(/<[^<>]*>/g, " "))
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
function attributes(tag) {
  const result = Object.create(null);
  let cursor = 0;
  while (cursor < tag.length) {
    while (cursor < tag.length && /[\s/>]/.test(tag[cursor])) cursor++;
    const start = cursor;
    while (cursor < tag.length && !/[\s=<>/'"]/.test(tag[cursor])) cursor++;
    if (cursor === start) {
      cursor++;
      continue;
    }
    const key = tag.slice(start, cursor).toLowerCase();
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    if (tag[cursor] !== "=") continue;
    cursor++;
    while (cursor < tag.length && /\s/.test(tag[cursor])) cursor++;
    let value;
    const quote = tag[cursor];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, cursor + 1);
      if (end < 0) break;
      value = tag.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      const valueStart = cursor;
      while (cursor < tag.length && !/[\s>]/.test(tag[cursor])) cursor++;
      value = tag.slice(valueStart, cursor);
    }
    if (!(key in result)) result[key] = decodeEntities(value);
  }
  return result;
}
function parsePage(html, url) {
  const lower = html.toLowerCase();
  const images = [],
    imageURLs = new Set(),
    links = [],
    linkURLs = new Set();
  const textParts = [];
  const ordinaryImages = [];
  let title = "",
    anchor = null,
    titleParts = null,
    visited = 0;
  const observedURL = (value) => {
    try {
      return typeof value === "string" ? sourceURL(value.trim(), url) : null;
    } catch {
      return null;
    }
  };
  const addImage = (value, source, name) => {
    if (images.length >= LIMITS.images || typeof value !== "string") return;
    const candidate = observedURL(value);
    if (!candidate || imageURLs.has(candidate.href)) return;
    imageURLs.add(candidate.href);
    images.push({
      url: candidate.href,
      source,
      ...(typeof name === "string" && name.trim()
        ? { name: plainText(name.slice(0, 1200), 300) }
        : {}),
    });
  };
  const readProductJSON = (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const stack = [{ data, depth: 0 }];
    while (stack.length && visited < LIMITS.jsonNodes) {
      const node = stack.pop();
      visited++;
      if (!node.data || typeof node.data !== "object" || node.depth > 16)
        continue;
      if (Array.isArray(node.data)) {
        for (const child of node.data.slice(0, LIMITS.jsonNodes))
          stack.push({ data: child, depth: node.depth + 1 });
        continue;
      }
      const types = Array.isArray(node.data["@type"])
        ? node.data["@type"]
        : [node.data["@type"]];
      if (
        types.some(
          (type) =>
            type === "Product" ||
            type === "https://schema.org/Product" ||
            type === "http://schema.org/Product",
        )
      ) {
        const values = Array.isArray(node.data.image)
          ? node.data.image
          : [node.data.image];
        for (const value of values.slice(0, LIMITS.images))
          addImage(
            typeof value === "string" ? value : value?.contentUrl || value?.url,
            "json-ld",
            node.data.name,
          );
      }
      for (const child of Object.values(node.data).slice(0, LIMITS.jsonNodes))
        if (child && typeof child === "object")
          stack.push({ data: child, depth: node.depth + 1 });
    }
  };
  const addText = (value) => {
    textParts.push(value);
    if (anchor) anchor.parts.push(value);
    if (titleParts) titleParts.push(value);
  };
  // A forward-only scanner deliberately avoids a DOM, execution, or unbounded
  // tag regexes. Unterminated quoted tags cannot make parsing quadratic.
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      addText(html.slice(cursor));
      break;
    }
    addText(html.slice(cursor, start));
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      cursor = end < 0 ? html.length : end + 3;
      continue;
    }
    let end = start + 1,
      quote = "";
    for (; end < html.length && end - start <= 8192; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end >= html.length || end - start > 8192) {
      cursor = end;
      continue;
    }
    const tag = html.slice(start + 1, end);
    const nameMatch = /^\s*(\/?)\s*([a-z][a-z0-9-]*)\b/i.exec(tag);
    cursor = end + 1;
    if (!nameMatch) continue;
    const closing = Boolean(nameMatch[1]),
      name = nameMatch[2].toLowerCase();
    if (
      !closing &&
      ["script", "style", "noscript", "template"].includes(name)
    ) {
      let close = lower.indexOf(`</${name}`, cursor);
      while (close >= 0 && !/[\s>]/.test(lower[close + name.length + 2] || ""))
        close = lower.indexOf(`</${name}`, close + name.length + 2);
      if (close < 0) {
        cursor = html.length;
        continue;
      }
      if (
        name === "script" &&
        (attributes(tag).type || "").toLowerCase() === "application/ld+json"
      )
        readProductJSON(html.slice(cursor, close));
      const closeEnd = html.indexOf(">", close);
      cursor = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    if (!closing && name === "meta") {
      const attrs = attributes(tag);
      if (
        ["og:image", "og:image:url", "og:image:secure_url"].includes(
          (attrs.property || "").toLowerCase(),
        )
      )
        addImage(attrs.content, "og:image");
    }
    if (!closing && name === "img" && ordinaryImages.length < LIMITS.images) {
      const attrs = attributes(tag);
      const tiny = [attrs.width, attrs.height].some(
        (value) => /^\d+$/.test(value || "") && Number(value) <= 2,
      );
      const candidate = observedURL(attrs["data-src"] || attrs.src);
      if (!tiny && candidate && !/\.svg$/i.test(candidate.pathname))
        ordinaryImages.push({ url: candidate.href, name: attrs.alt });
    }
    if (name === "a") {
      if (closing && anchor) {
        if (links.length < LIMITS.links && !linkURLs.has(anchor.url)) {
          links.push({
            url: anchor.url,
            text: plainText(anchor.parts.join(" "), 300),
          });
          linkURLs.add(anchor.url);
        }
        anchor = null;
      } else if (!closing) {
        const candidate = observedURL(attributes(tag).href);
        anchor =
          candidate && candidate.hostname === url.hostname
            ? { url: candidate.href, parts: [] }
            : null;
      }
    }
    if (name === "title") {
      if (!closing && !title) titleParts = [];
      else if (closing && titleParts) {
        title = plainText(titleParts.join(" "), LIMITS.titleChars);
        titleParts = null;
      }
    }
    addText(" ");
  }
  for (const image of ordinaryImages) addImage(image.url, "img", image.name);
  return {
    url: url.href,
    title,
    text: plainText(textParts.join(" "), LIMITS.textChars),
    links,
    images,
  };
}
function imageResult(bytes, mimeType, url) {
  const png =
    bytes.length >= 33 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR";
  const jpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  const webp =
    bytes.length >= 20 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(
      bytes.subarray(12, 16).toString("ascii"),
    ) &&
    bytes.readUInt32LE(4) + 8 === bytes.length;
  if (
    !(mimeType === "image/png" ? png : mimeType === "image/jpeg" ? jpeg : webp)
  )
    fail(
      422,
      "invalid_source_image",
      "The source did not return a valid PNG, JPEG, or WebP image.",
    );
  return { url: url.href, mimeType, data: bytes.toString("base64") };
}
function createSourceFetcher({
  lookup = dns.lookup.bind(dns),
  requestImpl = https.request,
  timeoutMs = 15000,
} = {}) {
  if (typeof lookup !== "function" || typeof requestImpl !== "function")
    throw new TypeError("DNS and HTTPS request implementations are required");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new TypeError("timeoutMs must be between 1 and 15000");
  async function fetchSource(value, kind) {
    let url = sourceURL(value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let redirects = 0; ; redirects++) {
        const address = await resolvePublic(url, lookup, controller.signal);
        const response = await requestResponse(
          url,
          address,
          requestImpl,
          controller.signal,
          kind,
        );
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          if (redirects >= LIMITS.redirects)
            fail(
              502,
              "source_redirect_limit",
              "The product source redirected too many times.",
            );
          url = sourceURL(response.headers.location, url);
          continue;
        }
        if (response.statusCode !== 200) {
          response.destroy();
          fail(
            502,
            "source_unavailable",
            "The product source is not currently available.",
          );
        }
        const mimeType = String(response.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (
          !(
            kind === "page"
              ? ["text/html", "application/xhtml+xml"]
              : ["image/png", "image/jpeg", "image/webp"]
          ).includes(mimeType)
        ) {
          response.destroy();
          fail(
            415,
            "unsupported_source_type",
            kind === "page"
              ? "The product source did not return a web page."
              : "Use a source that returns a PNG, JPEG, or WebP image.",
          );
        }
        const bytes = await responseBytes(
          response,
          kind === "page" ? LIMITS.pageBytes : LIMITS.imageBytes,
          controller.signal,
        );
        return kind === "page"
          ? parsePage(bytes.toString("utf8"), url)
          : imageResult(bytes, mimeType, url);
      }
    } catch (error) {
      if (controller.signal.aborted)
        fail(
          504,
          "source_timeout",
          "The product source took too long to respond.",
        );
      if (error instanceof ImageSourceError) throw error;
      fail(
        502,
        "source_unavailable",
        "The product source could not be reached securely.",
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    fetchSourcePage: (url) => fetchSource(url, "page"),
    fetchSourceImage: (url) => fetchSource(url, "image"),
  };
}

module.exports = {
  ...createSourceFetcher(),
  createSourceFetcher,
  isPublicAddress,
  LIMITS,
  ImageSourceError,
};
