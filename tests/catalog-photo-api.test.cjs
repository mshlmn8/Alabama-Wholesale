"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const { createApp } = require("../server.js"),
  { MemoryRepository } = require("../lib/repository.cjs"),
  { createAuthService } = require("../lib/auth.cjs");
const image = {
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=",
};
const result = {
  details: { name: "Test Water", variant: "Lime", barcode: "", packSize: null },
  matchedProductId: "p",
  warnings: ["Review before saving."],
};
async function fixture(t, { provider } = {}) {
  const users = ["owner", "customer", "staff"].map((id) => ({
    id,
    uid: id,
    email: id + "@example.com",
    role: id === "owner" ? "master" : id === "staff" ? "salesman" : "customer",
    active: true,
    storeIds: ["s"],
  }));
  const repo = new MemoryRepository({
    users,
    products: [
      {
        id: "p",
        name: "Test Water",
        variants: ["Lime"],
        barcode: "12345",
        packSize: 12,
        priceCents: 123,
        privateCost: "PRIVATE_PRODUCT",
      },
      { id: "inactive", name: "Inactive", active: false },
      { id: "deleted", name: "Deleted", deleted: true },
    ],
    stores: [{ id: "s", name: "PRIVATE_STORE" }],
    orders: [{ id: "o", storeId: "s", notes: "PRIVATE_ORDER" }],
    ledger: [{ id: "l", storeId: "s", deltaCents: 500 }],
  });
  const tokens = Object.fromEntries(
    users.map((user) => [
      user.uid,
      {
        uid: user.uid,
        email: user.email,
        email_verified: true,
        firebase: { sign_in_provider: "google.com" },
      },
    ]),
  );
  const auth = createAuthService({
    repo,
    ownerEmail: "owner@example.com",
    requireAppCheck: true,
    verifyIdToken: async (token) => {
      if (!tokens[token]) throw Error("bad");
      return tokens[token];
    },
    verifyAppCheckToken: async (token) => {
      if (token !== "valid") throw Error("bad check");
    },
  });
  const calls = [],
    now = 100000;
  const app = createApp({
    repo,
    auth,
    now: () => now,
    catalogPhotoAssistant: async (input, context) => {
      calls.push({ input, context });
      return provider ? provider(input, context) : result;
    },
    assistant: async () => ({ lines: [], ambiguities: [] }),
    chatAssistant: async () => ({ text: "Hello" }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (
    body = { image },
    token = "owner",
    check = "valid",
    route = "/api/assistant/catalog-photo",
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${route}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(check ? { "X-Firebase-AppCheck": check } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return { repo, calls, request, now };
}

test("catalog photo requires authenticated App Check and master before validation, data or AI quota", async (t) => {
  const { request, calls, repo } = await fixture(t);
  assert.equal((await request({ image }, null)).status, 401);
  assert.equal((await request({ image }, "owner", null)).status, 401);
  assert.equal((await request({}, "customer")).status, 403);
  assert.equal((await request({ image }, "staff")).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await repo.list("aiLimits")).length, 0);
});

test("invalid photo and missing or inactive context never spend quota or invoke the model", async (t) => {
  const { request, calls, repo } = await fixture(t);
  for (const body of [
    {},
    { image: { mimeType: "image/jpeg", data: image.data } },
    { image, productId: "../x" },
    { image, extra: "override" },
  ])
    assert.equal((await request(body)).status, 400);
  for (const productId of ["missing", "inactive", "deleted"])
    assert.equal((await request({ image, productId })).status, 404);
  assert.equal(calls.length, 0);
  assert.equal((await repo.list("aiLimits")).length, 0);
});

test("owner photo proposes details using minimal catalog and writes only the shared AI budget", async (t) => {
  const { request, calls, repo } = await fixture(t);
  const names = [
    "products",
    "stores",
    "orders",
    "ledger",
    "inventory",
    "audit",
    "commandReceipts",
    "productImageJobs",
  ];
  const before = await Promise.all(names.map((name) => repo.list(name)));
  const response = await request({
    image,
    text: " Read package ",
    productId: "p",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, result);
  assert.deepEqual(calls[0].input, {
    image,
    text: "Read package",
    productId: "p",
  });
  assert.deepEqual(calls[0].context.products, [
    {
      id: "p",
      name: "Test Water",
      variants: ["Lime"],
      barcode: "12345",
      variantBarcodes: {},
      packSize: 12,
    },
  ]);
  assert.equal(
    JSON.stringify(calls[0].context.products).includes("PRIVATE_"),
    false,
  );
  assert.equal(calls[0].context.store, undefined);
  assert.equal(calls[0].context.identity.uid, "owner");
  assert.deepEqual(
    await Promise.all(names.map((name) => repo.list(name))),
    before,
  );
  assert.equal((await repo.list("aiLimits")).length, 2);
});

test("photo requests share the existing minute budget with order and chat assistants", async (t) => {
  const { request, calls } = await fixture(t);
  for (let i = 0; i < 9; i++)
    assert.equal(
      (
        await request(
          { text: "draft" },
          "owner",
          "valid",
          "/api/assistant/propose",
        )
      ).status,
      200,
    );
  assert.equal((await request()).status, 200);
  assert.equal(
    (await request({ text: "Hello" }, "owner", "valid", "/api/assistant/chat"))
      .status,
    429,
  );
  assert.equal((await request()).status, 429);
  assert.equal(calls.length, 1);
});

test("daily budget prevents a provider call and provider failures do not alter catalog", async (t) => {
  const limited = await fixture(t);
  const id = createHash("sha256")
    .update("owner:day:" + Math.floor(limited.now / 86400000))
    .digest("hex");
  await limited.repo.put("aiLimits", id, { id, count: 100 });
  assert.equal((await limited.request()).status, 429);
  assert.equal(limited.calls.length, 0);
  const failed = await fixture(t, {
    provider: () => {
      throw Object.assign(Error("Gemini unavailable."), {
        status: 502,
        code: "assistant_unavailable",
        expose: true,
      });
    },
  });
  const before = await failed.repo.list("products");
  const response = await failed.request();
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "assistant_unavailable");
  assert.deepEqual(await failed.repo.list("products"), before);
});
