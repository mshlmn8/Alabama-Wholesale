const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "../public/catalog-search.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const catalog = import(
  "data:text/javascript;base64," +
    Buffer.from(
      fs.readFileSync(
        path.join(__dirname, "../public/view-helpers.js"),
        "utf8",
      ),
    ).toString("base64")
);

async function setup() {
  const { bindCatalogSearch } = await helpers;
  assert.equal(typeof bindCatalogSearch, "function");
  const { indexCatalogProducts, rankCatalogProducts } = await catalog;
  const index = indexCatalogProducts([
    { id: "water", name: "Water", variants: ["Lime"], barcode: "00123" },
    { id: "ss", name: "SS" },
    { id: "floss", name: "Mint floss" },
  ]);
  const field = new EventTarget();
  field.value = "";
  let matches = rankCatalogProducts(index, field.value);
  bindCatalogSearch(field, (value) => {
    matches = rankCatalogProducts(index, value);
  });
  const dispatch = (type, properties = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, properties);
    field.dispatchEvent(event);
    return event;
  };
  return { field, dispatch, ids: () => matches.map((product) => product.id) };
}

test("typing filters results immediately and retains barcode and flavor matching", async () => {
  const { field, dispatch, ids } = await setup();
  for (const query of ["SS", "00123", "lime"]) {
    field.value = query;
    dispatch("input");
    assert.deepEqual(ids(), [query === "SS" ? "ss" : "water"]);
  }
});

for (const type of ["change", "search", "compositionend"]) {
  test(`${type} commits the visible query even when no input event arrives`, async () => {
    const { field, dispatch, ids } = await setup();
    field.value = "SS";
    dispatch(type);
    assert.deepEqual(ids(), ["ss"]);
  });
}

test("Enter applies the visible query without submitting or moving focus", async () => {
  const { field, dispatch, ids } = await setup();
  field.value = "SS";
  const event = dispatch("keydown", { key: "Enter" });
  assert.deepEqual(ids(), ["ss"]);
  assert.equal(event.defaultPrevented, true);
});

test("clearing a native search restores every result without another keystroke", async () => {
  const { field, dispatch, ids } = await setup();
  field.value = "SS";
  dispatch("input");
  assert.deepEqual(ids(), ["ss"]);
  field.value = "";
  dispatch("search");
  assert.deepEqual(ids(), ["water", "ss", "floss"]);
});

test("Enter does not interrupt IME composition, and completion applies the final query", async () => {
  for (const properties of [{ isComposing: true }, { keyCode: 229 }, {}]) {
    const { field, dispatch, ids } = await setup();
    dispatch("compositionstart");
    field.value = "SS";
    const event = dispatch("keydown", { key: "Enter", ...properties });
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(ids(), ["water", "ss", "floss"]);
    dispatch("compositionend");
    assert.deepEqual(ids(), ["ss"]);
  }
});

test("ordinary navigation keys retain their native behavior", async () => {
  const { field, dispatch, ids } = await setup();
  field.value = "SS";
  for (const key of ["ArrowLeft", "Tab", "Escape"]) {
    assert.equal(dispatch("keydown", { key }).defaultPrevented, false);
  }
  assert.deepEqual(ids(), ["water", "ss", "floss"]);
});

test("the catalog guard avoids replacing cards when an Add click commits an already-rendered query", async () => {
  const { bindCatalogSearch } = await helpers;
  const field = new EventTarget();
  field.value = "";
  const rendered = [];
  let query = "";
  bindCatalogSearch(field, (value) => {
    if (query === value) return;
    query = value;
    rendered.push(value);
  });
  field.value = "SS";
  field.dispatchEvent(new Event("input"));
  assert.deepEqual(rendered, ["SS"]);
  // A pointer click on Add blurs the input and commits its change before click.
  // Redrawing here moves the button between pointerdown and pointerup.
  for (const type of ["change", "search", "compositionend"])
    field.dispatchEvent(new Event(type));
  const enter = new Event("keydown", { cancelable: true });
  Object.assign(enter, { key: "Enter" });
  field.dispatchEvent(enter);
  assert.deepEqual(rendered, ["SS"]);
  field.value = "Mint floss";
  field.dispatchEvent(new Event("change"));
  assert.deepEqual(rendered, ["SS", "Mint floss"]);
});

test("Clear filters followed by the same pasted query applies the query again", async () => {
  const { bindCatalogSearch } = await helpers;
  const field = new EventTarget();
  field.value = "";
  let query = "";
  const rendered = [];
  bindCatalogSearch(field, (value) => {
    if (query === value) return;
    query = value;
    rendered.push(value);
  });
  field.value = "missing-product";
  field.dispatchEvent(new Event("input"));
  assert.equal(query, "missing-product");
  // Clear filters changes the visible field and applied query programmatically.
  query = "";
  field.value = "";
  field.value = "missing-product";
  field.dispatchEvent(new Event("input"));
  assert.equal(query, "missing-product");
  assert.deepEqual(rendered, ["missing-product", "missing-product"]);
});
