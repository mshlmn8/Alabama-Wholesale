const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/catalog-photo-edit.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const product = {
  id: "juice",
  name: "Tropicana small",
  version: 7,
  variants: ["Apple"],
  priceCents: 1750,
  variantPricesCents: { Apple: 1800 },
  variantBarcodes: { Apple: "111" },
  barcode: "222",
  packSize: 12,
  sku: "TROP",
  categoryIds: ["drinks"],
  taxable: true,
  stockStatus: "low",
  image: "/assets/juice.png",
  imageSource: { page: "https://example.test/juice" },
  active: true,
};
const details = {
  name: "Unwanted rename",
  variant: "Cranberry",
  barcode: "333",
  packSize: 24,
};

test("a photo variant appends only variant and its barcode while preserving the parent", async () => {
  const { preparePhotoProduct } = await helpers;
  assert.equal(typeof preparePhotoProduct, "function");
  const before = structuredClone(product);
  const result = preparePhotoProduct({
    productId: "juice",
    details,
    products: [product],
  });
  assert.deepEqual(result, {
    ...product,
    variants: ["Apple", "Cranberry"],
    variantBarcodes: { Apple: "111", Cranberry: "333" },
  });
  assert.deepEqual(product, before);
});
test("new product prefill has no invented price and assigns a flavor barcode correctly", async () => {
  const { preparePhotoProduct } = await helpers;
  const result = preparePhotoProduct({
    details: { ...details, name: "Tropicana small" },
    products: [],
  });
  assert.equal(result.name, "Tropicana small");
  assert.equal(result.priceCents, null);
  assert.deepEqual(result.variantPricesCents, {});
  assert.equal(result.barcode, "");
  assert.deepEqual(result.variantBarcodes, { Cranberry: "333" });
  assert.equal(result.packSize, 24);
  assert.equal(result.id, undefined);
  assert.deepEqual(result.categoryIds, []);
});
test("duplicate variants, barcodes and missing parents are rejected before review", async () => {
  const { preparePhotoProduct } = await helpers;
  assert.throws(
    () =>
      preparePhotoProduct({
        productId: "juice",
        details: { ...details, variant: "  aPpLe " },
        products: [product],
      }),
    /already.*variant|variant.*already/i,
  );
  assert.throws(
    () =>
      preparePhotoProduct({
        details: { ...details, barcode: "111" },
        products: [product],
      }),
    /barcode.*already/i,
  );
  assert.throws(
    () =>
      preparePhotoProduct({
        productId: "missing",
        details,
        products: [product],
      }),
    /no longer|unavailable/i,
  );
  assert.throws(
    () =>
      preparePhotoProduct({
        productId: "juice",
        details: { ...details, variant: "" },
        products: [product],
      }),
    /variant.*required/i,
  );
});
test("review values are bounded and cannot smuggle price or product identity changes", async () => {
  const { preparePhotoProduct } = await helpers;
  const result = preparePhotoProduct({
    details: { ...details, id: "injected", priceCents: 1, active: false },
    products: [],
  });
  assert.equal(result.id, undefined);
  assert.equal(result.priceCents, null);
  assert.equal(result.active, true);
  for (const variant of [
    "__proto__",
    "constructor",
    "prototype",
    "x".repeat(201),
  ])
    assert.throws(() =>
      preparePhotoProduct({
        productId: "juice",
        details: { ...details, variant },
        products: [product],
      }),
    );
  assert.throws(() =>
    preparePhotoProduct({
      details: { ...details, packSize: 2.5 },
      products: [],
    }),
  );
  assert.throws(() =>
    preparePhotoProduct({ details: { ...details, name: "" }, products: [] }),
  );
});
