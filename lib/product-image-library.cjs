"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const LIMITS = Object.freeze({
  imageBytes: 5 * 1024 * 1024,
  files: 5000,
  candidates: 2,
  nameChars: 300,
});
const TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
});
const GENERIC = new Set(
  "a an and the of for with to in small large mini big regular assorted assortedness new single twin pack packs box bag bags bottle bottles drink drinks water candy gum cups cup paper plastic food product products".split(
    " ",
  ),
);
function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function scoreName(query, item) {
  if (item.name === query) return 1000;
  if (item.family === query) return 900;
  const tokens = query.split(" ");
  const leading = tokens[0];
  if (tokens.length < 2 || leading.length < 4 || GENERIC.has(leading)) return 0;
  if (
    item.tokens[0] !== leading ||
    !tokens.every((token) => item.tokens.includes(token))
  )
    return 0;
  return 500 - Math.min(100, item.tokens.length - tokens.length);
}
function validImage(bytes, mimeType) {
  if (mimeType === "image/png")
    return (
      bytes.length >= 33 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.subarray(12, 16).toString("ascii") === "IHDR"
    );
  if (mimeType === "image/jpeg")
    return (
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    );
  return (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(
      bytes.subarray(12, 16).toString("ascii"),
    ) &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  );
}
async function readImage(filename, mimeType) {
  let handle;
  try {
    // Recheck the opened object, rather than trusting cached directory metadata.
    // O_NOFOLLOW prevents a later symlink replacement from escaping the library.
    handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4 || stat.size > LIMITS.imageBytes)
      return null;
    const chunks = [];
    let total = 0;
    while (total <= LIMITS.imageBytes) {
      const buffer = Buffer.allocUnsafe(
        Math.min(65536, LIMITS.imageBytes + 1 - total),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > LIMITS.imageBytes) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    return validImage(bytes, mimeType) ? bytes : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
function createProductImageLibrary({ directory, appOrigin } = {}) {
  if (
    typeof directory !== "string" ||
    !directory ||
    !path.isAbsolute(directory)
  )
    throw new TypeError("An absolute image library directory is required");
  let origin;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new TypeError("A public HTTPS app origin is required");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    (origin.port && origin.port !== "443") ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new TypeError("A public HTTPS app origin is required");
  let indexPromise;
  async function index() {
    if (!indexPromise)
      indexPromise = (async () => {
        try {
          const root = await fs.lstat(directory);
          if (!root.isDirectory() || root.isSymbolicLink()) return [];
          const entries = (await fs.readdir(directory, { withFileTypes: true }))
            .filter(
              (entry) =>
                entry.isFile() &&
                !entry.isSymbolicLink() &&
                !/[\\/\u0000-\u001F]/.test(entry.name) &&
                TYPES[path.extname(entry.name).toLowerCase()],
            )
            .sort((a, b) =>
              a.name.localeCompare(b.name, "en", { numeric: true }),
            )
            .slice(0, LIMITS.files);
          const result = [];
          for (const entry of entries) {
            const filename = path.join(directory, entry.name);
            let stat;
            try {
              stat = await fs.lstat(filename);
            } catch {
              continue;
            }
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.size < 4 ||
              stat.size > LIMITS.imageBytes
            )
              continue;
            const name = normalize(path.parse(entry.name).name);
            const family = name.replace(/\s+\d{1,4}$/, "");
            result.push({
              filename,
              displayName: entry.name,
              name,
              family,
              tokens: family.split(" "),
              mimeType: TYPES[path.extname(entry.name).toLowerCase()],
            });
          }
          return result;
        } catch {
          return [];
        }
      })();
    return indexPromise;
  }
  return async function find(product) {
    if (
      typeof product?.name !== "string" ||
      !product.name.trim() ||
      product.name.length > LIMITS.nameChars
    )
      return [];
    const query = normalize(product.name);
    const items = (await index())
      .map((item) => ({ item, score: scoreName(query, item) }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.item.displayName.localeCompare(b.item.displayName, "en", {
            numeric: true,
          }),
      );
    const candidates = [];
    for (const { item } of items) {
      if (candidates.length === LIMITS.candidates) break;
      const bytes = await readImage(item.filename, item.mimeType);
      if (!bytes) continue;
      const url = `${origin.origin}/images/${encodeURIComponent(item.displayName)}`;
      candidates.push({
        page: {
          url,
          title: `Existing catalog image: ${item.displayName}`,
          text: `Image filename already included in the Alabama Wholesale catalog: ${item.displayName}. The filename is unverified metadata; the photograph must be checked against the requested product.`,
        },
        image: { url, mimeType: item.mimeType, data: bytes.toString("base64") },
      });
    }
    return candidates;
  };
}
module.exports = { createProductImageLibrary, LIMITS };
