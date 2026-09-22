const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  MemoryRepository,
  FirestoreRepository,
} = require("../lib/repository.cjs");
const { executeCommand, inventoryId } = require("../lib/domain.cjs");
const actor = { uid: "owner", role: "master", storeIds: [] };
function fixture({
  count = 1200,
  product = {},
  distinct = false,
  note = "",
} = {}) {
  const products = Array.from({ length: distinct ? count : 1 }, (_, i) => ({
    id: "p" + i,
    name: "Drink",
    priceCents: 100,
    variants: [],
    packSize: 12,
    taxable: false,
    version: 1,
    ...product,
  }));
  const lines = Array.from({ length: count }, (_, i) => ({
    id: "line-" + i,
    productId: "p" + (distinct ? i : 0),
    variant: "",
    quantity: 1,
    unit: "each",
    note,
  }));
  const repo = new MemoryRepository({
    stores: [{ id: "s1", name: "Shop", version: 1 }],
    products,
    inventory: products.map((p) => ({
      id: inventoryId(p.id, ""),
      productId: p.id,
      variant: "",
      onHand: count + 10,
      reserved: 0,
      version: 1,
    })),
  });
  const run = (type, payload, id = randomUUID()) =>
    repo.transaction((tx) =>
      executeCommand(tx, actor, { id, type, payload }, { now: 1790000000000 }),
    );
  return { repo, lines, run };
}

test("large orders submit and return every line with one idempotent invoice charge", async () => {
  const f = fixture({ count: 1101, distinct: true });
  let order = await f.run("order.save", {
    id: "large",
    storeId: "s1",
    lines: f.lines,
  });
  const payload = { id: order.id, expectedVersion: order.version };
  order = await f.run("order.submit", payload, "submit-large");
  assert.equal(order.lines.length, 1101);
  assert.equal(order.totalCents, 110100);
  assert.deepEqual(await f.run("order.submit", payload, "submit-large"), order);
  assert.equal((await f.repo.list("ledger")).length, 1);
  assert.ok(
    (await f.repo.list("inventory")).every((row) => row.reserved === 1),
  );
  for (const status of ["approved", "picking", "delivered"])
    order = await f.run("order.transition", {
      id: order.id,
      expectedVersion: order.version,
      status,
    });
  const returned = await f.run("return.create", {
    orderId: order.id,
    lines: order.lines.map((line) => ({ lineId: line.id, quantity: 1 })),
    reason: "Entire delivery returned",
  });
  assert.equal(returned.lines.length, order.lines.length);
  const credited = await f.run("return.approve", {
    returnId: returned.id,
    expectedVersion: returned.version,
    restock: true,
  });
  assert.equal(credited.totalCents, order.totalCents);
  assert.ok(
    (await f.repo.list("inventory")).every(
      (row) => row.onHand === 1111 && row.reserved === 0,
    ),
  );
});

test("draft validation loads each distinct product once regardless of line count", async () => {
  const f = fixture();
  let productReads = 0;
  await f.repo.transaction((tx) =>
    executeCommand(
      {
        ...tx,
        get: (collection, id) => {
          if (collection === "products") productReads++;
          return tx.get(collection, id);
        },
      },
      actor,
      {
        id: "save-many",
        type: "order.save",
        payload: { id: "large", storeId: "s1", lines: f.lines },
      },
    ),
  );
  assert.equal(productReads, 1);
  assert.deepEqual((await f.repo.get("orders", "large")).lines, f.lines);
});

test("a snapshot that exceeds document byte capacity leaves the entire draft and finances unchanged", async () => {
  const f = fixture({
    count: 1200,
    note: "n".repeat(150),
    product: {
      name: "N".repeat(300),
      sku: "S".repeat(200),
      barcode: "B".repeat(200),
    },
  });
  const draft = await f.run("order.save", {
    id: "large",
    storeId: "s1",
    lines: f.lines,
  });
  await assert.rejects(
    () =>
      f.run("order.submit", { id: draft.id, expectedVersion: draft.version }),
    (error) =>
      error.status === 413 &&
      /byte|size|capacity/i.test(error.message) &&
      /preserv|unchanged/i.test(error.message),
  );
  assert.deepEqual(await f.repo.get("orders", draft.id), draft);
  assert.equal((await f.repo.list("ledger")).length, 0);
  assert.equal((await f.repo.list("counters")).length, 0);
  assert.equal((await f.repo.list("inventory"))[0].reserved, 0);
});

test("an oversized receipt prevents every staged write from committing", async () => {
  const repo = new MemoryRepository();
  await assert.rejects(
    () =>
      repo.transaction(async (tx) => {
        await tx.set("ledger", "charge", { deltaCents: 100 });
        await tx.set("commandReceipts", "receipt", {
          result: { notes: "x".repeat(1024 * 1024) },
        });
      }),
    (error) => error.status === 413 && error.code === "document_too_large",
  );
  assert.equal((await repo.list("ledger")).length, 0);
  assert.equal((await repo.list("commandReceipts")).length, 0);
});

test("record capacity counts UTF-8 bytes instead of JavaScript character count", async () => {
  const repo = new MemoryRepository();
  await assert.rejects(
    () => repo.put("orders", "unicode", { notes: "😀".repeat(270000) }),
    (error) => error.code === "document_too_large",
  );
  assert.equal(await repo.get("orders", "unicode"), null);
});

test("transaction byte capacity is enforced even when each individual document fits", async () => {
  const repo = new MemoryRepository();
  await assert.rejects(
    () =>
      repo.transaction(async (tx) => {
        for (let i = 0; i < 12; i++)
          await tx.set("orders", "o" + i, { notes: "x".repeat(900000) });
      }),
    (error) => error.status === 413 && error.code === "transaction_too_large",
  );
  assert.equal((await repo.list("orders")).length, 0);
});

test("Firestore stages more than 450 small writes atomically instead of imposing a line count limit", async () => {
  const applied = [];
  const db = {
    projectId: "test",
    databaseId: "(default)",
    collection: (path) => ({ doc: (id) => ({ path: path + "/" + id }) }),
    runTransaction: async (fn) => {
      const staged = [];
      const result = await fn({
        set: (ref, data) => staged.push([ref.path, data]),
        delete: (ref) => staged.push([ref.path, null]),
      });
      applied.push(...staged);
      return result;
    },
  };
  const repo = new FirestoreRepository(db);
  await repo.transaction(async (tx) => {
    for (let i = 0; i < 1101; i++)
      await tx.set("inventory", "i" + i, { reserved: 1 });
  });
  assert.equal(applied.length, 1101);
  applied.length = 0;
  await assert.rejects(
    () =>
      repo.transaction(async (tx) => {
        await tx.set("inventory", "first", { reserved: 10 });
        await tx.set("orders", "large", { notes: "x".repeat(1024 * 1024) });
      }),
    (error) => error.code === "document_too_large",
  );
  assert.equal(applied.length, 0);
});

test("explicit backend size and index-capacity rejections are actionable without treating uncertain failures as rejected writes", async () => {
  for (const [code, message] of [
    [3, "Transaction too big. Decrease transaction size."],
    [9, "Too many index entries for document."],
    [11, "Request size exceeds the maximum allowed size."],
  ]) {
    const backend = Object.assign(new Error(message), { code });
    const repo = new FirestoreRepository({
      runTransaction: async () => {
        throw backend;
      },
    });
    await assert.rejects(
      () => repo.transaction(async () => {}),
      (error) =>
        error.status === 413 &&
        error.code === "storage_capacity_exceeded" &&
        /preserved/.test(error.message),
    );
  }
  for (const [code, message] of [
    [14, "Network unavailable after sending request."],
    [4, "Transaction deadline exceeded."],
    [8, "Quota exceeded."],
    [8, "Received message larger than max."],
    [3, "Invalid document path."],
    [9, "The query requires an index."],
  ]) {
    const backend = Object.assign(new Error(message), { code });
    const repo = new FirestoreRepository({
      runTransaction: async () => {
        throw backend;
      },
    });
    await assert.rejects(
      () => repo.transaction(async () => {}),
      (error) => error === backend,
    );
  }
});
