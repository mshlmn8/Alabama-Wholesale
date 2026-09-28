const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/order-workflow.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(
          fs.readFileSync(file, "utf8") + "\n//# sourceURL=order-workflow.js",
        ).toString("base64")
    )
  : Promise.resolve({});
const original = () => ({
  id: "order-a",
  storeId: "store-a",
  status: "draft",
  version: 2,
  notes: "Original note",
  lines: [
    {
      id: "line-a",
      productId: "juice",
      variant: "Apple",
      quantity: 3,
      unit: "each",
      note: "",
    },
  ],
});
function harness() {
  const state = {
    order: original(),
    store: { id: "store-a", name: "A" },
    generation: 1,
  };
  const commands = [];
  const ctx = {
    getStore: () => state.store,
    getDraft: () => state.order,
    scope: () => state.generation,
    isCurrent: (s) => s === state.generation,
    syncDraft: async () => ({ ...state.order, version: 3 }),
    command: async (type, payload) => {
      commands.push({ type, payload });
      return {
        id: "handoff",
        storeId: "store-a",
        orderId: "order-a",
        orderVersion: 3,
        contentHash: "hash",
        snapshot: { ...original(), version: 3 },
      };
    },
    activateDraft: (order) => {
      state.order = order;
    },
  };
  return { state, commands, ctx };
}
test("Mail handoff syncs the active draft and returns an independent frozen server snapshot", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness(),
    workflow = createOrderWorkflow(h.ctx);
  const prepared = await workflow.prepareHandoff(h.state.order);
  assert.equal(h.commands[0].type, "order.handoff");
  assert.equal(h.commands[0].payload.expectedVersion, 3);
  h.state.order.lines[0].quantity = 99;
  assert.equal(prepared.order.lines[0].quantity, 3);
  assert.equal(prepared.handoff.id, "handoff");
  assert.equal(prepared.warning, null);
  assert.equal(Object.isFrozen(prepared.order.lines[0]), true);
});
test("failed handoff preserves existing Mail content without permitting placement confirmation", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness();
  h.ctx.command = async () => {
    throw new Error("Offline");
  };
  const workflow = createOrderWorkflow(h.ctx),
    prepared = await workflow.prepareHandoff(h.state.order);
  assert.deepEqual(prepared.order, original());
  assert.equal(prepared.handoff, null);
  assert.match(prepared.warning, /Mail|placed/i);
  await assert.rejects(
    () => workflow.markPlaced(prepared),
    /handoff|recorded/i,
  );
});
test("account and store switches discard a delayed handoff instead of falling back into another context", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness();
  let finish;
  h.ctx.syncDraft = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const request = createOrderWorkflow(h.ctx).prepareHandoff(h.state.order);
  h.state.generation++;
  h.state.store = { id: "store-b" };
  finish({ ...original(), version: 3 });
  await assert.rejects(() => request, /changed/i);
  assert.equal(h.commands.length, 0);
});
test("draft changes during synchronization require reopening Mail rather than sending a different revision", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness();
  h.ctx.syncDraft = async () => {
    h.state.order.lines[0].quantity = 4;
    return { ...original(), version: 3 };
  };
  await assert.rejects(
    () => createOrderWorkflow(h.ctx).prepareHandoff(original()),
    /changed/i,
  );
  assert.equal(h.commands.length, 0);
});
test("mark placed references the immutable handoff after later draft edits", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness(),
    workflow = createOrderWorkflow(h.ctx),
    prepared = await workflow.prepareHandoff(h.state.order);
  h.state.order.lines[0].quantity = 9;
  await workflow.markPlaced(prepared);
  assert.deepEqual(h.commands.at(-1), {
    type: "order.place",
    payload: { handoffId: "handoff" },
  });
});
test("an addition gets a new draft identity and only activates the confirmed scoped server result", async () => {
  const { createOrderWorkflow } = await helpers;
  assert.equal(typeof createOrderWorkflow, "function");
  const h = harness();
  h.ctx.command = async (type, payload) => {
    h.commands.push({ type, payload });
    return {
      id: payload.id,
      storeId: payload.storeId,
      status: "draft",
      lines: [],
      additionReference: "12-A1",
    };
  };
  const result = await createOrderWorkflow(h.ctx).startAddition(
    { id: "placement-a", storeId: "store-a" },
    { placement: true },
  );
  assert.equal(h.commands[0].type, "order.addition");
  assert.equal(h.commands[0].payload.parentPlacementId, "placement-a");
  assert.notEqual(result.id, "placement-a");
  assert.equal(h.state.order.id, result.id);
});
test("actual mixed receipts require exact total, known flavors and nonnegative whole quantities", async () => {
  const { prepareReceiptAllocations } = await helpers;
  assert.equal(typeof prepareReceiptAllocations, "function");
  const placement = {
    lines: [
      {
        id: "mix",
        selectionMode: "mix",
        quantity: 3,
        unit: "case",
        allowedVariants: ["Apple", "Orange"],
      },
    ],
  };
  assert.deepEqual(
    prepareReceiptAllocations(placement, [
      {
        lineId: "mix",
        allocations: [
          { variant: "Apple", quantity: "2" },
          { variant: "Orange", quantity: "1" },
        ],
      },
    ]),
    [
      {
        lineId: "mix",
        allocations: [
          { variant: "Apple", quantity: 2 },
          { variant: "Orange", quantity: 1 },
        ],
      },
    ],
  );
  for (const rows of [
    [{ variant: "Apple", quantity: 2 }],
    [{ variant: "Gone", quantity: 3 }],
    [
      { variant: "Apple", quantity: -1 },
      { variant: "Orange", quantity: 4 },
    ],
    [
      { variant: "Apple", quantity: 1.5 },
      { variant: "Orange", quantity: 1.5 },
    ],
    [
      { variant: "Apple", quantity: 1 },
      { variant: "Apple", quantity: 2 },
    ],
  ])
    assert.throws(
      () =>
        prepareReceiptAllocations(placement, [
          { lineId: "mix", allocations: rows },
        ]),
      /quantity|total|flavor|duplicate/i,
    );
});

test("credit attachment changes invalidate an in-flight Mail handoff", async () => {
  const { createOrderWorkflow } = await helpers;
  const h = harness();
  h.state.order.creditRequestIds = ["credit-original"];
  h.ctx.syncDraft = async () => {
    h.state.order.creditRequestIds = ["credit-added"];
    return { ...original(), creditRequestIds: ["credit-original"], version: 3 };
  };
  await assert.rejects(
    () =>
      createOrderWorkflow(h.ctx).prepareHandoff({
        ...original(),
        creditRequestIds: ["credit-original"],
      }),
    /changed/i,
  );
  assert.equal(h.commands.length, 0);
});
