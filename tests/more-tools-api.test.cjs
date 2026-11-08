const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server.js");
const { MemoryRepository } = require("../lib/repository.cjs");
const { createAuthService } = require("../lib/auth.cjs");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
async function fixture(t) {
  const identities = Object.fromEntries(
    ["buyer", "other"].map((uid) => [
      uid,
      {
        uid,
        email: `${uid}@example.test`,
        email_verified: true,
        firebase: { sign_in_provider: "password" },
      },
    ]),
  );
  const repo = new MemoryRepository({
    users: Object.keys(identities).map((uid) => ({
      id: uid,
      ...identities[uid],
      active: true,
      role: "customer",
      storeIds: uid === "buyer" ? ["s1"] : ["s2"],
    })),
    stores: [
      { id: "s1", name: "One" },
      { id: "s2", name: "Two" },
    ],
    returns: [
      {
        id: "r1",
        storeId: "s1",
        status: "pending",
        photos: [{ id: "r1--0", mimeType: "image/png", size: 68 }],
      },
    ],
    returnPhotos: [
      {
        id: "r1--0",
        returnId: "r1",
        storeId: "s1",
        mimeType: "image/png",
        data: png,
      },
    ],
    orderLists: [
      { id: "mine", storeId: "s1", userId: "buyer", name: "My list" },
      { id: "not-mine", storeId: "s1", userId: "other", name: "Private list" },
      { id: "removed", storeId: "s1", userId: "buyer", deleted: true },
    ],
  });
  const auth = createAuthService({
    repo,
    ownerEmail: "owner@example.test",
    verifyIdToken: async (token) => {
      if (!identities[token]) throw Error("Invalid token");
      return identities[token];
    },
    requireAppCheck: false,
  });
  const server = createApp({ repo, auth, config: {} }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    repo,
    request: (url, token = "buyer") =>
      fetch(`http://127.0.0.1:${server.address().port}${url}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
  };
}
test("delivery photos require current store authorization, a parent reference and private no-store responses", async (t) => {
  const f = await fixture(t),
    url = "/api/returns/r1/photos/r1--0";
  assert.equal((await f.request(url, null)).status, 401);
  assert.equal((await f.request(url, "other")).status, 403);
  const r = await f.request(url);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /private.*no-store/);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(
    Buffer.from(await r.arrayBuffer()),
    Buffer.from(png, "base64"),
  );
  assert.equal(
    (await f.request("/api/returns/r1/photos/unrelated")).status,
    404,
  );
  assert.equal((await f.request("/media/products/r1--0")).status, 404);
  await f.repo.put("users", "buyer", {
    id: "buyer",
    ...{
      uid: "buyer",
      email: "buyer@example.test",
      active: true,
      role: "customer",
      storeIds: [],
    },
  });
  assert.equal((await f.request(url)).status, 403);
});
test("workspace returns only this user’s active lists and never embeds delivery-photo bytes", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/state");
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(
    state.orderLists.map((row) => row.id),
    ["mine"],
  );
  assert.equal(JSON.stringify(state).includes(png), false);
  assert.equal(state.returns[0].photos[0].data, undefined);
});
