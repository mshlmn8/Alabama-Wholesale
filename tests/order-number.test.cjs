const test = require("node:test");
const assert = require("node:assert/strict");
const { executeCommand } = require("../lib/domain.cjs");
const { MemoryRepository } = require("../lib/repository.cjs");

const actor = { uid: "buyer", role: "customer", storeIds: ["s1", "s2"] };
const line = {
  id: "line",
  productId: "p",
  variant: "",
  quantity: 1,
  unit: "each",
  note: "",
};
function fixture(extra = {}) {
  const repo = new MemoryRepository({
    stores: [
      { id: "s1", name: "One" },
      { id: "s2", name: "Two" },
    ],
    products: [
      {
        id: "p",
        name: "Product",
        variants: [],
        priceCents: 100,
        taxable: false,
      },
    ],
    ...extra,
  });
  let n = 0;
  const run = (type, payload, id = `command-${++n}`, who = actor) =>
    repo.transaction((tx) =>
      executeCommand(
        tx,
        who,
        { id, type, payload },
        { now: Date.UTC(2026, 8, 22) },
      ),
    );
  const save = (id, payload = {}, commandId, who) =>
    run(
      "order.save",
      { id, storeId: "s1", lines: [line], ...payload },
      commandId,
      who,
    );
  return { repo, run, save };
}

test("new order numbering starts at one independently of old invoices and spans stores", async () => {
  const fiscal = { id: "invoices-2026", value: 41, version: 41 };
  const old = {
    id: "old",
    storeId: "s1",
    status: "submitted",
    invoiceNumber: "AW-2026-000041",
    version: 2,
    lines: [],
  };
  const f = fixture({ counters: [fiscal], orders: [old] });
  const first = await f.save("first"),
    second = await f.save("second", { storeId: "s2" });
  assert.equal(first.orderNumber, 1);
  assert.equal(second.orderNumber, 2);
  assert.deepEqual(await f.repo.get("orders", "old"), old);
  assert.deepEqual(await f.repo.get("counters", fiscal.id), fiscal);
  assert.equal((await f.repo.get("counters", "order-numbers")).value, 2);
  const submitted = await f.run("order.submit", {
    id: first.id,
    expectedVersion: first.version,
  });
  assert.equal(submitted.orderNumber, 1);
  assert.equal(submitted.invoiceNumber, "AW-2026-000042");
  assert.deepEqual(await f.repo.get("orders", "old"), old);
  assert.equal((await f.repo.get("counters", "order-numbers")).value, 2);
});

test("edits, idempotent retries and submission keep the assigned number and ignore client numbers", async () => {
  const f = fixture();
  const first = await f.save("first", { orderNumber: 999 }, "initial");
  assert.equal(first.orderNumber, 1);
  assert.deepEqual(
    await f.save("first", { orderNumber: 999 }, "initial"),
    first,
  );
  const edited = await f.save("first", {
    expectedVersion: first.version,
    orderNumber: 42,
    notes: "Edited",
  });
  assert.equal(edited.orderNumber, 1);
  const payload = {
    id: first.id,
    expectedVersion: edited.version,
    orderNumber: 800,
  };
  const submitted = await f.run("order.submit", payload, "submit");
  assert.equal(submitted.orderNumber, 1);
  assert.equal(submitted.invoiceNumber, "AW-2026-000001");
  assert.deepEqual(await f.run("order.submit", payload, "submit"), submitted);
  assert.equal((await f.repo.list("ledger")).length, 1);
  assert.equal((await f.save("second")).orderNumber, 2);
});

test("existing unnumbered drafts retain their legacy identity even if a client supplies a number", async () => {
  const old = {
    id: "old",
    storeId: "s1",
    status: "draft",
    createdBy: actor.uid,
    version: 4,
    lines: [line],
    notes: "Old",
  };
  const f = fixture({ orders: [old] });
  const edited = await f.save("old", {
    expectedVersion: 4,
    orderNumber: 1,
    notes: "Reviewed",
  });
  assert.equal(edited.orderNumber, undefined);
  const submitted = await f.run("order.submit", {
    id: old.id,
    expectedVersion: edited.version,
  });
  assert.equal(submitted.orderNumber, undefined);
  assert.equal((await f.save("new")).orderNumber, 1);
});

test("invalid and unauthorized saves do not consume numbers or create records", async () => {
  const f = fixture();
  for (const [payload, who, code] of [
    [{ notes: "x".repeat(10001) }, actor, "INVALID_INPUT"],
    [{ lines: [{ ...line, quantity: 0 }] }, actor, "INVALID_INPUT"],
    [{ lines: [{ ...line, productId: "missing" }] }, actor, "NOT_FOUND"],
    [{ storeId: "s2" }, { ...actor, storeIds: ["s1"] }, "FORBIDDEN"],
    [{ expectedVersion: 4 }, actor, "VERSION_CONFLICT"],
  ])
    await assert.rejects(() => f.save("invalid", payload, undefined, who), {
      code,
    });
  assert.equal((await f.repo.list("orders")).length, 0);
  assert.equal((await f.repo.list("counters")).length, 0);
  assert.equal((await f.save("valid")).orderNumber, 1);
});

test("a capacity failure after staging rolls back the number and successful retry starts at one", async () => {
  const f = fixture();
  const lines = Array.from({ length: 600 }, (_, index) => ({
    ...line,
    id: `line-${index}`,
    note: "x".repeat(2000),
  }));
  await assert.rejects(() => f.save("oversized", { lines }), {
    code: "document_too_large",
  });
  for (const collection of ["orders", "counters", "commandReceipts", "audit"])
    assert.deepEqual(await f.repo.list(collection), []);
  assert.equal((await f.save("oversized")).orderNumber, 1);
});

test("invalid or exhausted numbering counters fail closed without restarting the sequence", async () => {
  for (const value of [null, -1, "2", 1.5, Number.MAX_SAFE_INTEGER]) {
    const f = fixture({
      counters: [{ id: "order-numbers", value, version: 1 }],
    });
    await assert.rejects(() => f.save("new"), { code: "INVALID_INPUT" });
    assert.equal((await f.repo.list("orders")).length, 0);
    assert.equal((await f.repo.get("counters", "order-numbers")).value, value);
  }
});
