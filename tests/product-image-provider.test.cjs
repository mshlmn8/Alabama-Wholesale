"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createProductImageProvider,
} = require("../lib/product-image-provider.cjs");
const photo = {
  url: "https://cdn.example.com/water.png",
  mimeType: "image/png",
  data: "TEST_IMAGE_BYTES",
};
const page = {
  url: "https://maker.example.com/water",
  title: "Brand Water",
  text: "Brand Water, still and sparkling",
  links: [],
  images: [{ url: photo.url, name: "Brand Water", source: "json-ld" }],
};
const product = {
  name: "Brand Water",
  sku: "BW",
  barcode: "012345",
  variants: ["Still", "Sparkling"],
  privateCost: "PRIVATE_COST",
  priceCents: 300,
  image: "PRIVATE_IMAGE",
  customerId: "PRIVATE_CUSTOMER",
};
const response = (value, overrides = {}) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(value) }] },
        },
      ],
      ...overrides,
    }),
  );
const verdict = {
  matches: true,
  confidence: 0.99,
  reason: "The pictured brand and product match.",
};
const fixture = (options = {}) =>
  createProductImageProvider({
    apiKey: "TEST_SERVER_KEY",
    sourcePage: async () => page,
    sourceImage: async () => photo,
    fetchImpl: async () => response(verdict),
    ...options,
  });

test("checks an observed real image against product identity without sending private catalog fields", async () => {
  const requests = [];
  const provider = fixture({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(verdict);
    },
  });
  const result = await provider(product, { sourcePage: page.url });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].options.headers["x-goog-api-key"],
    "TEST_SERVER_KEY",
  );
  assert.equal(
    requests[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.tools, undefined);
  assert.match(body.systemInstruction.parts[0].text, /untrusted/);
  assert.deepEqual(body.contents[0].parts[1].inlineData, {
    mimeType: photo.mimeType,
    data: photo.data,
  });
  assert.equal(requests[0].options.body.includes("PRIVATE_"), false);
  assert.equal(requests[0].options.body.includes("priceCents"), false);
  assert.equal(result.sourcePage, page.url);
  assert.equal(result.sourceImage, photo.url);
  assert.equal(result.confidence, 0.99);
  assert.deepEqual(result.image, {
    mimeType: photo.mimeType,
    data: photo.data,
  });
});

test("suggested pages become evidence only after independent page and image fetches", async () => {
  const events = [];
  let asks = 0;
  const provider = fixture({
    fetchImpl: async () => {
      events.push("gemini");
      return response(
        asks++
          ? verdict
          : { sourcePages: [page.url], note: "Verify this source." },
      );
    },
    sourcePage: async (url) => {
      assert.equal(url, page.url);
      events.push("page");
      return page;
    },
    sourceImage: async (url) => {
      assert.equal(url, photo.url);
      events.push("image");
      return photo;
    },
  });
  assert.ok((await provider(product)).image);
  assert.deepEqual(events, ["gemini", "page", "image", "gemini"]);
});

test("unsafe or inaccessible suggested sources are held for review with no image fetch", async () => {
  const provider = fixture({
    fetchImpl: async () =>
      response({
        sourcePages: ["https://127.0.0.1/private"],
        note: "Source uncertain.",
      }),
    sourcePage: async () => {
      throw Object.assign(new Error("Unsafe source"), {
        code: "unsafe_source_url",
      });
    },
    sourceImage: async () => {
      assert.fail("Unverified page triggered image fetch");
    },
  });
  assert.equal((await provider(product)).review, true);
});

test("follows only observed relevant source-page links and bounds discovery", async () => {
  const pages = [];
  const provider = fixture({
    sourcePage: async (url) => {
      pages.push(url);
      return {
        ...page,
        url,
        images: [],
        links: [
          { url: `${url}/water`, text: "Brand Water" },
          { url: `${url}/unrelated`, text: "News" },
        ],
      };
    },
  });
  const result = await provider(product, { sourcePage: page.url });
  assert.equal(result.review, true);
  assert.equal(pages.length, 4);
  assert.ok(pages.every((url) => !url.includes("unrelated")));
});

test("ambiguous, mismatched and nonnumeric confidence results never become product photos", async () => {
  for (const value of [
    { matches: false, confidence: 1 },
    { matches: true, confidence: 0.96 },
    { matches: "true", confidence: 0.99 },
    { matches: true, confidence: "0.99" },
    { matches: true, confidence: 1.01 },
    {},
  ]) {
    const provider = fixture({ fetchImpl: async () => response(value) });
    const result = await provider(product, { sourcePage: page.url });
    assert.equal(result.review, true);
    assert.equal(result.image, undefined);
  }
});

test("does not trust safety-blocked, truncated or tool-bearing provider responses even with matching JSON", async () => {
  const text = JSON.stringify(verdict);
  const cases = [
    {
      promptFeedback: { blockReason: "SAFETY" },
      candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
    },
    {
      candidates: [{ finishReason: "SAFETY", content: { parts: [{ text }] } }],
    },
    {
      candidates: [
        { finishReason: "MAX_TOKENS", content: { parts: [{ text }] } },
      ],
    },
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ text }, { functionCall: { name: "updateProduct" } }],
          },
        },
      ],
    },
    {
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text }] } },
        { finishReason: "STOP", content: { parts: [{ text }] } },
      ],
    },
  ];
  for (const value of cases) {
    const provider = fixture({
      fetchImpl: async () => new Response(JSON.stringify(value)),
    });
    await assert.rejects(
      () => provider(product, { sourcePage: page.url }),
      (error) => ["invalid_response", "provider_blocked"].includes(error.code),
    );
  }
});

test("provider quota and upstream errors are sanitized", async () => {
  for (const [status, code] of [
    [429, "provider_busy"],
    [500, "provider_unavailable"],
    [403, "provider_unavailable"],
  ]) {
    const provider = fixture({
      fetchImpl: async () =>
        new Response("PRIVATE_PROVIDER_DIAGNOSTIC", { status }),
    });
    await assert.rejects(
      () => provider(product, { sourcePage: page.url }),
      (error) => error.code === code && !error.message.includes("PRIVATE"),
    );
  }
});

test("bounds provider output and rejects malformed JSON", async () => {
  for (const value of ["not JSON", "x".repeat(96001)]) {
    const provider = fixture({ fetchImpl: async () => new Response(value) });
    await assert.rejects(
      () => provider(product, { sourcePage: page.url }),
      (error) => error.code === "invalid_response",
    );
  }
});

test("checks real existing library photos before any external lookup", async () => {
  let calls = 0;
  const provider = createProductImageProvider({
    apiKey: "private",
    library: async () => [{ page, image: photo }],
    fetchImpl: async () => {
      calls++;
      return response(verdict);
    },
    sourcePage: async () => {
      throw Error("unnecessary network");
    },
  });
  const result = await provider(product);
  assert.equal(result.image.data, photo.data);
  assert.equal(calls, 1);
});
test("does not use an unlisted Kids or PM version despite a confident brand match", async () => {
  for (const reason of [
    "The photo shows Brand Water for Kids.",
    "The photo shows Brand Water PM.",
  ]) {
    const provider = createProductImageProvider({
      apiKey: "private",
      sourcePage: async () => page,
      sourceImage: async () => photo,
      fetchImpl: async () => response({ ...verdict, reason }),
    });
    const result = await provider(product, { sourcePage: page.url });
    assert.equal(result.review, true);
    assert.equal(result.image, undefined);
  }
});
