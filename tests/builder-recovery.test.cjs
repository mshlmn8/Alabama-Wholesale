const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../public/app.js"),
  "utf8",
);
function section(start, end) {
  const from = source.indexOf(start),
    to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing application section: ${start}`);
  return source.slice(from, to);
}

// Only the DOM surface is simulated. The builder, its guards, and recovery
// snapshot/text functions below are the application functions themselves.
class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = children
      .flat(Infinity)
      .filter((item) => item != null && item !== false);
    Object.assign(this, attrs);
    this.value = String(attrs.value ?? "");
    this.dataset = {};
    this.isConnected = true;
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith("data-"))
        this.dataset[
          key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        ] = value;
    }
  }
  append(...children) {
    this.children.push(
      ...children
        .flat(Infinity)
        .filter((item) => item != null && item !== false),
    );
  }
  querySelectorAll(selector) {
    assert.equal(selector, "[data-draft-history] button");
    return walk(this)
      .filter((item) => item.dataset.draftHistory != null)
      .flatMap((item) => walk(item).filter((child) => child.tag === "button"));
  }
  get textContent() {
    return (
      this._text ??
      this.children
        .map((item) =>
          item instanceof Control ? item.textContent : String(item),
        )
        .join("")
    );
  }
  set textContent(value) {
    this._text = value;
  }
}
function walk(node) {
  return [
    node,
    ...node.children.flatMap((item) =>
      item instanceof Control ? walk(item) : [],
    ),
  ];
}

function fixture({ saveError = null } = {}) {
  const nodes = new Map(),
    dialogs = [],
    calls = [],
    errors = [];
  let saved = {
    id: "draft-1",
    storeId: "store-1",
    localRevision: 1,
    notes: "Original note",
    lines: [],
  };
  let identity = "buyer";
  const create = (tag, attrs = {}, ...children) => {
    const node = new Control(tag, attrs, children);
    if (attrs.id) nodes.set(attrs.id, node);
    return node;
  };
  const context = vm.createContext({
    draft: structuredClone(saved),
    storeId: "store-1",
    undo: [],
    redo: [],
    clone: structuredClone,
    $: (id) => nodes.get(id),
    operationScope: () => identity,
    scopeCurrent: (scope) => scope === identity,
    SessionChanged: class SessionChanged extends Error {},
    currentStore: () => ({ id: "store-1", name: "Store one" }),
    storeById: () => ({ id: "store-1", name: "Store one" }),
    productById: () => null,
    ws: {
      getDraft: (id) => (id === saved.id ? structuredClone(saved) : undefined),
    },
    availableDrafts: () => [structuredClone(saved)],
    groupDraftLines: () => [],
    draftTotals: () => ({ subtotal: 0, tax: 0, total: 0, missing: [] }),
    builderSize: () => "small",
    draftProtection: () => ({ label: "Saved on device", tone: "" }),
    cash: (cents) => `$${(cents / 100).toFixed(2)}`,
    orderName: (order) => `${order.storeId} / ${order.id}`,
    orderFilename: (order) => `${order.id}.json`,
    el: create,
    append: (node, ...children) => node.append(...children),
    heading: (title, subtitle, actions) =>
      create("header", {}, title, subtitle, actions),
    empty: (title, subtitle, actions) =>
      create("div", {}, title, subtitle, actions),
    field: (label, node) => create("label", {}, label, node),
    button: (label, callback) => create("button", { callback }, label),
    iconButton: (label, symbol, callback) =>
      create("button", { label, callback }, label),
    act: async (fn) => {
      try {
        return await fn();
      } catch (error) {
        errors.push(error);
      }
    },
    notice: (message) => create("p", {}, message),
    toast() {},
    updateDraftProtection: (id) =>
      calls.push({ type: "protection-updated", id }),
    showDraftProtection: (id) => calls.push({ type: "protection-opened", id }),
    editDraft: (edit, options) => {
      if (saveError) throw saveError;
      const next = structuredClone(context.draft);
      edit(next);
      next.localRevision++;
      context.undo.push(structuredClone(context.draft));
      context.draft = next;
      saved = structuredClone(next);
      calls.push({ type: "draft-saved", options });
    },
    beginDraft: () => calls.push({ type: "new-draft" }),
    showBuilderSettings: () => calls.push({ type: "item-size" }),
    setView: (view) => calls.push({ type: "view", view }),
    confirmAction: async () => {
      calls.push({ type: "confirm" });
      return true;
    },
    copyText: async (text) => calls.push({ type: "copy", text }),
    download: (filename, text) =>
      calls.push({ type: "download", filename, text }),
    showAssistant() {},
    showSubmit() {},
    undoDraft() {},
    syncDraft() {},
    modal: () => {
      const modal = {
        dialog: create("dialog", { open: true }),
        content: create("div"),
        footer: create("div"),
      };
      modal.close = () => {
        modal.dialog.open = false;
      };
      modal.dialog.append(modal.content, modal.footer);
      dialogs.push(modal);
      return modal;
    },
  });
  vm.runInContext(
    [
      section(
        "function draftRecoverySnapshot(",
        "function workspaceRecoverySnapshot(",
      ),
      section(
        "function hasUnsavedDraftNotes()",
        'window.addEventListener("storage"',
      ),
      section(
        source.includes("function assertBuilderIdentity(")
          ? "function assertBuilderIdentity("
          : "function assertBuilderDraft(",
        "function renderDraftList(",
      ),
      section("function draftText(", "async function copyText("),
    ].join("\n"),
    context,
  );
  const root = context.renderBuilder();
  const findButton = (root, label) => {
    const result = walk(root).find(
      (node) =>
        node.tag === "button" &&
        (node.label === label || node.textContent === label),
    );
    assert.ok(result, `Missing button: ${label}`);
    return result;
  };
  return {
    context,
    root,
    calls,
    errors,
    note: nodes.get("draft-notes"),
    saved: () => structuredClone(saved),
    changeIdentity: () => {
      identity = "different-buyer";
    },
    click: async (label) => context.act(findButton(root, label).callback),
    openActions: () => {
      context.showBuilderActions();
      return dialogs.at(-1);
    },
    clickAction: async (modal, label) =>
      context.act(findButton(modal.dialog, label).callback),
  };
}

test("builder notes persist typed text while the visible value differs from the saved draft", async () => {
  const f = fixture();
  f.note.value = "Deliver at the rear door";
  assert.equal(f.context.hasUnsavedDraftNotes(), true);
  await f.note.onInput({ target: f.note });
  assert.deepEqual(f.errors, []);
  assert.equal(f.saved().notes, "Deliver at the rear door");
  assert.equal(f.saved().localRevision, 2);
  assert.equal(f.context.hasUnsavedDraftNotes(), false);
  assert.equal(f.calls.filter((call) => call.type === "draft-saved").length, 1);
});

test("a stale builder note event cannot write after the identity, store, or active draft changes", async () => {
  for (const change of [
    (f) => f.changeIdentity(),
    (f) => {
      f.context.storeId = "other-store";
    },
    (f) => {
      f.context.draft = { ...f.context.draft, id: "other-draft" };
    },
  ]) {
    const f = fixture();
    f.note.value = "Stale note";
    change(f);
    await f.note.onInput({ target: f.note });
    assert.equal(f.errors.length, 1);
    assert.equal(f.saved().notes, "Original note");
    assert.equal(
      f.calls.some((call) => call.type === "draft-saved"),
      false,
    );
  }
});

test("new draft and item size actions preserve visible notes after a save failure", async () => {
  for (const label of ["New draft", "Item size"]) {
    const f = fixture({ saveError: Error("Device save failed") });
    f.note.value = "Only surviving note";
    await f.note.onInput({ target: f.note });
    assert.match(f.errors[0].message, /Device save failed/);
    const modal = f.openActions();
    await f.clickAction(modal, label);
    assert.equal(f.errors.length, 2);
    assert.match(f.errors[1].message, /notes/i);
    assert.equal(modal.dialog.open, true, "Keep recovery options available.");
    assert.equal(f.note.value, "Only surviving note");
    assert.equal(f.saved().notes, "Original note");
    assert.equal(
      f.calls.some((call) =>
        ["new-draft", "item-size", "confirm"].includes(call.type),
      ),
      false,
    );
  }
});

test("copy and download recover visible notes without overwriting the saved draft", async () => {
  for (const label of ["Copy order text", "Download draft"]) {
    const f = fixture({ saveError: Error("Device save failed") });
    f.note.value = "Recovery-only instructions";
    await f.note.onInput({ target: f.note });
    assert.match(f.errors[0].message, /Device save failed/);
    const modal = f.openActions();
    await f.clickAction(modal, label);
    assert.equal(
      f.errors.length,
      1,
      "The failed save must not block explicit recovery.",
    );
    const result = f.calls.find((call) =>
      ["copy", "download"].includes(call.type),
    );
    assert.ok(result);
    assert.match(result.text, /Recovery-only instructions/);
    if (result.type === "download") {
      const recovered = JSON.parse(result.text);
      assert.equal(recovered.id, "draft-1");
      assert.equal(recovered.notes, f.note.value);
      assert.equal(recovered.needsReconciliation, true);
    }
    assert.equal(f.saved().notes, "Original note");
    assert.equal(f.context.draft.notes, "Original note");
  }
});

test("Save details opens note recovery after a failed save and still rejects a stale identity", async () => {
  const f = fixture({ saveError: Error("Device save failed") });
  f.note.value = "Need recovery";
  await f.note.onInput({ target: f.note });
  assert.match(f.errors[0].message, /Device save failed/);
  await f.click("Save details");
  assert.equal(f.errors.length, 1);
  assert.equal(
    f.calls.filter((call) => call.type === "protection-opened").length,
    1,
  );
  assert.equal(
    f.calls.find((call) => call.type === "protection-opened").id,
    "draft-1",
  );
  f.changeIdentity();
  await f.click("Save details");
  assert.equal(f.errors.length, 2);
  assert.equal(
    f.calls.filter((call) => call.type === "protection-opened").length,
    1,
  );
});

test("Add items cannot discard notes that failed to save", async () => {
  const f = fixture({ saveError: Error("Device save failed") });
  f.note.value = "Do not lose this";
  await f.note.onInput({ target: f.note });
  assert.match(f.errors[0].message, /Device save failed/);
  await f.click("Add items");
  assert.equal(f.errors.length, 2);
  assert.match(f.errors[1].message, /notes/i);
  assert.equal(
    f.calls.some((call) => call.type === "view"),
    false,
  );
});
