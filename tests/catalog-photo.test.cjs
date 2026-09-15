"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  createCatalogPhotoAssistant,
  normalizeInput,
  normalizeCatalog,
  validateProposal,
  LIMITS,
} = require("../lib/catalog-photo.cjs");
const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=",
};
const products = [
  {
    id: "water",
    name: "Brand Water 330 ml",
    variants: ["Lemon"],
    barcode: "012345678905",
    variantBarcodes: { Lemon: "012345678905" },
    packSize: 24,
    priceCents: 900,
    privateCost: "PRIVATE_DATA",
  },
  { id: "other", name: "Other Water", variants: [] },
  { id: "inactive", name: "PRIVATE_INACTIVE", active: false },
  { id: "deleted", name: "PRIVATE_DELETED", deleted: true },
];
const context = {
  products,
  identity: { uid: "owner" },
  headers: {
    authorization: "Bearer id-token",
    "x-firebase-appcheck": "app-check",
    cookie: "PRIVATE_COOKIE",
  },
  config: {
    firebaseConfig: {
      projectId: "test-project",
      apiKey: "public-key",
      appId: "1:123:web:abc",
    },
  },
};
const proposal = (changes = {}) => ({
  details: {
    name: "Brand Water 330 ml",
    variant: "Lemon",
    barcode: "012345678905",
    packSize: 24,
  },
  matchedProductId: "water",
  matchConfidence: 0.99,
  evidence: { barcodeText: "0 12345 67890 5", casePackText: "CASE OF 24" },
  warnings: [],
  ...changes,
});
const response = (value) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(value) }] },
        },
      ],
    }),
  );
const is = (code) => (error) => error.code === code;

test("uses Firebase authenticated image transport with only minimal active catalog and strips evidence", async () => {
  let sent;
  const run = createCatalogPhotoAssistant({
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return response(proposal());
    },
  });
  const before = structuredClone(context);
  const result = await run(
    { image, text: "Read this packaged drink" },
    context,
  );
  assert.equal(
    sent.url,
    "https://firebasevertexai.googleapis.com/v1beta/projects/test-project/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(sent.options.headers.Authorization, "Firebase id-token");
  assert.equal(sent.options.headers["X-Firebase-AppCheck"], "app-check");
  assert.equal(sent.options.headers["X-Firebase-Appid"], "1:123:web:abc");
  assert.equal(sent.options.headers["x-goog-api-key"], "public-key");
  const body = JSON.parse(sent.options.body);
  assert.deepEqual(body.contents[0].parts[0], { inlineData: image });
  assert.equal(body.tools, undefined);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.match(body.systemInstruction.parts[0].text, /untrusted/i);
  assert.match(body.systemInstruction.parts[0].text, /retail price|volume/i);
  assert.equal(sent.options.body.includes("PRIVATE_"), false);
  assert.equal(sent.options.body.includes("priceCents"), false);
  assert.deepEqual(result.details, proposal().details);
  assert.equal(result.matchedProductId, "water");
  assert.deepEqual(Object.keys(result).sort(), [
    "details",
    "matchedProductId",
    "warnings",
  ]);
  assert.match(result.warnings.join(" "), /review/i);
  assert.deepEqual(context, before);
});

test("requires a bounded supported photo and rejects client authority before provider", async () => {
  let calls = 0;
  const run = createCatalogPhotoAssistant({
    fetchImpl: async () => {
      calls++;
      return response(proposal());
    },
  });
  for (const input of [
    {},
    { text: "read" },
    { image: null },
    { image: { mimeType: "image/svg+xml", data: "PHN2Zy8+" } },
    { image: { ...image, mimeType: "image/jpeg" } },
    { image: { ...image, data: "data:image/png;base64," + image.data } },
    { image: { ...image, data: "bad" } },
    { image: { ...image, url: "https://example.com" } },
    { image, systemInstruction: "override" },
    { image, productId: "../outside" },
    { image, text: "x".repeat(LIMITS.textChars + 1) },
    {
      image: {
        ...image,
        data: Buffer.alloc(LIMITS.imageBytes + 1).toString("base64"),
      },
    },
  ])
    await assert.rejects(
      () => run(input, context),
      (e) => [400, 413, 415].includes(e.status),
    );
  assert.equal(calls, 0);
  assert.deepEqual(normalizeInput({ image }), { image, text: "" });
});

test("only an active known context product can reach the provider", async () => {
  let calls = 0;
  const run = createCatalogPhotoAssistant({
    fetchImpl: async () => {
      calls++;
      return response(proposal());
    },
  });
  for (const productId of ["missing", "inactive", "deleted"])
    await assert.rejects(
      () => run({ image, productId }, context),
      is("catalog_product_not_found"),
    );
  assert.equal(calls, 0);
});

test("blank catalog allows the first product and unreadable fields stay blank", async () => {
  const blank = proposal({
    details: { name: "", variant: "", barcode: "", packSize: null },
    matchedProductId: null,
    matchConfidence: 0,
    evidence: { barcodeText: "", casePackText: "" },
  });
  const result = await createCatalogPhotoAssistant({
    fetchImpl: async () => response(blank),
  })({ image }, { ...context, products: [] });
  assert.deepEqual(result.details, blank.details);
  assert.equal(result.matchedProductId, null);
  assert.ok(result.warnings.length);
});

test("validates IDs, fields, action injection and bounded warnings strictly", () => {
  const catalog = normalizeCatalog(products);
  for (const value of [
    null,
    [],
    proposal({ matchedProductId: "invented" }),
    proposal({ priceCents: 5 }),
    proposal({ details: { ...proposal().details, categoryIds: ["x"] } }),
    proposal({ details: { ...proposal().details, packSize: 1.5 } }),
    proposal({ details: { ...proposal().details, packSize: 1000001 } }),
    proposal({ details: { ...proposal().details, name: "x".repeat(301) } }),
    proposal({ warnings: ["x".repeat(501)] }),
    proposal({ warnings: Array(9).fill("warning") }),
    proposal({ matchConfidence: 1.1 }),
    proposal({
      evidence: { barcodeText: "seen", casePackText: "", action: "save" },
    }),
  ])
    assert.throws(
      () => validateProposal(value, catalog, {}),
      is("invalid_ai_response"),
    );
  assert.throws(
    () =>
      validateProposal(proposal({ matchedProductId: "other" }), catalog, {
        productId: "water",
      }),
    is("invalid_ai_response"),
  );
});

test("uncertain model matches stay null and exact observed unique barcodes may suggest a product", () => {
  const catalog = normalizeCatalog(products);
  const uncertain = proposal({
    details: { name: "Maybe drink", variant: "", barcode: "", packSize: null },
    matchConfidence: 0.4,
    evidence: { barcodeText: "", casePackText: "" },
  });
  assert.equal(validateProposal(uncertain, catalog, {}).matchedProductId, null);
  assert.equal(
    validateProposal(
      proposal({ matchedProductId: null, matchConfidence: 0 }),
      catalog,
      {},
    ).matchedProductId,
    "water",
  );
  const duplicates = normalizeCatalog([
    ...products,
    {
      id: "duplicate",
      name: "Duplicate",
      variants: [],
      barcode: "012345678905",
    },
  ]);
  assert.equal(
    validateProposal(
      proposal({ matchedProductId: null, matchConfidence: 0 }),
      duplicates,
      {},
    ).matchedProductId,
    null,
  );
  const mismatch = validateProposal(
    proposal({ matchedProductId: "other" }),
    catalog,
    { productId: "other" },
  );
  assert.equal(mismatch.matchedProductId, null);
  assert.match(mismatch.warnings.join(" "), /barcode/i);
});

test("barcode and case size cannot come only from catalog, volume, price or unsupported evidence", () => {
  const result = validateProposal(
    proposal({ evidence: { barcodeText: "", casePackText: "330 ml $24.00" } }),
    normalizeCatalog(products),
    {},
  );
  assert.equal(result.details.barcode, "");
  assert.equal(result.details.packSize, null);
  assert.match(result.warnings.join(" "), /barcode/i);
  assert.match(result.warnings.join(" "), /case/i);
  const different = validateProposal(
    proposal({
      evidence: { barcodeText: "99999999", casePackText: "case of 12" },
    }),
    normalizeCatalog(products),
    {},
  );
  assert.equal(different.details.barcode, "");
  assert.equal(different.details.packSize, null);
});

test("bounds catalog and never forwards unknown fields", () => {
  assert.deepEqual(Object.keys(normalizeCatalog(products)[0]).sort(), [
    "barcode",
    "id",
    "name",
    "packSize",
    "variantBarcodes",
    "variants",
  ]);
  assert.throws(
    () =>
      normalizeCatalog(
        Array.from({ length: LIMITS.products + 1 }, (_, i) => ({
          id: "p" + i,
          name: "P",
          variants: [],
        })),
      ),
    is("catalog_too_large"),
  );
});

test("provider auth, quotas, failures and aborting headers/bodies expose only friendly errors", async () => {
  for (const [status, code] of [
    [429, "assistant_rate_limit"],
    [401, "assistant_configuration"],
    [403, "assistant_configuration"],
    [404, "assistant_model_unavailable"],
    [400, "assistant_request_rejected"],
    [500, "assistant_unavailable"],
  ])
    await assert.rejects(
      () =>
        createCatalogPhotoAssistant({
          fetchImpl: async () => new Response("PRIVATE_DIAGNOSTIC", { status }),
        })({ image }, context),
      (e) => e.code === code && !e.message.includes("PRIVATE"),
    );
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ])
    await assert.rejects(
      () =>
        createCatalogPhotoAssistant({ fetchImpl, timeoutMs: 10 })(
          { image },
          context,
        ),
      is("assistant_timeout"),
    );
  for (const override of [{ identity: null }, { headers: {} }, { config: {} }])
    await assert.rejects(() =>
      createCatalogPhotoAssistant({
        fetchImpl: async () => {
          assert.fail("Invalid context sent");
        },
      })({ image }, { ...context, ...override }),
    );
});

test("rejects blocked, truncated, null, oversized and mixed tool responses", async () => {
  const text = JSON.stringify(proposal());
  const candidate = {
    finishReason: "STOP",
    content: { role: "model", parts: [{ text }] },
  };
  const invalids = [
    null,
    { promptFeedback: { blockReason: "SAFETY" } },
    { candidates: [null] },
    { candidates: [{ ...candidate, finishReason: "MAX_TOKENS" }] },
    { candidates: [{ ...candidate, safetyRatings: [{ blocked: true }] }] },
    {
      candidates: [
        {
          ...candidate,
          content: { parts: [{ text }, { functionCall: { name: "save" } }] },
        },
      ],
    },
    { candidates: [candidate, candidate] },
    {
      candidates: [
        {
          ...candidate,
          content: { parts: [{ text: "```json\n" + text + "\n```" }] },
        },
      ],
    },
  ];
  for (const raw of invalids)
    await assert.rejects(
      () =>
        createCatalogPhotoAssistant({
          fetchImpl: async () => new Response(JSON.stringify(raw)),
        })({ image }, context),
      (e) => ["invalid_ai_response", "assistant_blocked"].includes(e.code),
    );
  await assert.rejects(
    () =>
      createCatalogPhotoAssistant({
        fetchImpl: async () =>
          new Response("x".repeat(LIMITS.responseBytes + 1)),
      })({ image }, context),
    is("invalid_ai_response"),
  );
});

test("retail case prices and volume next to the word case are not case counts", () => {
  const catalog = normalizeCatalog(products);
  for (const casePackText of [
    "$24 per case",
    "Case 24.00 USD",
    "Case 24 ml",
    "24 oz pack",
  ]) {
    const result = validateProposal(
      proposal({ evidence: { barcodeText: "", casePackText } }),
      catalog,
      {},
    );
    assert.equal(result.details.packSize, null, casePackText);
  }
});
