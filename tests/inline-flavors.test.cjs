const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const load = (name) =>
  import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, "../public", name), "utf8"),
      ).toString("base64")
  );

// A small DOM surface keeps these tests focused on the real dialog event paths.
class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.children = children.flat(Infinity).filter((item) => item != null);
    Object.assign(this, attrs);
    this.value = String(attrs.value ?? "");
    this.listeners = {};
    this.classList = { add() {}, toggle() {} };
    this.validity = { valid: true };
    if (attrs.type === "file") this.files = [];
  }
  append(...children) {
    this.children.push(...children.filter((item) => item != null));
  }
  replaceChildren(...children) {
    this.children = children.flat(Infinity).filter((item) => item != null);
  }
  setAttribute(key, value) {
    this[key] = value;
  }
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  focus() {
    this.focused = true;
  }
  removeAttribute(key) {
    delete this[key];
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
  querySelectorAll() {
    return walk(this).filter((item) =>
      ["input", "select", "textarea", "button"].includes(item.tag),
    );
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

async function fixture({
  role = "master",
  standard = false,
  saveError = null,
  originalUnit = "each",
  packSize = 12,
  proposal = { lines: [], ambiguities: [], summary: "" },
} = {}) {
  const helpers = {
    ...(await load("catalog-variants.js")),
    ...(await load("order-selection.js")),
  };
  let sequence = 0,
    dialog;
  const product = {
    id: "juice",
    name: "Juice",
    version: 7,
    active: true,
    variants: standard ? [] : ["Apple", "Orange"],
    variantPricesCents: {},
    variantBarcodes: {},
    priceCents: 150,
    packSize,
  };
  const original = {
    id: "line",
    productId: "juice",
    variant: standard ? "" : "Apple",
    quantity: 2,
    unit: originalUnit,
    note: "Original",
  };
  const state = { me: { role }, products: [product], inventory: [] };
  const calls = [];
  const context = {
    ...helpers,
    state,
    storeId: "store",
    draft: { id: "draft", lines: [original] },
    uuid: () => `id-${++sequence}`,
    clone: structuredClone,
    master: () => state.me.role === "master",
    operationScope: () => "session",
    scopeCurrent: () => true,
    SessionChanged: class extends Error {},
    hasUnsavedDraftNotes: () => false,
    productById: (id) => state.products.find((item) => item.id === id),
    linePrice: () => 150,
    cash: (value) => `$${value / 100}`,
    toast() {},
    toggleFavorite() {},
    render() {},
    setView() {},
    notice: (message) => new Control("p", {}, [message]),
    api: async () => structuredClone(proposal),
    numberCents: (value) =>
      value === "" ? null : Math.round(Number(value) * 100),
    el: (tag, attrs = {}, ...children) => new Control(tag, attrs, children),
    input: (type, value = "", attrs = {}) =>
      new Control("input", { type, value, ...attrs }),
    select: (options, value, attrs = {}) =>
      new Control(
        "select",
        { value, ...attrs },
        options.map(
          ([value, text]) => new Control("option", { value }, [text]),
        ),
      ),
    field: (label, control, help) => {
      control.fieldLabel = label;
      return new Control("div", {}, [control, help]);
    },
    button: (label, callback) => new Control("button", { callback }, [label]),
    append: (node, ...children) => node.append(...children),
    modal: () => {
      dialog = {
        dialog: new Control("dialog", { open: true }),
        content: new Control("div"),
        footer: new Control("div"),
      };
      dialog.dialog.append(dialog.content, dialog.footer);
      dialog.close = () => {
        dialog.dialog.open = false;
      };
      return dialog;
    },
    command: async (type, payload) => {
      calls.push({ type, payload });
      if (saveError) throw saveError;
      const previous = state.products[0];
      assert.equal(payload.expectedVersion, previous.version);
      const saved = {
        ...previous,
        ...payload,
        version: previous.version + 1,
        standardVariantEnabled:
          previous.standardVariantEnabled === true || !previous.variants.length,
      };
      delete saved.expectedVersion;
      state.products[0] = saved;
      return saved;
    },
    editDraft: (edit) => edit(context.draft),
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../public/app.js"),
    "utf8",
  );
  const start = source.includes("function inlineFlavorEditor(")
    ? source.indexOf("function inlineFlavorEditor(")
    : source.indexOf("function showAddProduct(");
  vm.runInNewContext(
    source.slice(start, source.indexOf("function renderBuilder()", start)),
    context,
  );
  vm.runInNewContext(
    source.slice(source.indexOf("function showAssistant()"), source.indexOf("function showScanner()")),
    context,
  );
  const controls = () => walk(dialog.dialog);
  return {
    context,
    calls,
    product,
    openAdd: () => context.showAddProduct(product),
    openEdit: () => context.showEditDraftLine("line"),
    openAssistant: () => context.showAssistant(),
    controls,
    control: (label) =>
      controls().find(
        (item) => item.fieldLabel === label || item["aria-label"] === label,
      ),
    button: (label) =>
      controls().find(
        (item) => item.tag === "button" && item.textContent === label,
      ),
    dialog: () => dialog,
  };
}

test("saving a flavor in the item picker preserves quantities and note without a unit selector", async () => {
  const f = await fixture();
  f.openAdd();
  const apple = f.control("Apple quantity");
  apple.value = "4";
  assert.equal(f.control("Order unit"), undefined);
  f.control("Line note").value = "Keep cold";
  assert.ok(
    f.control("New flavor name"),
    "The picker includes inline flavor creation",
  );
  f.control("New flavor name").value = "Grape";
  await f.button("Save flavor").callback();
  assert.equal(f.control("Apple quantity"), apple);
  assert.equal(apple.value, "4");
  assert.equal(f.control("Order unit"), undefined);
  assert.equal(f.control("Line note").value, "Keep cold");
  assert.equal(f.control("Grape quantity").value, "0");
  f.control("Grape quantity").value = "2";
  await f.button("Add selected flavors").callback();
  assert.equal(f.calls[0].type, "product.save");
  assert.deepEqual(
    f.context.draft.lines
      .slice(1)
      .map((line) => [line.variant, line.quantity, line.unit, line.note]),
    [
      ["Apple", 4, "each", "Keep cold"],
      ["Grape", 2, "each", "Keep cold"],
    ],
  );
});

test("adding the first flavor keeps the selected Standard quantity", async () => {
  const f = await fixture({ standard: true });
  f.openAdd();
  const standard = f.control("Standard quantity");
  standard.value = "3";
  assert.ok(f.control("New flavor name"));
  f.control("New flavor name").value = "Grape";
  await f.button("Save flavor").callback();
  assert.equal(f.control("Standard quantity"), standard);
  assert.equal(standard.value, "3");
  assert.ok(f.control("Grape quantity"));
  await f.button("Add selected flavors").callback();
  assert.equal(f.context.draft.lines.at(-1).variant, "");
  assert.equal(f.context.draft.lines.at(-1).quantity, 3);
});

test("builder flavor creation selects the new flavor and retains unsaved item fields", async () => {
  const f = await fixture();
  f.openEdit();
  f.control("Quantity").value = "8";
  assert.equal(f.control("Order unit"), undefined);
  f.control("Line note").value = "Top shelf";
  assert.ok(f.control("New flavor name"));
  f.control("New flavor name").value = "Grape";
  await f.button("Save flavor").callback();
  assert.equal(f.control("Flavor").value, "Grape");
  await f.button("Update item").callback();
  assert.deepEqual(f.context.draft.lines[0], {
    id: "line",
    productId: "juice",
    variant: "Grape",
    quantity: 8,
    unit: "each",
    note: "Top shelf",
  });
});

test("row options remove only the selected line and close after saving", async () => {
  const f = await fixture();
  f.context.draft.lines.push({ ...f.context.draft.lines[0], id: "other", variant: "Orange" });
  f.openEdit();
  assert.ok(f.button("Remove item"));
  await f.button("Remove item").callback();
  assert.equal(f.context.draft.lines.length, 1);
  assert.equal(f.context.draft.lines[0].id, "other");
  assert.equal(f.dialog().dialog.open, false);
});

test("row options cannot remove a line changed after opening", async () => {
  const f = await fixture();
  f.openEdit();
  f.context.draft.lines[0].quantity = 9;
  assert.ok(f.button("Remove item"));
  assert.throws(() => f.button("Remove item").callback(), /changed while/);
  assert.equal(f.context.draft.lines[0].quantity, 9);
});

test("catalog conflicts preserve all unsaved dialog inputs and do not add a flavor", async () => {
  const f = await fixture({
    saveError: new Error("Product changed elsewhere"),
  });
  f.openAdd();
  f.control("Apple quantity").value = "5";
  assert.ok(f.control("New flavor name"));
  f.control("New flavor name").value = "Grape";
  await assert.rejects(
    () => f.button("Save flavor").callback(),
    /changed elsewhere/,
  );
  assert.equal(f.control("Apple quantity").value, "5");
  assert.equal(f.control("New flavor name").value, "Grape");
  assert.equal(f.control("Grape quantity"), undefined);
  assert.equal(f.dialog().dialog.open, true);
});

test("customers cannot create catalog flavors from either item dialog", async () => {
  const f = await fixture({ role: "customer" });
  for (const open of [f.openAdd, f.openEdit]) {
    open();
    assert.equal(f.control("New flavor name"), undefined);
    assert.equal(f.button("Save flavor"), undefined);
  }
  assert.equal(f.calls.length, 0);
});

test("new items use simple quantities even when the draft already contains the same flavor in cases", async () => {
  const f = await fixture({ originalUnit: "case" });
  f.context.draft.lines[0].note = "";
  f.openAdd();
  assert.equal(f.control("Order unit"), undefined);
  assert.doesNotMatch(f.dialog().dialog.textContent, /\/ each|each available/);
  f.control("Apple quantity").value = "3";
  await f.button("Add selected flavors").callback();
  assert.equal(f.context.draft.lines.length, 2);
  assert.equal(f.context.draft.lines[0].unit, "case");
  assert.equal(f.context.draft.lines[0].quantity, 2);
  assert.equal(f.context.draft.lines[1].unit, "each");
  assert.equal(f.context.draft.lines[1].quantity, 3);
});

test("editing a legacy case item preserves its saved unit and explains the quantity", async () => {
  const f = await fixture({ originalUnit: "case" });
  f.openEdit();
  assert.equal(f.control("Order unit"), undefined);
  assert.equal(f.control("Quantity").value, "2");
  assert.match(f.dialog().dialog.textContent, /existing case quantity.*12 items per case/i);
  f.control("Quantity").value = "3";
  f.control("Line note").value = "Keep original case count";
  await f.button("Update item").callback();
  assert.equal(f.context.draft.lines[0].unit, "case");
  assert.equal(f.context.draft.lines[0].quantity, 3);
  assert.equal(f.context.draft.lines[0].note, "Keep original case count");
});

test("a legacy case item never converts to individual quantities when its pack size is missing", async () => {
  const f = await fixture({ originalUnit: "case", packSize: null });
  f.openEdit();
  assert.equal(f.control("Order unit"), undefined);
  assert.match(f.dialog().dialog.textContent, /existing case quantity/i);
  await f.button("Update item").callback();
  assert.equal(f.context.draft.lines[0].unit, "case");
  assert.equal(f.context.draft.lines[0].quantity, 2);
});

test("legacy case hints prefer an issued line's saved pack size over the current catalog", async () => {
  const f = await fixture();
  assert.equal(typeof f.context.savedCaseQuantityHint, "function");
  assert.equal(f.context.savedCaseQuantityHint({ unit: "each" }, f.product), "");
  assert.match(f.context.savedCaseQuantityHint({ unit: "case", packSize: 6 }, f.product), /6 items per case/);
  assert.doesNotMatch(f.context.savedCaseQuantityHint({ unit: "case", packSize: null }, f.product), /12 items/);
});

test("AI review uses plain quantities and preserves explicit cases with context", async () => {
  const f = await fixture({ proposal: {
    lines: [
      { productId: "juice", variant: "Apple", quantity: 3, unit: "each", note: "" },
      { productId: "juice", variant: "Orange", quantity: 2, unit: "case", note: "" },
    ], ambiguities: [], summary: "Review 2 flavors",
  } });
  f.openAssistant();
  const note = f.control("Tell the AI what you need");
  assert.doesNotMatch(note.placeholder, /cases|each/);
  note.value = "3 Apple juice and 2 cases of Orange juice";
  await f.button("Create proposed cart").callback();
  assert.doesNotMatch(f.dialog().dialog.textContent, /Apple · each/);
  assert.match(f.dialog().dialog.textContent, /Requested case quantity.*12 items per case/);
  const acknowledgement = f.controls().find((item) => item.tag === "input" && item.type === "checkbox" && !item["aria-label"]);
  acknowledgement.checked = true;
  await f.button("Add reviewed items to draft").callback();
  assert.deepEqual(f.context.draft.lines.slice(1).map((line) => [line.quantity, line.unit]), [[3, "each"], [2, "case"]]);
});
