const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server.js");
const { MemoryRepository } = require("../lib/repository.cjs");
const { createAuthService } = require("../lib/auth.cjs");

const owner = {
  uid: "owner",
  email: "owner@example.com",
  email_verified: true,
  firebase: { sign_in_provider: "google.com" },
};
const customer = {
  uid: "customer",
  email: "customer@example.com",
  email_verified: true,
  firebase: { sign_in_provider: "password" },
};
async function fixture(t) {
  const repo = new MemoryRepository({
    users: [
      {
        id: "owner",
        uid: "owner",
        role: "master",
        active: true,
        email: owner.email,
      },
      {
        id: "customer",
        uid: "customer",
        role: "customer",
        active: true,
        email: customer.email,
        storeIds: ["one"],
      },
    ],
    stores: [
      { id: "one", name: "One" },
      { id: "two", name: "Two" },
    ],
    orders: [
      { id: "o1", storeId: "one", createdAt: 2 },
      { id: "o2", storeId: "two", createdAt: 3 },
    ],
  });
  const tokens = {
    owner,
    customer,
    anonymous: { uid: "anon", firebase: { sign_in_provider: "anonymous" } },
    imposter: {
      uid: "fake",
      email: owner.email,
      email_verified: true,
      firebase: { sign_in_provider: "password" },
    },
  };
  const auth = createAuthService({
    repo,
    ownerEmail: owner.email,
    verifyIdToken: async (token) => {
      if (!tokens[token]) throw Error("bad token");
      return tokens[token];
    },
    verifyAppCheckToken: async (token) => {
      if (token !== "valid") throw Error("bad app check");
    },
    requireAppCheck: true,
  });
  const app = createApp({
    repo,
    auth,
    config: {
      firebaseConfig: { projectId: "test" },
      recaptchaSiteKey: "public",
    },
    assistant: async () => ({ lines: [], ambiguities: [] }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (route, token = "owner", body, method) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "X-Firebase-AppCheck": "valid",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.text(), headers: r.headers };
  };
  return { repo, auth, request };
}
test("public health works while private source paths cannot be downloaded", async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request("/healthz", null)).status, 200);
  for (const p of [
    "/server.js",
    "/package.json",
    "/alabama-wholesale-v9.html",
    "/.env",
    "/lib/auth.cjs",
  ])
    assert.equal((await request(p, null)).status, 404);
});
test("API rejects missing, invalid, and anonymous identities", async (t) => {
  const { request } = await fixture(t);
  for (const token of [null, "bad", "anonymous"])
    assert.equal((await request("/api/state", token)).status, 401);
});
test("state and history are scoped to authorized stores", async (t) => {
  const { request } = await fixture(t);
  const r = await request("/api/state", "customer");
  assert.equal(r.status, 200, r.body);
  const state = JSON.parse(r.body);
  assert.deepEqual(
    state.stores.map((x) => x.id),
    ["one"],
  );
  assert.deepEqual(
    state.orders.map((x) => x.id),
    ["o1"],
  );
  assert.deepEqual(state.users, []);
  assert.equal(
    (await request("/api/orders?storeId=two", "customer")).status,
    403,
  );
});
test("owner bootstrap requires configured verified Google identity", async (t) => {
  const { repo, auth } = await fixture(t);
  await repo.transaction((tx) => tx.delete("users", "owner"));
  assert.equal((await auth.bootstrap(owner)).me.role, "master");
  assert.equal(
    (
      await auth.bootstrap({
        ...owner,
        uid: "password",
        firebase: { sign_in_provider: "password" },
      })
    ).enrollmentRequired,
    true,
  );
  assert.equal(
    (
      await auth.bootstrap({
        ...owner,
        uid: "unverified",
        email_verified: false,
      })
    ).enrollmentRequired,
    true,
  );
});
test("App Check is verified and revoked profiles are denied", async (t) => {
  const { auth, repo } = await fixture(t);
  await assert.rejects(
    () =>
      auth.authenticate({
        headers: {
          authorization: "Bearer owner",
          "x-firebase-appcheck": "bad",
        },
      }),
    (e) => e.status === 401,
  );
  await repo.transaction((tx) =>
    tx.set("users", "customer", {
      id: "customer",
      uid: "customer",
      active: false,
      role: "customer",
    }),
  );
  await assert.rejects(
    () => auth.actor(customer),
    (e) => e.status === 403,
  );
});
test("invitations bind verified email, role and stores and cannot be reused", async (t) => {
  const { auth } = await fixture(t);
  const invitation = await auth.invite(
    { ...owner, role: "master" },
    { email: customer.email, role: "customer", storeIds: ["one"] },
  );
  await assert.rejects(
    () =>
      auth.accept(
        { ...customer, email: "someone@example.com" },
        invitation.token,
      ),
    (e) => e.status === 403,
  );
  const profile = await auth.accept(customer, invitation.token);
  assert.equal(profile.role, "customer");
  assert.deepEqual(profile.storeIds, ["one"]);
  await assert.rejects(
    () => auth.accept(customer, invitation.token),
    (e) => e.status === 409,
  );
});
test("expired invitations and customer invitation creation are rejected", async (t) => {
  const { auth, repo } = await fixture(t);
  await assert.rejects(
    () =>
      auth.invite(
        { ...customer, role: "customer" },
        { email: "x@example.com", role: "master" },
      ),
    (e) => e.status === 403,
  );
  const invitation = await auth.invite(
    { ...owner, role: "master" },
    { email: "x@example.com", role: "salesman", storeIds: ["one"] },
  );
  await repo.transaction(async (tx) => {
    const invites = await tx.list("invites");
    await tx.set("invites", invites[0].id, { ...invites[0], expiresAt: 0 });
  });
  await assert.rejects(
    () =>
      auth.accept({ ...customer, email: "x@example.com" }, invitation.token),
    (e) => e.status === 410,
  );
});
test("customer cannot create an admin or execute server-owned backup actions", async (t) => {
  const { request } = await fixture(t);
  assert.equal(
    (
      await request("/api/invites", "customer", {
        email: "x@example.com",
        role: "master",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/admin/backup", "customer")).status, 403);
});
test("deleted history stays archived but never appears as an active order", async (t) => {
  const { request, repo } = await fixture(t);
  await repo.put("orders", "deleted", {
    id: "deleted",
    storeId: "one",
    createdAt: 99,
    deleted: true,
  });
  const r = await request("/api/orders", "customer");
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(
    JSON.parse(r.body).orders.map((x) => x.id),
    ["o1"],
  );
  assert.equal((await repo.get("orders", "deleted")).deleted, true);
});
test("backup includes idempotency and enrollment records and restore verifies an isolated copy", async (t) => {
  const { request, repo } = await fixture(t);
  await repo.put("commandReceipts", "receipt", {
    id: "receipt",
    result: { id: "o1" },
  });
  const r = await request("/api/admin/backup");
  const backup = JSON.parse(r.body);
  assert.equal(backup.collections.commandReceipts.length, 1);
  assert.equal(backup.collections.users.length, 2);
  const preview = await request("/api/admin/restore", "owner", {
    backup,
    dryRun: true,
  });
  assert.equal(preview.status, 200, preview.body);
  const backupId = JSON.parse(preview.body).backupId;
  const restored = await request("/api/admin/restore", "owner", {
    backup,
    dryRun: false,
    backupId,
  });
  assert.equal(restored.status, 200, restored.body);
  assert.equal(JSON.parse(restored.body).verified, true);
  assert.equal((await repo.list("orders")).length, 2);
  backup.collections.orders[0].totalCents = 123;
  assert.equal(
    (await request("/api/admin/restore", "owner", { backup, dryRun: true }))
      .status,
    400,
  );
});
test("documents enforce store permissions before invoking the PDF generator", async (t) => {
  const { request } = await fixture(t);
  assert.equal(
    (await request("/api/documents/o2/invoice", "customer")).status,
    403,
  );
});
test("linked legacy profiles cannot be claimed by a different Firebase account", async (t) => {
  const { auth, repo } = await fixture(t);
  await repo.put("legacyProfiles", "legacy", {
    id: "legacy",
    uid: "someone",
    salesmanInfo: { phone: "555-0100" },
  });
  const invitation = await auth.invite(
    { ...owner, role: "master" },
    {
      email: customer.email,
      role: "salesman",
      storeIds: ["one"],
      legacyProfileId: "legacy",
    },
  );
  await assert.rejects(
    () => auth.accept(customer, invitation.token),
    (e) => e.code === "profile_already_claimed",
  );
});
test("unresolved migrated balances are displayed as unknown", async (t) => {
  const { request, repo } = await fixture(t);
  await repo.put("stores", "one", {
    id: "one",
    name: "One",
    migrationBlocked: true,
  });
  const r = await request("/api/state", "customer");
  assert.equal(JSON.parse(r.body).stores[0].balanceCents, null);
});
test("a newer invitation invalidates an unused older administrator invitation", async (t) => {
  const { auth } = await fixture(t);
  const admin = { ...owner, role: "master" };
  const older = await auth.invite(admin, {
    email: customer.email,
    role: "master",
    storeIds: [],
  });
  const newer = await auth.invite(admin, {
    email: customer.email,
    role: "customer",
    storeIds: ["one"],
  });
  await auth.accept(customer, newer.token);
  await assert.rejects(
    () => auth.accept(customer, older.token),
    (e) => e.code === "invitation_replaced",
  );
  assert.equal((await auth.actor(customer)).role, "customer");
});
test("access changes invalidate outstanding links and disabling an account takes effect immediately", async (t) => {
  const { auth, request } = await fixture(t);
  const invitation = await auth.invite(
    { ...owner, role: "master" },
    { email: customer.email, role: "master" },
  );
  const updated = await request("/api/users/customer/access", "owner", {
    role: "customer",
    storeIds: ["one"],
    active: false,
    expectedVersion: 1,
  });
  assert.equal(updated.status, 200, updated.body);
  assert.equal((await request("/api/state", "customer")).status, 403);
  await assert.rejects(
    () => auth.accept(customer, invitation.token),
    (e) => e.code === "invitation_replaced",
  );
  assert.equal(
    (
      await request("/api/users/owner/access", "owner", {
        role: "customer",
        storeIds: ["one"],
        active: false,
        expectedVersion: 1,
      })
    ).status,
    403,
  );
});
test("backup reads a consistent repository snapshot instead of unrelated collection reads", async (t) => {
  const { request, repo } = await fixture(t);
  const originalSnapshot = repo.snapshot.bind(repo);
  let snapshots = 0;
  repo.snapshot = async (collections) => {
    snapshots++;
    return originalSnapshot(collections);
  };
  repo.list = async () => {
    throw Error("Nontransactional backup read");
  };
  const r = await request("/api/admin/backup");
  assert.equal(r.status, 200, r.body);
  assert.equal(snapshots, 1);
});
test("history pagination with equal dates and mixed-case IDs never duplicates or skips records", async (t) => {
  const { request, repo } = await fixture(t);
  await repo.transaction(async (tx) => {
    for (const row of await tx.list("orders"))
      await tx.delete("orders", row.id);
    for (const prefix of ["a", "B"])
      for (let i = 0; i < 30; i++) {
        const id = prefix + String(i).padStart(2, "0");
        await tx.set("orders", id, { id, storeId: "one", createdAt: 100 });
      }
  });
  const first = JSON.parse((await request("/api/orders", "customer")).body);
  assert.equal(first.orders.length, 50);
  const second = JSON.parse(
    (await request(`/api/orders?cursor=${first.nextCursor}`, "customer")).body,
  );
  assert.equal(second.orders.length, 10);
  assert.equal(
    new Set([...first.orders, ...second.orders].map((x) => x.id)).size,
    60,
  );
  assert.equal(second.nextCursor, null);
});
