const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const helper = import("data:text/javascript;base64," + Buffer.from(fs.readFileSync(path.join(__dirname, "../public/category-navigation.js"), "utf8")).toString("base64"));
const migration = (kind) => ({ sourcePath: `state/data/${kind}/0`, sourceHash: "a".repeat(64) });
const root = (values = {}) => ({ id: "drinks", name: "DRINKS & BAGS", version: 1, migration: migration("categories"), ...values });
const product = (values = {}) => ({ id: "water", name: "Water bottle", categoryIds: ["drinks"], version: 1, migration: migration("items"), ...values });

test("legacy saved subcategories become navigable children with exact memberships without changing server data", async () => {
  const { catalogCategoryHierarchy, categoryFilterIds, categoryTrail } = await helper;
  const categories = [root({ subcategories: ["Waters", "Custom label"] })];
  const products = [product({ subcategory: "Custom label" }), product({ id: "mismatch", subcategory: "Chips" })];
  const before = JSON.stringify({ categories, products });
  const hierarchy = catalogCategoryHierarchy(categories, products);
  const custom = hierarchy.categories.find((item) => item.name === "Custom label");
  assert.ok(custom);
  assert.equal(custom.parentId, "drinks");
  assert.deepEqual(categoryTrail(hierarchy.categories, custom.id).map((item) => item.id), ["drinks", custom.id]);
  assert.deepEqual(hierarchy.productCategoryIds.get("water"), ["drinks", custom.id]);
  assert.deepEqual(hierarchy.productCategoryIds.get("mismatch"), ["drinks"]);
  assert.ok(categoryFilterIds(hierarchy.categories, "drinks").has(custom.id));
  assert.equal(JSON.stringify({ categories, products }), before);
  assert.equal(catalogCategoryHierarchy(categories, products).categories.find((item) => item.name === "Custom label").id, custom.id);
});

test("unchanged migrated records recover the original fallback taxonomy and ordered classifier", async () => {
  const { catalogCategoryHierarchy } = await helper;
  const hierarchy = catalogCategoryHierarchy([root()], [product(), product({ id: "energy", name: "Monster energy water" })]);
  assert.deepEqual(hierarchy.categories.filter((item) => item.parentId === "drinks").map((item) => item.name), ["Cheap Drinks", "Energy Drinks", "Sodas", "Juices", "Imported Drinks", "Waters"]);
  const water = hierarchy.categories.find((item) => item.name === "Waters");
  const energy = hierarchy.categories.find((item) => item.name === "Energy Drinks");
  assert.deepEqual(hierarchy.productCategoryIds.get("water"), ["drinks", water.id]);
  assert.deepEqual(hierarchy.productCategoryIds.get("energy"), ["drinks", energy.id]);
});

test("new and edited products stay in their saved categories instead of being guessed from names", async () => {
  const { catalogCategoryHierarchy } = await helper;
  const products = [product({ id: "new", migration: undefined }), product({ id: "edited", version: 2, updatedBy: "owner" }), product({ id: "invalid", migration: { sourceHash: "invalid" } }), product({ id: "malformed", migration: { sourceHash: "a".repeat(64), sourcePath: {} } })];
  const hierarchy = catalogCategoryHierarchy([root()], products);
  for (const item of products) assert.deepEqual(hierarchy.productCategoryIds.get(item.id), ["drinks"]);
  assert.deepEqual(catalogCategoryHierarchy([root({ version: 2, updatedBy: "owner" })], [product()]).categories.length, 1);
});

test("modern child categories and explicit descendant memberships remain authoritative", async () => {
  const { catalogCategoryHierarchy } = await helper;
  const categories = [root({ subcategories: ["Waters", "Old label"] }), { id: "water-child", name: "Waters", parentId: "drinks" }, { id: "juice", name: "Juices", parentId: "drinks" }];
  const hierarchy = catalogCategoryHierarchy(categories, [product({ categoryIds: ["drinks", "juice"], subcategory: "Waters" }), product({ id: "explicit", subcategory: "Waters" }), product({ id: "inferred" })]);
  assert.equal(hierarchy.categories.length, categories.length);
  assert.deepEqual(hierarchy.productCategoryIds.get("water"), ["drinks", "juice"]);
  assert.deepEqual(hierarchy.productCategoryIds.get("explicit"), ["drinks", "water-child"]);
  assert.deepEqual(hierarchy.productCategoryIds.get("inferred"), ["drinks"]);
});

test("ambiguous children, inactive categories, and malformed labels do not invent memberships", async () => {
  const { catalogCategoryHierarchy } = await helper;
  const ambiguous = catalogCategoryHierarchy([root(), { id: "a", name: "Waters", parentId: "drinks" }, { id: "b", name: "waters", parentId: "drinks" }], [product({ subcategory: "Waters" })]);
  assert.deepEqual(ambiguous.productCategoryIds.get("water"), ["drinks"]);
  const inactive = catalogCategoryHierarchy([root({ active: false })], [product()]);
  assert.equal(inactive.categories.length, 0);
  const custom = catalogCategoryHierarchy([root({ name: "Custom", migration: undefined, subcategories: [null, "", "Bad\nlabel", "Known", "Known"] })], [product({ subcategory: "Known" })]);
  assert.deepEqual(custom.categories.map((item) => item.name), ["Custom", "Known"]);
});
