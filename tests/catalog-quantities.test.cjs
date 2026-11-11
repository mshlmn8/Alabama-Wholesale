const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/catalog-quantities.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const line = (id, variant, quantity, extra = {}) => ({
  id,
  productId: "faygo",
  variant,
  quantity,
  unit: "each",
  note: "",
  ...extra,
});
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

test("a flavor's quantity sums its manual lines and ignores other products and mixes", async () => {
  const { variantQuantity, productQuantity, draftUnits } = await helpers;
  const lines = [
    line("a", "orange", 2),
    line("b", "orange", 3, { note: "cold" }),
    line("c", "orange", 1, { unit: "case" }),
    line("d", "grape", 4),
    line("m", "", 5, { selectionMode: "mix", allowedVariants: ["orange", "grape"] }),
    { ...line("x", "orange", 9), productId: "other" },
  ];
  assert.equal(variantQuantity(lines, "faygo", "orange"), 6);
  assert.equal(variantQuantity(lines, "faygo", "peach"), 0);
  assert.equal(productQuantity(lines, "faygo"), 15);
  assert.equal(draftUnits(lines), 24);
  assert.equal(draftUnits(undefined), 0);
});

test("plus raises the plain line or creates one without mutating the input", async () => {
  const { stepVariantQuantity } = await helpers;
  const lines = Object.freeze([
    Object.freeze(line("b", "orange", 3, { note: "cold" })),
    Object.freeze(line("a", "orange", 2)),
  ]);
  const raised = stepVariantQuantity(lines, "faygo", "orange", 1, ids());
  assert.deepEqual(raised.map((l) => [l.id, l.quantity]), [["b", 3], ["a", 3]]);
  const created = stepVariantQuantity(lines, "faygo", "grape", 1, ids());
  assert.deepEqual(created.at(-1), {
    id: "new-1",
    productId: "faygo",
    variant: "grape",
    quantity: 1,
    unit: "each",
    note: "",
  });
  assert.equal(lines.length, 2);
});

test("plus creates a plain line beside a noted one instead of changing the note's line", async () => {
  const { stepVariantQuantity } = await helpers;
  const lines = [line("b", "orange", 3, { note: "cold" })];
  const next = stepVariantQuantity(lines, "faygo", "orange", 1, ids());
  assert.deepEqual(next.map((l) => [l.id, l.quantity, l.note]), [
    ["b", 3, "cold"],
    ["new-1", 1, ""],
  ]);
});

test("plus stops at 1,000,000 and returns the same array", async () => {
  const { stepVariantQuantity } = await helpers;
  const lines = [line("a", "orange", 1_000_000)];
  assert.equal(stepVariantQuantity(lines, "faygo", "orange", 1, ids()), lines);
});

test("minus lowers the plain line first, then the last manual line, removing a line at zero", async () => {
  const { stepVariantQuantity } = await helpers;
  const lines = [
    line("n", "orange", 2, { note: "cold" }),
    line("a", "orange", 1),
  ];
  const once = stepVariantQuantity(lines, "faygo", "orange", -1, ids());
  assert.deepEqual(once.map((l) => [l.id, l.quantity]), [["n", 2]]);
  const twice = stepVariantQuantity(once, "faygo", "orange", -1, ids());
  assert.deepEqual(twice.map((l) => [l.id, l.quantity, l.note]), [["n", 1, "cold"]]);
  assert.deepEqual(stepVariantQuantity(twice, "faygo", "orange", -1, ids()), []);
});

test("minus never touches a Mix or Each line and returns the same array when nothing manual exists", async () => {
  const { stepVariantQuantity } = await helpers;
  const lines = [
    line("m", "", 5, { selectionMode: "mix", allowedVariants: ["orange"] }),
    line("e", "orange", 2, { selectionMode: "each", allowedVariants: ["orange"] }),
  ];
  assert.equal(stepVariantQuantity(lines, "faygo", "orange", -1, ids()), lines);
});

test("a typed quantity adjusts only the plain line and keeps noted and case lines", async () => {
  const { setVariantQuantity } = await helpers;
  const lines = [
    line("n", "orange", 2, { note: "cold" }),
    line("c", "orange", 1, { unit: "case" }),
    line("a", "orange", 4),
  ];
  const up = setVariantQuantity(lines, "faygo", "orange", 10, ids());
  assert.deepEqual(up.map((l) => [l.id, l.quantity]), [["n", 2], ["c", 1], ["a", 7]]);
  const low = setVariantQuantity(lines, "faygo", "orange", 1, ids());
  assert.deepEqual(low.map((l) => [l.id, l.quantity]), [["n", 2], ["c", 1]]);
  const fresh = setVariantQuantity([], "faygo", "orange", 6, ids());
  assert.deepEqual(fresh.map((l) => [l.id, l.quantity, l.unit, l.note]), [["new-1", 6, "each", ""]]);
  assert.deepEqual(setVariantQuantity([line("a", "orange", 4)], "faygo", "orange", 0, ids()), []);
  assert.equal(lines.length, 3);
});

test("a typed quantity equal to the current total returns the same array", async () => {
  const { setVariantQuantity } = await helpers;
  const lines = [line("a", "orange", 4)];
  assert.equal(setVariantQuantity(lines, "faygo", "orange", 4, ids()), lines);
});

test("typed quantities outside 0 to 1,000,000 or not whole are refused", async () => {
  const { setVariantQuantity } = await helpers;
  for (const bad of [-1, 1.5, 1_000_001, Number.NaN, "3"])
    assert.throws(
      () => setVariantQuantity([], "faygo", "orange", bad, ids()),
      /whole number from 0 to 1,000,000/,
    );
});
