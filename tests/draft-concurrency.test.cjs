const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryRepository } = require("../lib/repository.cjs");
const { executeCommand } = require("../lib/domain.cjs");

test("100 concurrent customers save unfinished drafts without leaking edits or posting financial effects", async () => {
  const customers = Array.from({ length: 100 }, (_, index) => ({
    uid: `customer-${index}`,
    role: "customer",
    storeIds: [`store-${index}`],
  }));
  const repo = new MemoryRepository({
    stores: customers.map((actor) => ({
      id: actor.storeIds[0],
      name: actor.uid,
    })),
    products: [
      { id: "p", name: "Product", variants: ["Original"], priceCents: 250 },
    ],
    inventory: [
      {
        id: "p:Original",
        productId: "p",
        variant: "Original",
        onHand: 7,
        reserved: 0,
        version: 1,
      },
    ],
  });
  const stockBefore = await repo.list("inventory");
  let sequence = 0;
  const run = (actor, command) =>
    repo.transaction((tx) =>
      executeCommand(tx, actor, command, {
        now: 1789372800000,
        id: () => `generated-${++sequence}`,
      }),
    );
  const command = (index, notes, expectedVersion) => ({
    // Command IDs may coincide across accounts; each actor needs an independent receipt.
    id: expectedVersion ? "edit" : "initial",
    type: "order.save",
    payload: {
      id: `draft-${index}`,
      storeId: `store-${index}`,
      lines:
        index % 2
          ? [
              {
                id: "line",
                productId: "p",
                variant: "Original",
                quantity: index + 1,
                unit: "each",
                note: "",
              },
            ]
          : [],
      notes,
      ...(expectedVersion ? { expectedVersion } : {}),
    },
  });
  const initialCommands = customers.map((actor, index) =>
    command(index, `Initial ${actor.uid}`),
  );
  const initial = await Promise.all(
    customers.map((actor, index) => run(actor, initialCommands[index])),
  );
  assert.equal(initial.length, 100);
  assert.deepEqual(
    initial.map((order) => order.orderNumber).sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  const edits = customers.map((actor, index) =>
    command(index, `Edited ${actor.uid}`, 1),
  );
  const outcomes = await Promise.all(
    customers.map(async (actor, index) => {
      // A simultaneous duplicate must return its exact receipt rather than advance twice.
      const [first, replay] = await Promise.all([
        run(actor, edits[index]),
        run(actor, edits[index]),
      ]);
      assert.deepEqual(replay, first);
      return first;
    }),
  );
  const stale = await Promise.allSettled(
    customers.map((actor, index) =>
      run(actor, {
        ...command(index, "Stale replacement", 1),
        id: "stale",
      }),
    ),
  );
  assert.ok(
    stale.every(
      (result) =>
        result.status === "rejected" &&
        result.reason.code === "VERSION_CONFLICT",
    ),
  );
  const forbidden = await Promise.allSettled(
    customers.map((actor, index) =>
      run(actor, {
        ...command(
          (index + 1) % customers.length,
          "Cross-store replacement",
          2,
        ),
        id: "cross-store",
      }),
    ),
  );
  assert.ok(
    forbidden.every(
      (result) =>
        result.status === "rejected" && result.reason.code === "FORBIDDEN",
    ),
  );
  const stored = await repo.list("orders");
  assert.equal(stored.length, 100);
  for (let index = 0; index < customers.length; index++) {
    const order = stored.find((item) => item.id === `draft-${index}`);
    assert.deepEqual(order, outcomes[index]);
    assert.equal(order.version, 2);
    assert.equal(order.createdBy, customers[index].uid);
    assert.equal(order.storeId, customers[index].storeIds[0]);
    assert.equal(order.notes, `Edited ${customers[index].uid}`);
    assert.equal(order.status, "draft");
    assert.deepEqual(order.lines, edits[index].payload.lines);
    assert.equal(order.invoiceNumber, undefined);
    assert.equal(order.orderNumber, initial[index].orderNumber);
  }
  assert.equal((await repo.list("commandReceipts")).length, 200);
  assert.equal((await repo.list("audit")).length, 200);
  assert.deepEqual(await repo.list("counters"), [
    { id: "order-numbers", value: 100, version: 100 },
  ]);
  for (const collection of [
    "ledger",
    "payments",
    "returns",
    "notifications",
  ])
    assert.deepEqual(await repo.list(collection), [], collection);
  assert.deepEqual(await repo.list("inventory"), stockBefore);
});
