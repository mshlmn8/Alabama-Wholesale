const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MemoryRepository } = require("../lib/repository.cjs");
const { executeCommand } = require("../lib/domain.cjs");
const load = (name) => import("data:text/javascript;base64," + Buffer.from(
  fs.readFileSync(path.join(__dirname, "../public/", name), "utf8"),
).toString("base64"));

// Execute the browser's real queue functions with the same Workspace and domain
// command handler. UI effects are omitted; command receipts and financial effects
// are real, including retries of lost responses.
async function fixture() {
  const [{ Workspace }, session] = await Promise.all([
    load("storage.js"),
    load("session.js"),
  ]);
  const saved = new Map();
  const workspace = new Workspace({
    getItem: (key) => saved.get(key) || null,
    setItem: (key, value) => saved.set(key, value),
  }, "owner");
  const actor = { uid: "owner", role: "master", storeIds: [] };
  const repo = new MemoryRepository({
    stores: [{ id: "s1", name: "Shop", active: true, version: 1 }],
    products: [{ id: "p1", name: "Drink", variants: ["Lime"], priceCents: 200, version: 1 }],
    notifications: [{ id: "n1", userId: "owner", readBy: [], version: 1 }],
  });
  let sequence = 0;
  const calls = [];
  const actual = (command) => repo.transaction((tx) => executeCommand(tx, actor, command, {
    now: 1789372800000,
    id: () => `record-${++sequence}`,
  }));
  const draft = await actual({
    id: "initial-save", type: "order.save", payload: {
      id: "d1", storeId: "s1", lines: [{ id: "l1", productId: "p1", variant: "Lime", quantity: 2, unit: "each", note: "" }], notes: "",
    },
  });
  workspace.saveDraft(draft);
  const scope = { workspace, session: actor };
  let current = true, send = actual;
  const context = vm.createContext({
    ...session,
    ws: workspace, session: actor, queueBusy: false, draft: null, draftSync: null,
    draftProtectionCache: new Map(), state: { me: actor }, navigator: { onLine: true },
    operationScope: () => scope,
    scopeCurrent: (value) => current && value === scope,
    uuid: () => `command-${++sequence}`,
    api: async (url, options) => {
      assert.equal(url, "/api/commands");
      assert.equal(options.method, "POST");
      calls.push(structuredClone(options.body));
      return { result: await send(options.body) };
    },
    friendlyError: (error) => error.message,
    refresh: async () => {}, render: () => {}, toast: () => {},
    requestCompletedOrderCopy: () => {},
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("async function sendEntry("), source.indexOf("function setView(")), context);
  return { workspace, repo, calls, actual, draft, context, command: context.command, flush: context.flushQueue,
    send: (fn) => { send = fn; }, account: (value) => { current = value; } };
}

test("a pending settings save does not prevent compiling an order for Mail", async () => {
  const f = await fixture();
  const entry = f.workspace.enqueue({ id: "settings", type: "preferences.save", payload: { theme: "dark", expectedVersion: 0 } });
  f.workspace.fail(entry.command.id, "Connection lost", "NETWORK");
  const pending = f.workspace.pending();
  const result = await f.command("order.handoff", { id: f.draft.id, expectedVersion: f.draft.version });
  assert.equal(result.orderId, f.draft.id);
  assert.deepEqual(f.workspace.pending(), pending);
  assert.equal((await f.repo.list("ledger")).length, 0);
  await f.flush(true);
  assert.deepEqual(f.calls[1], entry.command);
  assert.equal(f.workspace.pending().length, 0);
});

test("a rejected stale handoff stops blocking and a fresh review succeeds", async () => {
  const f = await fixture();
  const local = f.workspace.getDraft(f.draft.id);
  await assert.rejects(() => f.command("order.handoff", {
    id: f.draft.id, expectedVersion: 0,
  }), { code: "VERSION_CONFLICT" });
  assert.equal(f.workspace.pending().length, 0);
  assert.equal(f.workspace.rejected().length, 1);
  const rejected = f.workspace.rejected()[0];
  assert.equal(rejected.command.payload.expectedVersion, 0);
  assert.deepEqual(f.workspace.getDraft(f.draft.id), local);
  const result = await f.command("order.handoff", {
    id: f.draft.id, expectedVersion: f.draft.version,
  });
  assert.equal(result.orderId, f.draft.id);
  assert.notEqual(f.calls[0].id, f.calls[1].id);
  await f.flush(true);
  assert.equal(f.calls.length, 2, "retry never replays the rejected request");
  assert.deepEqual(f.workspace.rejected()[0], rejected);
  assert.equal((await f.repo.list("ledger")).length, 0);
});

test("manual retry cannot report confirmation when offline or already syncing", async () => {
  const f = await fixture();
  f.workspace.enqueue({ id: "offline", type: "notification.read", payload: { id: "n1" } });
  f.context.navigator.onLine = false;
  await assert.rejects(() => f.flush(true), /connect|offline/i);
  f.context.navigator.onLine = true;
  f.context.queueBusy = true;
  await assert.rejects(() => f.flush(true), /already|progress/i);
  assert.equal(f.calls.length, 0);
  assert.equal(f.workspace.pending().length, 1);
});

test("a server-proven validation rejection leaves history without blocking corrections", async () => {
  const f = await fixture();
  await assert.rejects(() => f.command("product.save", { name: "" }), { code: "INVALID_INPUT" });
  assert.equal(f.workspace.pending().length, 0);
  assert.equal(f.workspace.rejected()[0].outcome, "rejected");
  const result = await f.command("product.save", { name: "Corrected product" });
  assert.equal(result.name, "Corrected product");
  assert.equal(f.workspace.rejected().length, 1);
});

test("a pending notification read does not prevent a reviewed order submission", async () => {
  const f = await fixture();
  const entry = f.workspace.enqueue({ id: "notification", type: "notification.read", payload: { id: "n1" } });
  const result = await f.command("order.submit", { id: f.draft.id, expectedVersion: f.draft.version, expectedTotalCents: 400 });
  assert.equal(result.status, "submitted");
  assert.equal((await f.repo.list("ledger")).length, 1);
  assert.deepEqual(f.workspace.pending()[0].command, entry.command);
});

test("pending financial, unknown, and same-order actions still block new order actions", async () => {
  for (const type of ["payment.report", "order.submit", "order.save", "inventory.adjust", "future.command"]) {
    const f = await fixture();
    f.workspace.enqueue({ id: "pending", type, payload: { id: f.draft.id, storeId: "s1" } });
    const pending = f.workspace.pending();
    await assert.rejects(() => f.command("order.handoff", { id: f.draft.id, expectedVersion: f.draft.version }), /pending action/);
    assert.deepEqual(f.workspace.pending(), pending);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.repo.list("ledger")).length, 0);
  }
});

test("an uncertain order submit retains its exact request and retries without a second charge", async () => {
  const f = await fixture();
  f.workspace.enqueue({ id: "settings", type: "preferences.save", payload: { theme: "dark", expectedVersion: 0 } });
  let first = true;
  f.send(async (command) => {
    const result = await f.actual(command);
    if (command.type === "order.submit" && first) { first = false; throw Object.assign(new Error("Connection lost"), { code: "NETWORK" }); }
    return result;
  });
  const payload = { id: f.draft.id, expectedVersion: f.draft.version, expectedTotalCents: 400 };
  await assert.rejects(() => f.command("order.submit", payload), /Connection lost/);
  const pendingSubmit = f.workspace.pending().find((item) => item.command.type === "order.submit");
  assert.ok(pendingSubmit);
  await assert.rejects(() => f.command("order.submit", payload), /pending action/);
  await f.flush(true);
  assert.deepEqual(f.calls.filter((item) => item.type === "order.submit"), [pendingSubmit.command, pendingSubmit.command]);
  assert.equal((await f.repo.list("ledger")).length, 1);
  assert.equal(f.workspace.pending().length, 0);
});
