const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/catalog-sort.js");
const mod = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const product = (id, name, createdAt) => ({ id, name, createdAt });
const catalog = Object.freeze([
  product("takis", "Takis", 300),
  product("arizona", "arizona", 100),
  product("item10", "Item 10", 200),
  product("item2", "Item 2", 200),
  product("undated", "Baking soda"),
]);
const ids = (list) => list.map((item) => item.id);

test("the sort choices are catalog order, newest, oldest, A–Z and last ordered", async () => {
  const { CATALOG_SORTS, normalizeCatalogSort } = await mod;
  assert.deepEqual(CATALOG_SORTS, [
    ["catalog", "Catalog order"],
    ["newest", "Newest first"],
    ["oldest", "Oldest first"],
    ["az", "A–Z"],
    ["lastOrdered", "Last ordered"],
  ]);
  for (const [value] of CATALOG_SORTS)
    assert.equal(normalizeCatalogSort(value), value);
  for (const unknown of [undefined, null, "", "za", 3, {}])
    assert.equal(normalizeCatalogSort(unknown), "catalog");
});

test("catalog order and unknown choices keep the given order in a new array", async () => {
  const { sortCatalogProducts } = await mod;
  const kept = sortCatalogProducts(catalog, "catalog");
  assert.deepEqual(ids(kept), ids(catalog));
  assert.notEqual(kept, catalog);
  assert.deepEqual(ids(sortCatalogProducts(catalog, "mystery")), ids(catalog));
});

test("newest and oldest sort by creation date; ties and undated products keep catalog order", async () => {
  const { sortCatalogProducts } = await mod;
  assert.deepEqual(ids(sortCatalogProducts(catalog, "newest")), [
    "takis",
    "item10",
    "item2",
    "arizona",
    "undated",
  ]);
  assert.deepEqual(ids(sortCatalogProducts(catalog, "oldest")), [
    "arizona",
    "item10",
    "item2",
    "takis",
    "undated",
  ]);
});

test("A–Z ignores case and reads numbers as numbers", async () => {
  const { sortCatalogProducts } = await mod;
  assert.deepEqual(ids(sortCatalogProducts(catalog, "az")), [
    "arizona",
    "undated",
    "item2",
    "item10",
    "takis",
  ]);
});

test("last ordered lists the most recently ordered first and never-ordered products after them", async () => {
  const { sortCatalogProducts } = await mod;
  const lastOrdered = new Map([
    ["item2", 50],
    ["arizona", 90],
    ["undated", 50],
  ]);
  assert.deepEqual(ids(sortCatalogProducts(catalog, "lastOrdered", lastOrdered)), [
    "arizona",
    "item2",
    "undated",
    "takis",
    "item10",
  ]);
  assert.deepEqual(ids(sortCatalogProducts(catalog, "lastOrdered")), ids(catalog));
  assert.deepEqual(ids(catalog), ["takis", "arizona", "item10", "item2", "undated"]);
});

test("the last-ordered index reads only this store's submitted orders", async () => {
  const { lastOrderedIndex } = await mod;
  const day = (text) => new Date(text).valueOf();
  const orders = [
    { storeId: "shop", status: "delivered", createdAt: 10, lines: [{ productId: "takis" }, { productId: "arizona" }] },
    { storeId: "shop", status: "submitted", createdAt: 30, lines: [{ productId: "takis" }] },
    { storeId: "shop", status: "submitted", date: "2026-11-04", createdAt: 5, lines: [{ itemId: "legacy" }] },
    { storeId: "shop", status: "draft", createdAt: 99, lines: [{ productId: "draft-only" }] },
    { storeId: "shop", status: "cancelled", createdAt: 99, lines: [{ productId: "cancelled-only" }] },
    { storeId: "shop", status: "submitted", deleted: true, createdAt: 99, lines: [{ productId: "deleted-only" }] },
    { storeId: "other", status: "submitted", createdAt: 99, lines: [{ productId: "arizona" }] },
    { storeId: "shop", status: "submitted", createdAt: 40 },
  ];
  const index = lastOrderedIndex(orders, "shop");
  assert.deepEqual(
    [...index].sort(([a], [b]) => a.localeCompare(b)),
    [
      ["arizona", 10],
      ["legacy", day("2026-11-04")],
      ["takis", 30],
    ],
  );
  assert.equal(lastOrderedIndex(undefined, "shop").size, 0);
});
