const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/phone-catalog.js");
const mod = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const cash = (cents) => `$${(cents / 100).toFixed(2)}`;
const variantsOf = (product) =>
  product.variants?.length ? [...product.variants] : [""];

test("the order bar never shows a total when a price is missing", async () => {
  const { orderBarLabel } = await mod;
  assert.deepEqual(orderBarLabel({ total: 16350, missing: [] }, 9, cash), {
    units: "9 items in this order",
    total: "$163.50",
  });
  assert.deepEqual(orderBarLabel({ total: 1850, missing: [] }, 1, cash), {
    units: "1 item in this order",
    total: "$18.50",
  });
  assert.deepEqual(
    orderBarLabel({ total: 1850, missing: ["New product"] }, 3, cash),
    { units: "3 items in this order", total: "Check items" },
  );
});

test("quantities are refused when the catalog changed under an open panel", async () => {
  const { assertOrderable } = await mod;
  const message = /This product's options changed/;
  const product = { id: "faygo", variants: ["grape", "orange"] };
  assert.doesNotThrow(() => assertOrderable(product, "orange", variantsOf));
  assert.doesNotThrow(() => assertOrderable({ id: "soda" }, "", variantsOf));
  assert.throws(() => assertOrderable(undefined, "orange", variantsOf), message);
  assert.throws(
    () => assertOrderable({ ...product, active: false }, "orange", variantsOf),
    message,
  );
  assert.throws(
    () => assertOrderable({ ...product, deleted: true }, "orange", variantsOf),
    message,
  );
  assert.throws(() => assertOrderable(product, "peach", variantsOf), message);
});

test("option counts read naturally for single and multi-option products", async () => {
  const { productSummary } = await mod;
  assert.equal(
    productSummary({ id: "a", variants: ["x", "y"] }, variantsOf),
    "2 options",
  );
  assert.equal(
    productSummary({ id: "a", variants: ["x"], packSize: 12 }, variantsOf),
    "1 option · 12 per case",
  );
  assert.equal(productSummary({ id: "a" }, variantsOf), "Single product");
});

test("a blank typed quantity restores the field and an unreadable one is refused", async () => {
  const { typedQuantity } = await mod;
  assert.equal(typedQuantity("12", true), 12);
  assert.equal(typedQuantity(" 0 ", true), 0);
  assert.equal(typedQuantity("", true), null);
  assert.equal(typedQuantity("   ", true), null);
  assert.throws(() => typedQuantity("", false), /whole number from 0 to 1,000,000/);
  assert.throws(() => typedQuantity("12", false), /whole number from 0 to 1,000,000/);
});

test("a quantity change is refused when the order was replaced since the catalog was drawn", async () => {
  const { assertSameDraft } = await mod;
  assert.doesNotThrow(() => assertSameDraft("draft-1", "draft-1"));
  assert.doesNotThrow(() => assertSameDraft(null, null));
  assert.throws(() => assertSameDraft("draft-1", "draft-2"), /Your order changed/);
  assert.throws(() => assertSameDraft("draft-1", null), /Your order changed/);
  assert.throws(() => assertSameDraft(null, "draft-2"), /Your order changed/);
});

test("minus explains itself when only a noted or case line holds the quantity", async () => {
  const { heldElsewhereMessage } = await mod;
  assert.equal(heldElsewhereMessage(2, 2), null);
  assert.equal(heldElsewhereMessage(1_000_000, 1_000_001), null);
  assert.equal(heldElsewhereMessage(0, -1), null);
  assert.match(
    heldElsewhereMessage(1, 0),
    /1 is in a line with a note or case unit\. Change it on the Order screen\./,
  );
  assert.match(
    heldElsewhereMessage(5, 2),
    /5 are in lines with a note or case unit\. Change them on the Order screen\./,
  );
});

test("the order panel lists each product then its lines", async () => {
  const { orderPanelRows } = await mod;
  assert.deepEqual(
    orderPanelRows([
      { name: "Faygo bottles", amount: "$55.50", lines: [
        { label: "redpop", quantity: 2, amount: "$37.00" },
        { label: "Mix", quantity: 1, amount: "Check item" },
      ] },
      { name: "Baking soda", amount: "$12.00", lines: [{ label: "", quantity: 1, amount: "$12.00" }] },
    ]),
    [
      { kind: "group", text: "Faygo bottles", amount: "$55.50" },
      { kind: "line", text: "2 × redpop", amount: "$37.00" },
      { kind: "line", text: "1 × Mix", amount: "Check item" },
      { kind: "group", text: "Baking soda", amount: "$12.00" },
      { kind: "line", text: "1", amount: "$12.00" },
    ],
  );
  assert.deepEqual(orderPanelRows(undefined), []);
});
