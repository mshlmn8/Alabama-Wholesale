const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const helpers = import(
  "data:text/javascript;base64," +
    Buffer.from(
      fs.readFileSync(
        path.join(__dirname, "../public/view-helpers.js"),
        "utf8",
      ),
    ).toString("base64")
);

test("short SS searches put the exact name first and exclude incidental suffixes", async () => {
  const { indexCatalogProducts, rankCatalogProducts } = await helpers;
  const index = indexCatalogProducts([
    { id: "glass", name: "Glass cleaner" },
    { id: "floss", name: "Mint floss" },
    { id: "prefix", name: "SS Cigarillos" },
    { id: "token", name: "Premium SS wraps" },
    { id: "sku", name: "Special wrap", sku: "ss" },
    { id: "exact", name: "SS" },
    { id: "brand", name: "Regular wrap", brand: "SS" },
  ]);
  assert.deepEqual(
    rankCatalogProducts(index, " sS ").map((p) => p.id),
    ["exact", "sku", "brand", "prefix", "token"],
  );
  assert.deepEqual(
    rankCatalogProducts(index, "loss").map((p) => p.id),
    ["floss"],
  );
});

test("exact barcode and SKU matches outrank name prefixes and retain case-insensitive punctuation", async () => {
  const { indexCatalogProducts, rankCatalogProducts } = await helpers;
  const index = indexCatalogProducts([
    { id: "prefix", name: "AB-12 large" },
    { id: "sku", name: "Drink", sku: "AB-12" },
    { id: "barcode", name: "Other drink", variantBarcodes: { Lime: "0099" } },
  ]);
  assert.deepEqual(
    rankCatalogProducts(index, "ab-12").map((p) => p.id),
    ["sku", "prefix"],
  );
  assert.deepEqual(
    rankCatalogProducts(index, "0099").map((p) => p.id),
    ["barcode"],
  );
});

test("multiword search matches across product and flavor tokens with stable ties", async () => {
  const { indexCatalogProducts, rankCatalogProducts } = await helpers;
  const products = [
    { id: "a", name: "SS", variants: ["Grape", "Mint"] },
    { id: "b", name: "SS", variants: ["Grape"] },
    { id: "c", name: "SS", variants: ["Lime"] },
  ];
  const before = JSON.stringify(products);
  const index = indexCatalogProducts(products);
  assert.deepEqual(
    rankCatalogProducts(index, "ss gra").map((p) => p.id),
    ["a", "b"],
  );
  assert.deepEqual(
    rankCatalogProducts(index, "").map((p) => p.id),
    ["a", "b", "c"],
  );
  assert.equal(JSON.stringify(products), before);
});

test("catalog layout accepts only supported device column and density choices", async () => {
  const { normalizeCatalogLayout } = await helpers;
  assert.deepEqual(normalizeCatalogLayout(null, 2), {
    view: "list",
    columns: 2,
    compact: true,
  });
  assert.deepEqual(normalizeCatalogLayout({ columns: 5, compact: false }, 4), {
    view: "list",
    columns: 5,
    compact: false,
  });
  assert.deepEqual(normalizeCatalogLayout({ columns: 99, compact: true }, 4), {
    view: "list",
    columns: 4,
    compact: true,
  });
  assert.deepEqual(normalizeCatalogLayout({ columns: "3" }, 2), {
    view: "list",
    columns: 3,
    compact: true,
  });
});

test("catalog view preserves saved grid density while safely defaulting legacy preferences to list", async () => {
  const { normalizeCatalogLayout } = await helpers;
  const raw = { columns: 5, compact: false };
  const list = normalizeCatalogLayout(raw);
  assert.equal(list.view, "list");
  const grid = normalizeCatalogLayout({ ...list, view: "grid" });
  assert.deepEqual(grid, { view: "grid", columns: 5, compact: false });
  assert.deepEqual(normalizeCatalogLayout({ ...grid, view: "list" }), list);
  assert.equal(normalizeCatalogLayout({ view: "invalid" }).view, "list");
  assert.deepEqual(raw, { columns: 5, compact: false });
});
