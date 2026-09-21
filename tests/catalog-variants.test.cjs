const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/catalog-variants.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});

test("renamed and new rows retain their own price and barcode without mutating input", async () => {
  const { serializeCatalogVariants } = await helpers;
  assert.equal(typeof serializeCatalogVariants, "function");
  const rows = [
    { name: " Green Apple ", priceCents: 1234, barcode: " 0011 " },
    { name: "Cranberry", priceCents: 0, barcode: "0022" },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(serializeCatalogVariants(rows), {
    variants: ["Green Apple", "Cranberry"],
    variantPricesCents: { "Green Apple": 1234, Cranberry: 0 },
    variantBarcodes: { "Green Apple": "0011", Cranberry: "0022" },
  });
  assert.deepEqual(rows, before);
});
test("removed rows produce no orphan price/barcode and empty rows mean standard product", async () => {
  const { serializeCatalogVariants } = await helpers;
  assert.equal(typeof serializeCatalogVariants, "function");
  assert.deepEqual(
    serializeCatalogVariants([
      { name: "Apple", priceCents: null, barcode: "" },
    ]),
    { variants: ["Apple"], variantPricesCents: {}, variantBarcodes: {} },
  );
  assert.deepEqual(serializeCatalogVariants([]), {
    variants: [],
    variantPricesCents: {},
    variantBarcodes: {},
  });
});
test("ambiguous duplicate names are rejected instead of silently merged", async () => {
  const { serializeCatalogVariants } = await helpers;
  assert.equal(typeof serializeCatalogVariants, "function");
  for (const names of [
    ["Apple", " apple "],
    ["Green Apple", "green  apple"],
    ["Apple", "Ａｐｐｌｅ"],
  ])
    assert.throws(
      () =>
        serializeCatalogVariants(
          names.map((name) => ({ name, priceCents: null, barcode: "" })),
        ),
      /already exists/i,
    );
});
test("empty, overlong, control and reserved variant names are rejected", async () => {
  const { serializeCatalogVariants } = await helpers;
  assert.equal(typeof serializeCatalogVariants, "function");
  for (const name of [
    "",
    " ",
    "x".repeat(201),
    "Apple\nJuice",
    "__proto__",
    "Constructor",
    "prototype",
  ])
    assert.throws(
      () => serializeCatalogVariants([{ name, priceCents: null, barcode: "" }]),
      /variant/i,
    );
});
test("variant count, money and barcode bounds match product storage", async () => {
  const { serializeCatalogVariants } = await helpers;
  assert.equal(typeof serializeCatalogVariants, "function");
  const rows = Array.from({ length: 200 }, (_, i) => ({
    name: `Flavor ${i}`,
    priceCents: null,
    barcode: "",
  }));
  assert.equal(serializeCatalogVariants(rows).variants.length, 200);
  assert.throws(
    () =>
      serializeCatalogVariants([
        ...rows,
        { name: "Overflow", priceCents: null, barcode: "" },
      ]),
    /200/,
  );
  for (const priceCents of [-1, 1.5, NaN, Infinity, 1_000_000_000_001])
    assert.throws(
      () =>
        serializeCatalogVariants([{ name: "Apple", priceCents, barcode: "" }]),
      /price/i,
    );
  assert.throws(
    () =>
      serializeCatalogVariants([
        { name: "Apple", priceCents: null, barcode: "x".repeat(201) },
      ]),
    /barcode/i,
  );
});

test("inline flavor creation sends only versioned variant fields and preserves existing overrides", async () => {
  const { prepareCatalogVariant } = await helpers;
  assert.equal(typeof prepareCatalogVariant, "function");
  const product = {
    id: "juice",
    version: 7,
    name: "Juice",
    variants: ["Apple", "Orange"],
    variantPricesCents: { Apple: 175 },
    variantBarcodes: { Orange: "001" },
    priceCents: 150,
    packSize: 12,
    categoryIds: ["drinks"],
  };
  const before = structuredClone(product);
  assert.deepEqual(
    prepareCatalogVariant(product, {
      name: " Grape ",
      priceCents: 200,
      barcode: " 002 ",
    }),
    {
      id: "juice",
      expectedVersion: 7,
      variants: ["Apple", "Orange", "Grape"],
      variantPricesCents: { Apple: 175, Grape: 200 },
      variantBarcodes: { Orange: "001", Grape: "002" },
    },
  );
  assert.deepEqual(product, before);
});

test("the first inline flavor inherits base price and leaves Standard compatibility to the server", async () => {
  const { prepareCatalogVariant } = await helpers;
  assert.equal(typeof prepareCatalogVariant, "function");
  assert.deepEqual(prepareCatalogVariant({ id: "plain", version: 3 }, { name: "Grape" }), {
    id: "plain",
    expectedVersion: 3,
    variants: ["Grape"],
    variantPricesCents: {},
    variantBarcodes: {},
  });
});

test("inline flavors reject unavailable parents and normalized duplicates", async () => {
  const { prepareCatalogVariant } = await helpers;
  assert.equal(typeof prepareCatalogVariant, "function");
  for (const product of [null, {}, { id: "gone", deleted: true }, { id: "off", active: false }])
    assert.throws(() => prepareCatalogVariant(product, { name: "Grape" }), /available/i);
  for (const name of [" grape ", "Ｇｒａｐｅ"])
    assert.throws(() => prepareCatalogVariant({ id: "juice", variants: ["Grape"] }, { name }), /already exists/i);
});
