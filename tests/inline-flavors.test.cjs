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
  }
  append(...children) {
    this.children.push(...children.filter((item) => item != null));
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
    packSize: 12,
  };
  const original = {
    id: "line",
    productId: "juice",
    variant: standard ? "" : "Apple",
    quantity: 2,
    unit: "each",
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
  const controls = () => walk(dialog.dialog);
  return {
    context,
    calls,
    product,
    openAdd: () => context.showAddProduct(product),
    openEdit: () => context.showEditDraftLine("line"),
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

test("saving a flavor in the item picker preserves quantities, unit, and note", async () => {
  const f = await fixture();
  f.openAdd();
  const apple = f.control("Apple quantity");
  apple.value = "4";
  f.control("Order unit").value = "case";
  f.control("Line note").value = "Keep cold";
  assert.ok(
    f.control("New flavor name"),
    "The picker includes inline flavor creation",
  );
  f.control("New flavor name").value = "Grape";
  await f.button("Save flavor").callback();
  assert.equal(f.control("Apple quantity"), apple);
  assert.equal(apple.value, "4");
  assert.equal(f.control("Order unit").value, "case");
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
      ["Apple", 4, "case", "Keep cold"],
      ["Grape", 2, "case", "Keep cold"],
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
  f.control("Order unit").value = "case";
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
    unit: "case",
    note: "Top shelf",
  });
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
