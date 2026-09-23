const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require("node:path").join(__dirname, "../public/app.js"),
  "utf8",
);
function fixture(number) {
  const local = {
    id: "draft",
    storeId: "s",
    localRevision: 6,
    version: 1,
    notes: "Typed latest note",
    lines: [{ quantity: 9 }],
  };
  const saved = {
    ...local,
    localRevision: 5,
    version: 2,
    orderNumber: number,
    notes: "Older note",
    lines: [{ quantity: 2 }],
  };
  const title = { dataset: { orderName: "draft" }, textContent: "New order" };
  const other = { dataset: { orderName: "other" }, textContent: "Other draft" };
  const context = vm.createContext({
    ws: { getDraft: () => saved },
    draft: structuredClone(local),
    draftSync: { get: () => saved },
    state: { orders: [] },
    $: () => null,
    document: {
      querySelectorAll: (selector) =>
        selector === "[data-order-name]" ? [title, other] : [],
    },
    draftProtection: () => ({ cloudConfirmed: false, label: "Saving" }),
    orderName: (order) => String(order.orderNumber),
    storeById: () => ({}),
    updateWorkspaceProtection() {},
    render() {
      throw Error("Do not rebuild edited controls");
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function updateDraftMetadata("),
      source.indexOf("function scheduleDraftProtectionUpdate("),
    ),
    context,
  );
  return { context, local, title, other };
}
test("a newly assigned order number updates visible labels without losing newer draft edits", () => {
  const f = fixture(7);
  f.context.updateDraftProtection("draft");
  assert.equal(f.context.draft.orderNumber, 7);
  assert.equal(f.context.draft.localRevision, 6);
  assert.equal(
    f.context.draft.version,
    1,
    "Version metadata still follows revision protection.",
  );
  assert.equal(f.context.draft.notes, f.local.notes);
  assert.equal(f.context.draft.lines[0].quantity, 9);
  assert.equal(f.title.textContent, "7");
  assert.equal(f.other.textContent, "Other draft");
});
test("missing or invalid authoritative number metadata clears an old display number", () => {
  for (const value of [undefined, 0, -1, "3", 1.5]) {
    const f = fixture(value);
    f.context.draft.orderNumber = 99;
    f.context.updateDraftMetadata("draft");
    assert.equal(Object.hasOwn(f.context.draft, "orderNumber"), false);
    assert.equal(f.context.draft.notes, f.local.notes);
  }
});
