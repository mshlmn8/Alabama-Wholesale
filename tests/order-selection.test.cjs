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

test("flavor choices sort alphabetically with numeric names and base sensitivity without mutating the catalog", async () => {
  const { productVariants } = await helpers;
  const variants = Object.freeze([
    "Zebra",
    "Flavor 10",
    "apple",
    "Flavor 2",
    "Ápple",
  ]);
  const catalogProduct = Object.freeze({ id: "sorted", variants });
  const result = productVariants(catalogProduct);
  assert.deepEqual(result, [
    "apple",
    "Ápple",
    "Flavor 2",
    "Flavor 10",
    "Zebra",
  ]);
  assert.notEqual(result, variants);
  assert.deepEqual(variants, [
    "Zebra",
    "Flavor 10",
    "apple",
    "Flavor 2",
    "Ápple",
  ]);
});

test("quantities follow the displayed alphabetical flavor order with optional Standard first", async () => {
  const { productVariants, selectedProductLines } = await helpers;
  const unsorted = Object.freeze({
    ...product,
    variants: Object.freeze(["orange", "apple", "cranberry"]),
  });
  for (const standardVariantEnabled of [false, true]) {
    const item = { ...unsorted, standardVariantEnabled };
    const quantities = Object.freeze(
      standardVariantEnabled ? ["4", "2", "0", "7"] : ["2", "0", "7"],
    );
    assert.deepEqual(productVariants(item), [
      ...(standardVariantEnabled ? [""] : []),
      "apple",
      "cranberry",
      "orange",
    ]);
    assert.deepEqual(
      selectedProductLines(item, quantities, "each").map((line) => [
        line.variant,
        line.quantity,
      ]),
      [
        ...(standardVariantEnabled ? [["", 4]] : []),
        ["apple", 2],
        ["orange", 7],
      ],
    );
  }
  assert.deepEqual(unsorted.variants, ["orange", "apple", "cranberry"]);
});

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

test("products that gained flavors retain Standard without changing named variants", async () => {
  const { productVariants, selectedProductLines } = await helpers;
  const mixed = { ...product, standardVariantEnabled: true };
  const before = structuredClone(mixed);
  assert.deepEqual(productVariants(mixed), ["", ...product.variants]);
  assert.deepEqual(
    selectedProductLines(mixed, ["2", "0", "3", "0"], "each").map((line) => [
      line.variant,
      line.quantity,
    ]),
    [
      ["", 2],
      ["cranberry", 3],
    ],
  );
  assert.deepEqual(mixed, before);
  assert.deepEqual(
    productVariants({ ...mixed, standardVariantEnabled: "true" }),
    product.variants,
  );
  assert.deepEqual(
    productVariants({ variants: [], standardVariantEnabled: true }),
    [""],
  );
});

function draftLine(overrides = {}) {
  return {
    id: "apple-line",
    productId: "tropicana",
    variant: "apple",
    quantity: 2,
    unit: "each",
    note: "",
    ...overrides,
  };
}

function selection(overrides = {}) {
  const { id, ...line } = draftLine(overrides);
  return line;
}

function freezeLines(lines) {
  lines.forEach(Object.freeze);
  return Object.freeze(lines);
}

test("draft groups follow first product appearance and sort flavors while retaining every original line", async () => {
  const { groupDraftLines } = await helpers;
  assert.equal(typeof groupDraftLines, "function");
  const lines = freezeLines([
    draftLine({ note: "Cold", originalPriceCents: 123 }),
    draftLine({ id: "other", productId: "__proto__", variant: "" }),
    draftLine({ id: "orange", variant: "orange", unit: "case" }),
    draftLine({ id: "again", note: "Separate bag" }),
  ]);
  const before = structuredClone(lines);
  const grouped = groupDraftLines(lines);
  assert.deepEqual(grouped, [
    { productId: "tropicana", lines: [lines[0], lines[3], lines[2]] },
    { productId: "__proto__", lines: [lines[1]] },
  ]);
  assert.equal(grouped[0].lines[0], lines[0]);
  assert.equal(grouped[0].lines[1], lines[3]);
  assert.deepEqual(lines, before);
  assert.deepEqual(groupDraftLines([]), []);
});

test("display grouping keeps legacy duplicates, Standard, quantities and price snapshots unchanged", async () => {
  const { groupDraftLines } = await helpers;
  const lines = freezeLines([
    draftLine({
      id: "ten",
      variant: "Flavor 10",
      unit: "case",
      quantity: 8,
      unitPriceCents: 1200,
    }),
    draftLine({
      id: "same-first",
      variant: "apple",
      note: "First bag",
      unit: "case",
      quantity: 2,
    }),
    draftLine({ id: "other", productId: "other", variant: "Orange" }),
    draftLine({ id: "two", variant: "Flavor 2" }),
    draftLine({
      id: "same-last",
      variant: "Ápple",
      note: "Second bag",
      unit: "each",
      quantity: 3,
    }),
    draftLine({
      id: "standard",
      variant: "",
      packSize: 12,
      unitPriceCents: 500,
    }),
    draftLine({ id: "legacy-standard", variant: undefined }),
  ]);
  const before = structuredClone(lines);
  const grouped = groupDraftLines(lines);
  assert.deepEqual(
    grouped.map((group) => group.productId),
    ["tropicana", "other"],
  );
  const expected = [lines[5], lines[6], lines[1], lines[4], lines[3], lines[0]];
  assert.deepEqual(grouped[0].lines, expected);
  expected.forEach((line, index) =>
    assert.equal(grouped[0].lines[index], line),
  );
  assert.deepEqual(lines, before);
});

test("adding the same flavor changes quantity while preserving its ID and metadata", async () => {
  const { addSelectedProductLines } = await helpers;
  assert.equal(typeof addSelectedProductLines, "function");
  const lines = freezeLines([
    draftLine({ note: undefined, originalPriceCents: 123, warning: "Review" }),
  ]);
  const additions = freezeLines([selection({ quantity: 3 })]);
  const result = addSelectedProductLines(lines, additions, () => {
    assert.fail("A merged line must not allocate an ID");
  });
  assert.deepEqual(result, [{ ...lines[0], quantity: 5 }]);
  assert.equal(lines[0].quantity, 2);
  assert.equal(additions[0].quantity, 3);
  assert.notEqual(result, lines);
});

test("only the first exact match gains quantity; old rows with different notes or units remain separate", async () => {
  const { addSelectedProductLines } = await helpers;
  const lines = freezeLines([
    draftLine(),
    draftLine({ id: "same-again" }),
    draftLine({ id: "case", unit: "case" }),
    draftLine({ id: "cold", note: "Cold" }),
    draftLine({ id: "spaced", note: " Cold " }),
  ]);
  const result = addSelectedProductLines(
    lines,
    [selection({ quantity: 3 }), selection({ quantity: 4, note: "Cold" })],
    () => assert.fail("Existing rows cover both selections"),
  );
  assert.deepEqual(
    result.map((line) => line.quantity),
    [5, 2, 2, 6, 2],
  );
  assert.deepEqual(
    result.map((line) => line.id),
    lines.map((line) => line.id),
  );
  assert.deepEqual(
    lines.map((line) => line.quantity),
    [2, 2, 2, 2, 2],
  );
});

test("new flavors append in selection order and repeated additions share one new ID", async () => {
  const { addSelectedProductLines } = await helpers;
  let generated = 0;
  const additions = freezeLines([
    selection({ variant: "orange", quantity: 3 }),
    selection({ variant: "orange", quantity: 4, note: undefined }),
    selection({ productId: "jumex", variant: "mango", quantity: 1 }),
    selection({ variant: "apple", unit: "case", quantity: 2 }),
  ]);
  const result = addSelectedProductLines(
    freezeLines([draftLine()]),
    additions,
    () => "generated-" + ++generated,
  );
  assert.equal(generated, 3);
  assert.deepEqual(
    result.map((line) => [
      line.id,
      line.productId,
      line.variant,
      line.unit,
      line.quantity,
    ]),
    [
      ["apple-line", "tropicana", "apple", "each", 2],
      ["generated-1", "tropicana", "orange", "each", 7],
      ["generated-2", "jumex", "mango", "each", 1],
      ["generated-3", "tropicana", "apple", "case", 2],
    ],
  );
});

test("merge identity cannot confuse punctuation across product and variant fields", async () => {
  const { addSelectedProductLines } = await helpers;
  const result = addSelectedProductLines(
    [draftLine({ productId: "a~b", variant: "c" })],
    [selection({ productId: "a", variant: "b~c" })],
    () => "separate",
  );
  assert.equal(result.length, 2);
  assert.equal(result[0].quantity, 2);
});

test("merged quantities may reach the order limit but never exceed it", async () => {
  const { addSelectedProductLines } = await helpers;
  const lines = freezeLines([draftLine({ quantity: 999_999 })]);
  assert.equal(
    addSelectedProductLines(lines, [selection({ quantity: 1 })])[0].quantity,
    1_000_000,
  );
  assert.throws(
    () => addSelectedProductLines(lines, [selection({ quantity: 2 })]),
    /quantity.*1,000,000/i,
  );
  assert.throws(
    () =>
      addSelectedProductLines(
        [],
        [selection({ quantity: 1_000_000 }), selection({ quantity: 1 })],
        () => "unused",
      ),
    /quantity.*1,000,000/i,
  );
  assert.equal(lines[0].quantity, 999_999);
});

test("invalid additions reject atomically before any new ID is requested", async () => {
  const { addSelectedProductLines } = await helpers;
  assert.equal(typeof addSelectedProductLines, "function");
  const lines = freezeLines([draftLine()]);
  const invalid = [
    null,
    [],
    selection({ productId: "" }),
    selection({ productId: 4 }),
    selection({ variant: 4 }),
    selection({ unit: "pallet" }),
    selection({ note: {} }),
    ...[
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      "3",
      true,
      null,
      1_000_001,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((quantity) => selection({ quantity })),
  ];
  for (const addition of invalid) {
    assert.throws(
      () =>
        addSelectedProductLines(
          lines,
          [selection({ variant: "orange" }), addition],
          () => assert.fail("Do not allocate IDs before validation"),
        ),
      /product|flavor|variant|unit|note|quantity|selection|line/i,
    );
  }
  assert.deepEqual(lines, [draftLine()]);
});

test("large selections have no arbitrary line count cap and still merge matching rows", async () => {
  const { addSelectedProductLines } = await helpers;
  const lines = freezeLines(
    Array.from({ length: 1100 }, (_, index) =>
      draftLine({ id: "line-" + index, variant: "flavor-" + index }),
    ),
  );
  const result = addSelectedProductLines(
    lines,
    [
      selection({ variant: "flavor-1099", quantity: 4 }),
      selection({ variant: "new-flavor", quantity: 3 }),
    ],
    () => "line-1100",
  );
  assert.equal(result.length, 1101);
  assert.equal(result[1099].quantity, 6);
  assert.equal(result[1100].quantity, 3);
  assert.equal(result[1100].id, "line-1100");
  assert.equal(lines[1099].quantity, 2);
});

test("ID collisions or invalid generated IDs never change the original draft", async () => {
  const { addSelectedProductLines } = await helpers;
  const lines = freezeLines([draftLine()]);
  for (const id of ["apple-line", "", null, 2]) {
    assert.throws(
      () =>
        addSelectedProductLines(
          lines,
          [selection({ variant: "orange" })],
          () => id,
        ),
      /id|identifier/i,
    );
  }
  assert.throws(
    () =>
      addSelectedProductLines(
        lines,
        [selection({ variant: "orange" }), selection({ variant: "cranberry" })],
        () => "same-new-id",
      ),
    /id|identifier/i,
  );
  assert.deepEqual(lines, [draftLine()]);
});

test("empty additions preserve all existing rows without needing an ID factory", async () => {
  const { addSelectedProductLines } = await helpers;
  const lines = freezeLines([draftLine(), draftLine({ id: "same-again" })]);
  assert.deepEqual(addSelectedProductLines(lines, []), lines);
  assert.deepEqual(addSelectedProductLines([], []), []);
  assert.throws(() => addSelectedProductLines(lines, null), /selection|line/i);
});
