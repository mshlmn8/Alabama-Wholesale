const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const {
  initializeTestEnvironment,
  assertFails,
} = require("@firebase/rules-unit-testing");
const { doc, getDoc, setDoc } = require("firebase/firestore");
const { Firestore } = require("@google-cloud/firestore");
const { FirestoreRepository } = require("../lib/repository.cjs");
const { executeCommand, inventoryId } = require("../lib/domain.cjs");
const projectId = "demo-alabama-wholesale";
let environment, db, repo;
test.before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8086,
    },
  });
  db = new Firestore({ projectId, host: "127.0.0.1:8086", ssl: false });
  repo = new FirestoreRepository(db);
});
test.after(async () => {
  await db.terminate();
  await environment.cleanup();
});
test("browser users including forged admin claims cannot read or write legacy, roles, orders, archives", async () => {
  for (const client of [
    environment.unauthenticatedContext(),
    environment.authenticatedContext("anon", {
      firebase: { sign_in_provider: "anonymous" },
    }),
    environment.authenticatedContext("owner", { role: "master", admin: true }),
  ]) {
    for (const resource of [
      "state/data",
      "state/users",
      "v2_users/owner",
      "v2_orders/order",
      "privateArchives/one",
    ]) {
      const ref = doc(client.firestore(), `apps/alabama-wholesale/${resource}`);
      await assertFails(getDoc(ref));
      await assertFails(setDoc(ref, { hacked: true }));
    }
  }
});
test("Firestore retries serialize concurrent submission and prevent overselling", async () => {
  await environment.clearFirestore();
  await repo.put("stores", "s1", {
    id: "s1",
    name: "Test store",
    version: 1,
    taxRateBps: 0,
    creditLimitCents: null,
  });
  await repo.put("products", "p1", {
    id: "p1",
    name: "Test product",
    variants: [],
    priceCents: 100,
    packSize: 12,
    version: 1,
    taxable: false,
  });
  await repo.put("inventory", inventoryId("p1", ""), {
    id: inventoryId("p1", ""),
    productId: "p1",
    variant: "",
    onHand: 5,
    reserved: 0,
    reorderPoint: 1,
    version: 1,
  });
  const actor = { uid: "tester", role: "master", storeIds: [] };
  const run = (type, payload, id = randomUUID()) =>
    repo.transaction((tx) =>
      executeCommand(
        tx,
        actor,
        { id, type, payload },
        { now: Date.now(), id: randomUUID },
      ),
    );
  await Promise.all(
    ["o1", "o2"].map((id) =>
      run("order.save", {
        id,
        storeId: "s1",
        lines: [
          {
            id: "line1",
            productId: "p1",
            variant: "",
            quantity: 4,
            unit: "each",
            note: "",
          },
        ],
      }),
    ),
  );
  const results = await Promise.allSettled(
    ["o1", "o2"].map((id) => run("order.submit", { id, expectedVersion: 1 })),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) => r.status === "rejected" && r.reason.code === "INSUFFICIENT_STOCK",
    ).length,
    1,
  );
  assert.equal(
    (await repo.get("inventory", inventoryId("p1", ""))).reserved,
    4,
  );
  assert.equal((await repo.list("ledger")).length, 1);
  const saved = (await repo.list("orders")).find(
    (o) => o.status === "submitted",
  );
  const payload = { id: saved.id, expectedVersion: saved.version };
  const same = await Promise.all([
    run("order.submit", payload, "same-command"),
    run("order.submit", payload, "same-command"),
  ]);
  assert.deepEqual(same[0], same[1]);
  assert.equal((await repo.list("ledger")).length, 1);
});
test("private archive retains all state fields, verifies bytes and stays under document size limits", async () => {
  const snapshot = {
    state: {
      data: { value: { payload: "x".repeat(1200000) } },
      users: { value: [] },
      drafts: [],
      other: { logo: { value: "preserved" } },
    },
    history: [],
  };
  const archive = await repo.archiveSnapshot(snapshot, "synthetic-archive");
  const ref = db.doc(`apps/alabama-wholesale/privateArchives/${archive}`);
  const manifest = (await ref.get()).data();
  assert.equal(manifest.verified, true);
  assert.equal(manifest.complete, true);
  assert.ok(manifest.chunks > 1);
  const chunks = await ref.collection("chunks").orderBy("__name__").get();
  const restored = JSON.parse(
    Buffer.concat(
      chunks.docs.map((d) => Buffer.from(d.data().base64, "base64")),
    ).toString(),
  );
  assert.deepEqual(restored, snapshot);
});
