const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/order-selection.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const product = {
  id: "tropicana",
  variants: ["apple", "cranberry", "orange"],
  packSize: 12,
};

test("two flavors become separate lines and unselected flavors are omitted", async () => {
  const { selectedProductLines } = await helpers;
  assert.equal(typeof selectedProductLines, "function");
  assert.deepEqual(
    selectedProductLines(product, ["2", "2", "0"], "each", "  Deliver cold  "),
    [
      {
        productId: "tropicana",
        variant: "apple",
        quantity: 2,
        unit: "each",
        note: "Deliver cold",
      },
      {
        productId: "tropicana",
        variant: "cranberry",
        quantity: 2,
        unit: "each",
        note: "Deliver cold",
      },
    ],
  );
});
test("an invalid flavor quantity rejects the entire selection", async () => {
  const { selectedProductLines } = await helpers;
  for (const quantity of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.throws(
      () => selectedProductLines(product, ["2", quantity, "0"], "each"),
      /cranberry.*whole number/i,
    );
  }
});
test("empty selections cannot create an empty draft edit", async () => {
  const { selectedProductLines } = await helpers;
  assert.throws(
    () => selectedProductLines(product, ["0", "", "0"], "each"),
    /choose.*quantity/i,
  );
});
test("quantities stay within the online order limit", async () => {
  const { selectedProductLines } = await helpers;
  assert.throws(
    () => selectedProductLines(product, ["1000001", "0", "0"], "each"),
    /1,000,000/,
  );
  assert.equal(
    selectedProductLines(product, ["1000000", "0", "0"], "each")[0].quantity,
    1000000,
  );
});
test("standard products and cases preserve the existing line contract", async () => {
  const { selectedProductLines } = await helpers;
  assert.deepEqual(selectedProductLines({ id: "standard" }, ["3"], "each"), [
    { productId: "standard", variant: "", quantity: 3, unit: "each", note: "" },
  ]);
  assert.equal(
    selectedProductLines(product, ["", "2", "0"], "case")[0].quantity,
    2,
  );
  assert.throws(
    () => selectedProductLines({ id: "standard" }, ["1"], "case"),
    /case/i,
  );
});
