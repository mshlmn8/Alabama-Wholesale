const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getLegacySubcategories,
  getLegacySubcategory,
} = require("../lib/legacy-subcategories.cjs");

test("restores every legacy category's ordered default subcategory list", () => {
  const expected = {
    TOBACCO: ["Cigarillos", "Paper / Wraps", "Loose tobacco", "Pouches", "Cigarettes"],
    NOVELTIES: ["Electronic Vapes", "Disposables", "Recreationals", "Edibles", "Tobacco Use", "Shishas", "Home Use"],
    MERCHANDISE: ["Medicines", "Condoms", "Energy shots", "Enhancement Supplements", "Lighters & Gas", "Chargers", "Fragrance Products", "Consumer Products"],
    CANDIES: ["Chocolates", "Change Candies", "Gums", "Hanging Bags", "Toy Candies", "Candy"],
    "FOOD STUFF": ["Cooking Material", "Cookies", "Noodles", "Chips", "Pickles", "Crackers", "Condiments", "Cereals"],
    GROCERY: ["Plastics & Tissues", "Dishwasher & Cleaners", "Care", "Bags & Papers", "Dog / Cat", "Kitchen & Home"],
    "MOTOR OIL": ["Engine Oils & Fluids", "Other Items"],
    "DRINKS & BAGS": ["Cheap Drinks", "Energy Drinks", "Sodas", "Juices", "Imported Drinks", "Waters"],
  };
  for (const [name, subcategories] of Object.entries(expected)) {
    assert.deepEqual(getLegacySubcategories({ name }), subcategories);
  }
  assert.equal(Object.values(expected).flat().length, 48);
});

test("supports the old aliases and case normalization", () => {
  for (const [alias, canonical] of [
    ["  groceries ", "GROCERY"],
    ["motor oils", "MOTOR OIL"],
    ["drinks", "DRINKS & BAGS"],
    ["tobaccos", "TOBACCO"],
  ]) {
    assert.deepEqual(getLegacySubcategories({ name: alias }), getLegacySubcategories({ name: canonical }));
  }
});

test("saved subcategories override defaults and preserve custom Apparels", () => {
  const subcategories = ["Consumer Products", "Apparels", "Medicines"];
  const category = { name: "MERCHANDISE", subcategories };
  const restored = getLegacySubcategories(category);
  assert.deepEqual(restored, subcategories);
  restored.push("Changed");
  assert.deepEqual(category.subcategories, ["Consumer Products", "Apparels", "Medicines"]);
  assert.equal(getLegacySubcategory({ name: "Example shirt", subcategory: "Apparels" }, category), "Apparels");
  assert.equal(getLegacySubcategory({ name: "Unmatched item" }, category), "Consumer Products");
});

test("returned defaults cannot be mutated by callers", () => {
  const list = getLegacySubcategories({ name: "TOBACCO" });
  list[0] = "Changed";
  assert.equal(getLegacySubcategories({ name: "TOBACCO" })[0], "Cigarillos");
});

test("preserves explicit labels including mismatches for caller review", () => {
  const product = { name: "Example candy", subcategory: "Cooking Material" };
  assert.equal(getLegacySubcategory(product, { name: "CANDIES" }), "Cooking Material");
  assert.equal(product.subcategory, "Cooking Material");
  assert.equal(getLegacySubcategory({ name: "Example", subcategory: "Custom label" }, null), "Custom label");
});

test("matches the old ordered substring rules before the first-option fallback", () => {
  for (const [category, name, subcategory] of [
    ["TOBACCO", "Marlboro paper", "Cigarettes"],
    ["TOBACCO", "Loose leaf tobacco", "Paper / Wraps"],
    ["TOBACCO", "Grabba tobacco", "Loose tobacco"],
    ["TOBACCO", "Example pouch", "Pouches"],
    ["TOBACCO", "Unknown item", "Cigarillos"],
    ["MERCHANDISE", "Rhino medicine", "Energy shots"],
    ["MERCHANDISE", "Example USB cable", "Chargers"],
    ["CANDIES", "Chocolate gum bag", "Chocolates"],
    ["CANDIES", "Extra hanging bag", "Gums"],
    ["FOOD STUFF", "Ramen chips", "Noodles"],
    ["GROCERY", "Foam trash bag", "Plastics & Tissues"],
    ["GROCERY", "Trash bag detergent", "Bags & Papers"],
    ["MOTOR OIL", "Unknown item", "Engine Oils & Fluids"],
    ["DRINKS & BAGS", "MONSTER soda water", "Energy Drinks"],
    ["DRINKS & BAGS", "Example WATER", "Waters"],
    ["NOVELTIES", "Example electronic vape", "Electronic Vapes"],
  ]) {
    assert.equal(getLegacySubcategory({ name }, { name: category }), subcategory, `${category}: ${name}`);
  }
});

test("classifies only against the explicitly supplied primary category", () => {
  const product = { name: "Example medicine", categoryIds: ["merch", "grocery"] };
  const primaryCategory = { id: "merch", name: "MERCHANDISE" };
  assert.equal(getLegacySubcategory(product, primaryCategory), "Medicines");
  assert.equal(getLegacySubcategory({ ...product, categoryIds: ["grocery", "merch"] }, primaryCategory), "Medicines");
  assert.equal(getLegacySubcategory(product, { id: "grocery", name: "GROCERY" }), "Plastics & Tissues");
});

test("rules only select labels present in the category's saved list", () => {
  const category = { name: "DRINKS", subcategories: ["Custom group", "Waters"] };
  assert.equal(getLegacySubcategory({ name: "Monster water" }, category), "Waters");
  assert.equal(getLegacySubcategory({ name: "Monster" }, category), "Custom group");
});

test("malformed values stay strings without coercion or prototype lookup", () => {
  for (const category of [null, undefined, [], 7, "TOBACCO", { name: 7 }, { name: "__proto__" }, { name: "constructor" }]) {
    assert.deepEqual(getLegacySubcategories(category), ["General"]);
  }
  const category = { name: "TOBACCO", subcategories: [null, 7, {}, "", " ", "Custom"] };
  assert.deepEqual(getLegacySubcategories(category), ["Custom"]);
  assert.equal(getLegacySubcategory({ name: {}, subcategory: {} }, { name: "TOBACCO" }), "Cigarillos");
  for (const product of [null, undefined, [], 7, "Example"]) {
    assert.equal(getLegacySubcategory(product, { name: "TOBACCO" }), "General");
  }
  assert.equal(getLegacySubcategory({ name: "Example", subcategory: " " }, { name: "TOBACCO" }), "Cigarillos");
  assert.deepEqual(getLegacySubcategories({ name: "TOBACCO", subcategories: [null] }), getLegacySubcategories({ name: "TOBACCO" }));
});
