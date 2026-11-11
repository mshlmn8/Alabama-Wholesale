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
