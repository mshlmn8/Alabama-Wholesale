const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const storage = import("data:text/javascript;base64," + Buffer.from(
  fs.readFileSync(path.join(__dirname, "../public/storage.js"), "utf8"),
).toString("base64"));
async function fixture() {
  const { Workspace, isRejectedAction } = await storage;
  let saved;
  const workspace = new Workspace({ getItem: () => saved, setItem: (_, value) => { saved = value; } }, "owner");
  const scope = { workspace };
  let current = true;
  const dialogs = [], messages = [], reads = [];
  const el = (tag, attrs = {}, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter(child => child != null) });
  const context = vm.createContext({
    ws: workspace, isRejectedAction, el,
    operationScope: () => scope, scopeCurrent: value => current && value === scope,
    SessionChanged: class extends Error {},
    append: (node, ...children) => node.children.push(...children.flat(Infinity)),
    modal: (title, description) => {
      const view = { title, description, content: el("div"), footer: el("div"), close() { view.closed = true; } };
      dialogs.push(view); return view;
    },
    empty: (title, body) => el("div", {}, title, body),
    button: (label, callback) => el("button", { callback }, label),
    notice: value => el("p", {}, value), status: value => el("span", {}, value),
    titleCase: value => value, date: () => "Oct 5, 2026",
    toast: message => messages.push(message),
    flushQueue: async () => {}, refresh: async () => {}, render: () => {},
    api: async url => { reads.push(url); return { order: { id: "order", status: "draft", version: 2 } }; },
    showOrder: order => { reads.push(order); },
    confirmAction: async () => true,
  });
  vm.runInContext(source.slice(source.indexOf("function showSyncCenter()"), source.indexOf("function showWorkspaceBackup()")), context);
  const walk = node => [node, ...(node.children || []).filter(child => typeof child === "object").flatMap(walk)];
  return { workspace, scope, context, dialogs, messages, reads,
    open: () => context.showSyncCenter(), accountChanged: () => { current = false; },
    buttons: () => walk(dialogs.at(-1).content).filter(node => node.tag === "button"),
    text: () => JSON.stringify(dialogs.at(-1)),
  };
}

test("rejected handoffs are history with a fresh review, never an endless retry", async () => {
  const f = await fixture();
  f.workspace.enqueue({ id: "old-handoff", type: "order.handoff", payload: { id: "order", expectedVersion: 1 } });
  f.workspace.fail("old-handoff", "This record changed.", "VERSION_CONFLICT", 409);
  f.open();
  assert.match(f.text(), /Rejected actions/);
  assert.doesNotMatch(f.text(), /Everything is confirmed/);
  assert.equal(f.buttons().some(button => button.children.includes("Retry same request")), false);
  await f.buttons().find(button => button.children.includes("Review current order")).callback();
  assert.deepEqual(f.reads, ["/api/orders/order", { id: "order", status: "draft", version: 2 }]);
  assert.equal(f.workspace.rejected().length, 1, "review preserves the rejected record");
});

test("a retry that is rejected updates the open dialog and never reports confirmation", async () => {
  const f = await fixture();
  f.workspace.enqueue({ id: "retry", type: "order.handoff", payload: { id: "order", expectedVersion: 1 } });
  f.context.flushQueue = async () => {
    f.workspace.fail("retry", "This record changed.", "VERSION_CONFLICT", 409);
    throw new Error("This record changed.");
  };
  f.open();
  const first = f.dialogs[0];
  await assert.rejects(() => f.buttons().find(button => button.children.includes("Retry same request")).callback());
  assert.equal(first.closed, true);
  assert.match(f.text(), /Rejected actions/);
  assert.equal(f.messages.some(message => /confirmed/i.test(message)), false);
});

test("an old sync dialog cannot read or dismiss another account's data", async () => {
  const f = await fixture();
  f.workspace.enqueue({ id: "old", type: "order.handoff", payload: { id: "order", expectedVersion: 1 } });
  f.workspace.fail("old", "Changed", "VERSION_CONFLICT", 409);
  f.open();
  assert.ok(f.buttons().length >= 2);
  f.accountChanged();
  for (const button of f.buttons()) await assert.rejects(async () => button.callback());
  assert.equal(f.workspace.rejected().length, 1);
  assert.equal(f.reads.length, 0);
});
