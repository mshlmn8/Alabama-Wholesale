"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const {
  createSourceFetcher,
  isPublicAddress,
  LIMITS,
} = require("../lib/image-source.cjs");
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=",
  "base64",
);
function transport(routes, calls = []) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = (error) => {
      queueMicrotask(() => req.emit("error", error || new Error("Destroyed")));
    };
    req.end = () =>
      queueMicrotask(async () => {
        try {
          const pinned = await new Promise((resolve, reject) =>
            options.lookup(
              new URL(url).hostname,
              {},
              (error, address, family) =>
                error ? reject(error) : resolve({ address, family }),
            ),
          );
          calls.push({ url: String(url), options, pinned });
          const route = routes[String(url)] || { status: 404, body: "Missing" };
          const response = route.stream || Readable.from([route.body ?? ""]);
          response.statusCode = route.status || 200;
          response.headers = {
            "content-type": "text/html; charset=utf-8",
            ...route.headers,
          };
          callback(response);
        } catch (error) {
          req.emit("error", error);
        }
      });
    return req;
  };
}
function fixture(routes, opts = {}) {
  const calls = [];
  return {
    calls,
    ...createSourceFetcher({
      lookup: async () => PUBLIC,
      requestImpl: transport(routes, calls),
      ...opts,
    }),
  };
}
const errorIs = (code) => (error) => error.code === code;

test("rejects private, loopback, link-local, mapped, transition and special-use IP addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.1.2.3",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.0.0.1",
    "192.0.2.4",
    "198.18.0.1",
    "198.51.100.4",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::808:808",
    "2001:db8::1",
    "2002:7f00:1::",
    "2001::1",
    "3fff::1",
    "nonsense",
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])
    assert.equal(isPublicAddress(address), true, address);
});

test("blocks unsafe URL forms before DNS or transport", async () => {
  const source = fixture(
    {},
    {
      lookup: async () => {
        assert.fail("Unsafe URL reached DNS");
      },
    },
  );
  for (const url of [
    "http://example.com/",
    "file:///etc/passwd",
    "https://name:password@example.com/",
    "https://example.com:8443/",
    "https://localhost/",
    "https://host.local/",
    "https://metadata.google.internal/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://[::ffff:8.8.8.8]/",
    "https://example.com/\nattack",
    "x".repeat(LIMITS.urlChars + 1),
  ])
    await assert.rejects(
      () => source.fetchSourcePage(url),
      errorIs("unsafe_source_url"),
    );
  assert.equal(source.calls.length, 0);
});

test("rejects private DNS answers and mixed public/private addresses", async () => {
  for (const addresses of [
    [{ address: "169.254.169.254", family: 4 }],
    [...PUBLIC, { address: "10.0.0.1", family: 4 }],
    [{ address: "::ffff:93.184.216.34", family: 6 }],
    [],
  ]) {
    const source = fixture({}, { lookup: async () => addresses });
    await assert.rejects(
      () => source.fetchSourcePage("https://example.com/"),
      errorIs("unsafe_source_address"),
    );
    assert.equal(source.calls.length, 0);
  }
});

test("pins validated DNS for TLS transport and never sends auth or cookies", async () => {
  let lookups = 0;
  const source = fixture(
    { "https://example.com/item": { body: "<title>Item</title>" } },
    {
      lookup: async () => {
        lookups++;
        return lookups === 1 ? PUBLIC : [{ address: "127.0.0.1", family: 4 }];
      },
    },
  );
  const result = await source.fetchSourcePage(
    "https://example.com/item#fragment",
  );
  assert.equal(result.url, "https://example.com/item");
  assert.equal(lookups, 1);
  assert.deepEqual(source.calls[0].pinned, PUBLIC[0]);
  assert.equal(source.calls[0].options.agent, false);
  assert.equal(source.calls[0].options.rejectUnauthorized, true);
  assert.equal(source.calls[0].options.servername, "example.com");
  assert.equal(source.calls[0].options.headers.cookie, undefined);
  assert.equal(source.calls[0].options.headers.authorization, undefined);
  assert.equal(source.calls[0].options.headers.referer, undefined);
});

test("revalidates every redirect and blocks redirect access to metadata or a rebinding hostname", async () => {
  const direct = fixture({
    "https://example.com/": {
      status: 302,
      headers: { location: "https://169.254.169.254/latest/meta-data" },
    },
  });
  await assert.rejects(
    () => direct.fetchSourcePage("https://example.com/"),
    errorIs("unsafe_source_url"),
  );
  assert.equal(direct.calls.length, 1);
  let lookups = 0;
  const rebound = fixture(
    {
      "https://example.com/": {
        status: 302,
        headers: { location: "/private" },
      },
    },
    {
      lookup: async () =>
        ++lookups === 1 ? PUBLIC : [{ address: "10.0.0.1", family: 4 }],
    },
  );
  await assert.rejects(
    () => rebound.fetchSourcePage("https://example.com/"),
    errorIs("unsafe_source_address"),
  );
  assert.equal(rebound.calls.length, 1);
});

test("allows at most three redirects and returns the final source URL", async () => {
  const routes = {};
  for (let i = 0; i < 4; i++)
    routes[`https://example.com/${i}`] = {
      status: 302,
      headers: { location: `/${i + 1}` },
    };
  const source = fixture(routes);
  await assert.rejects(
    () => source.fetchSourcePage("https://example.com/0"),
    errorIs("source_redirect_limit"),
  );
  assert.equal(source.calls.length, 4);
  const okay = fixture({
    "https://example.com/start": {
      status: 301,
      headers: { location: "/item" },
    },
    "https://example.com/item": { body: "<title>Item</title>" },
  });
  assert.equal(
    (await okay.fetchSourcePage("https://example.com/start")).url,
    "https://example.com/item",
  );
});

test("extracts only observed same-host links and Product/OG image metadata without script execution", async () => {
  const html = `<!doctype html><title>Water &amp; More</title><style>PRIVATE_STYLE</style><script>global.pwned=true; PRIVATE_SCRIPT</script>
    <!-- <meta property="og:image" content="https://evil.example/fake.png"> -->
    <meta content="/media/water.png?a=1&amp;b=2" property="og:image">
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","image":"https://evil.example/logo.png"},{"@type":["Thing","Product"],"name":"Water","image":["/media/item.jpg",{"@type":"ImageObject","contentUrl":"https://cdn.example.com/item.webp"}]}]}</script>
    <a href="/products/water">Water &amp; drinks</a><a href="https://evil.example/">External</a><a href="javascript:alert(1)">Bad</a><a href="https://sub.example.com/">Other host</a>
    <img src="https://evil.example/unrelated.svg"><p>Real product description.</p>`;
  const source = fixture({ "https://example.com/product": { body: html } });
  const result = await source.fetchSourcePage("https://example.com/product");
  assert.equal(result.title, "Water & More");
  assert.deepEqual(result.links, [
    { url: "https://example.com/products/water", text: "Water & drinks" },
  ]);
  assert.deepEqual(
    result.images.map((image) => image.url).sort(),
    [
      "https://cdn.example.com/item.webp",
      "https://example.com/media/item.jpg",
      "https://example.com/media/water.png?a=1&b=2",
    ].sort(),
  );
  assert.equal(result.text.includes("PRIVATE_"), false);
  assert.equal(result.text.includes("@graph"), false);
  assert.match(result.text, /Real product description/);
  assert.equal(global.pwned, undefined);
});

test("malformed JSON-LD and dangerous metadata URLs are ignored and parser output stays bounded", async () => {
  const body = `<script type='application/ld+json'>{bad json</script><meta property='og:image' content='http://example.com/p.png'><meta property='og:image' content='https://user:pass@example.com/p.png'>${Array.from({ length: 300 }, (_, n) => `<a href='/p/${n}'>Product ${n}</a><meta property='og:image' content='/i/${n}.png'>`).join("")}<p>${"hello ".repeat(10000)}</p>`;
  const source = fixture({ "https://example.com/": { body } });
  const result = await source.fetchSourcePage("https://example.com/");
  assert.equal(result.links.length, LIMITS.links);
  assert.equal(result.images.length, LIMITS.images);
  assert.ok(result.text.length <= LIMITS.textChars);
});

test("bounds declared, streamed and decompressed page data", async () => {
  for (const route of [
    {
      body: "<title>Small</title>",
      headers: { "content-length": String(LIMITS.pageBytes + 1) },
    },
    { body: "x".repeat(LIMITS.pageBytes + 1) },
    {
      body: zlib.gzipSync("x".repeat(LIMITS.pageBytes + 1)),
      headers: { "content-encoding": "gzip" },
    },
    {
      body: zlib.brotliCompressSync("x".repeat(LIMITS.pageBytes + 1)),
      headers: { "content-encoding": "br" },
    },
  ]) {
    const source = fixture({ "https://example.com/": route });
    await assert.rejects(
      () => source.fetchSourcePage("https://example.com/"),
      errorIs("source_too_large"),
    );
  }
});

test("accepts compressed HTML and rejects unsupported response types and upstream errors", async () => {
  const source = fixture({
    "https://example.com/": {
      body: zlib.gzipSync("<title>Water</title>"),
      headers: { "content-encoding": "gzip" },
    },
  });
  assert.equal(
    (await source.fetchSourcePage("https://example.com/")).title,
    "Water",
  );
  for (const route of [
    { body: "{}", headers: { "content-type": "application/json" } },
    { body: "<html/>", headers: { "content-encoding": "made-up" } },
    { status: 403, body: "PRIVATE_DIAGNOSTIC" },
  ]) {
    const bad = fixture({ "https://example.com/": route });
    await assert.rejects(
      () => bad.fetchSourcePage("https://example.com/"),
      (error) => !error.message.includes("PRIVATE"),
    );
  }
});

test("image fetch verifies supported MIME type and file magic and preserves source bytes", async () => {
  const source = fixture({
    "https://cdn.example.com/water.png": {
      body: png,
      headers: { "content-type": "image/png" },
    },
  });
  assert.deepEqual(
    await source.fetchSourceImage("https://cdn.example.com/water.png"),
    {
      url: "https://cdn.example.com/water.png",
      mimeType: "image/png",
      data: png.toString("base64"),
    },
  );
  for (const route of [
    { body: png, headers: { "content-type": "image/jpeg" } },
    { body: "<svg/>", headers: { "content-type": "image/svg+xml" } },
    {
      body: "<html>not a photo</html>",
      headers: { "content-type": "image/png" },
    },
    {
      body: Buffer.alloc(LIMITS.imageBytes + 1),
      headers: { "content-type": "image/png" },
    },
  ]) {
    const invalid = fixture({ "https://example.com/image": route });
    await assert.rejects(
      () => invalid.fetchSourceImage("https://example.com/image"),
      (error) =>
        [
          "invalid_source_image",
          "source_too_large",
          "unsupported_source_type",
        ].includes(error.code),
    );
  }
});

test("whole operation timeout covers stalled DNS, headers and response body", async () => {
  const dns = fixture(
    {},
    { timeoutMs: 10, lookup: async () => new Promise(() => {}) },
  );
  await assert.rejects(
    () => dns.fetchSourcePage("https://example.com/"),
    errorIs("source_timeout"),
  );
  const headers = createSourceFetcher({
    timeoutMs: 10,
    lookup: async () => PUBLIC,
    requestImpl: () => {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = () => {};
      return req;
    },
  });
  await assert.rejects(
    () => headers.fetchSourcePage("https://example.com/"),
    errorIs("source_timeout"),
  );
  const body = fixture(
    { "https://example.com/": { stream: new Readable({ read() {} }) } },
    { timeoutMs: 10 },
  );
  await assert.rejects(
    () => body.fetchSourcePage("https://example.com/"),
    errorIs("source_timeout"),
  );
});

test("malformed near-limit HTML is scanned without running code or unbounded tag matching", async () => {
  const source = fixture({
    "https://example.com/": { body: "<script ".repeat(120000) },
  });
  const result = await source.fetchSourcePage("https://example.com/");
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.links, []);
  assert.ok(result.text.length <= LIMITS.textChars);
});

test("DNS and TLS failures expose no upstream diagnostic data", async () => {
  const brokenDNS = fixture(
    {},
    {
      lookup: async () => {
        throw new Error("PRIVATE_DNS");
      },
    },
  );
  await assert.rejects(
    () => brokenDNS.fetchSourcePage("https://example.com/"),
    (error) =>
      error.code === "source_unavailable" && !error.message.includes("PRIVATE"),
  );
  const brokenTLS = createSourceFetcher({
    lookup: async () => PUBLIC,
    requestImpl: () => {
      const req = new EventEmitter();
      req.end = () =>
        queueMicrotask(() => req.emit("error", new Error("PRIVATE_TLS")));
      req.destroy = () => {};
      return req;
    },
  });
  await assert.rejects(
    () => brokenTLS.fetchSourceImage("https://example.com/image.png"),
    (error) =>
      error.code === "source_unavailable" && !error.message.includes("PRIVATE"),
  );
});

test("includes observed ordinary and lazy product images after metadata, excluding tiny pixels and SVGs", async () => {
  const source = fixture({
    "https://example.com/item": {
      body: `<img src='/item-front.png' alt='Water &amp; ice'><img src='data:image/png;base64,abc' data-src='https://cdn.example.com/item-side.jpg' alt='Water side'><img src='/pixel.png' width='1' height='1'><img src='/logo.svg'><meta property='og:image' content='/main.png'>`,
    },
  });
  const result = await source.fetchSourcePage("https://example.com/item");
  assert.deepEqual(result.images, [
    { url: "https://example.com/main.png", source: "og:image" },
    {
      url: "https://example.com/item-front.png",
      source: "img",
      name: "Water & ice",
    },
    {
      url: "https://cdn.example.com/item-side.jpg",
      source: "img",
      name: "Water side",
    },
  ]);
});
