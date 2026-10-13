export function categoryTrail(categories, id) {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const seen = new Set();
  const trail = [];
  for (
    let item = byId.get(id);
    item && !seen.has(item.id);
    item = byId.get(item.parentId)
  ) {
    seen.add(item.id);
    trail.unshift(item);
  }
  return trail;
}

export function categoryFilterIds(categories, id) {
  const ids = new Set([id]);
  const children = new Map();
  for (const item of categories) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item.id);
  }
  for (const parent of ids)
    for (const child of children.get(parent) || []) ids.add(child);
  return ids;
}

export function categoryLabel(categories, item) {
  return categoryTrail(categories, item.id)
    .map((category) => category.name)
    .join(" / ");
}

// These lists and ordered substring rules match the saved v9 catalog exactly.
// They are only a view of untouched migrated data; no restoration writes occur.
const DEFAULTS = new Map([
  ["TOBACCO", ["Cigarillos", "Paper / Wraps", "Loose tobacco", "Pouches", "Cigarettes"]],
  ["NOVELTIES", ["Electronic Vapes", "Disposables", "Recreationals", "Edibles", "Tobacco Use", "Shishas", "Home Use"]],
  ["MERCHANDISE", ["Medicines", "Condoms", "Energy shots", "Enhancement Supplements", "Lighters & Gas", "Chargers", "Fragrance Products", "Consumer Products"]],
  ["CANDIES", ["Chocolates", "Change Candies", "Gums", "Hanging Bags", "Toy Candies", "Candy"]],
  ["FOOD STUFF", ["Cooking Material", "Cookies", "Noodles", "Chips", "Pickles", "Crackers", "Condiments", "Cereals"]],
  ["GROCERY", ["Plastics & Tissues", "Dishwasher & Cleaners", "Care", "Bags & Papers", "Dog / Cat", "Kitchen & Home"]],
  ["MOTOR OIL", ["Engine Oils & Fluids", "Other Items"]],
  ["DRINKS & BAGS", ["Cheap Drinks", "Energy Drinks", "Sodas", "Juices", "Imported Drinks", "Waters"]],
]);
DEFAULTS.set("GROCERIES", DEFAULTS.get("GROCERY"));
DEFAULTS.set("MOTOR OILS", DEFAULTS.get("MOTOR OIL"));
DEFAULTS.set("DRINKS", DEFAULTS.get("DRINKS & BAGS"));

// Order and substring matching are intentional: changing them moves products
// between groups compared with the old app.
const RULES = [
  ["Cigarettes", ["marlboro", "newport", "camel", "cigarette", "seneca", "24/7", "cheyenne"]],
  ["Paper / Wraps", ["wrap", "paper", "raw", "zigzag", "job", "cones", "leaf", "hemp", "king palm", "loose leaf", "slapwoods"]],
  ["Cigarillos", ["game", "swisher", "white owl", "wo", "blk", "dutch", "garcia", "backwoods", "cigar", "cigarillo", "4k"]],
  ["Loose tobacco", ["grabba", "loose tobacco", "tobacco"]],
  ["Pouches", ["pouch"]],
  ["Lighters & Gas", ["lighter", "torch", "butane", "gas"]],
  ["Energy shots", ["5 hour", "energy shot", "rhino", "shot"]],
  ["Medicines", ["advil", "tylenol", "claritin", "medicine", "aleve", "benadryl"]],
  ["Condoms", ["condom", "trojan"]],
  ["Chargers", ["charger", "cable", "usb", "type c"]],
  ["Fragrance Products", ["incense", "fragrance", "air fresh", "spray"]],
  ["Chocolates", ["chocolate", "hershey", "snickers", "m&m", "kitkat"]],
  ["Gums", ["gum", "trident", "extra"]],
  ["Hanging Bags", ["hanging", "bag"]],
  ["Noodles", ["noodle", "maruchan", "ramen"]],
  ["Chips", ["chips", "lays", "doritos", "cheetos", "takis"]],
  ["Cookies", ["cookie"]],
  ["Pickles", ["pickle"]],
  ["Plastics & Tissues", ["plate", "cup", "foam", "tissue", "napkin"]],
  ["Bags & Papers", ["trash bag", "bag", "paper towel"]],
  ["Dishwasher & Cleaners", ["clean", "soap", "detergent", "dish"]],
  ["Engine Oils & Fluids", ["oil", "fluid", "2-cycle", "motor"]],
  ["Energy Drinks", ["monster", "red bull", "energy"]],
  ["Sodas", ["coke", "pepsi", "sprite", "soda"]],
  ["Juices", ["juice"]],
  ["Waters", ["water"]],
];

const legacyLabel = (value) =>
  typeof value === "string" && value.trim().length > 0 &&
  value.length <= 150 && !/[\u0000-\u001f]/u.test(value);
const labelKey = (value) => value.trim().toLowerCase();
const untouchedMigration = (record, collection) =>
  record?.version === 1 && !record.updatedBy && (
    record.legacySubcategoryFallback === true || (
      /^[a-f0-9]{64}$/u.test(record.migration?.sourceHash || "") &&
      typeof record.migration?.sourcePath === "string" &&
      record.migration.sourcePath.startsWith(`state/data/${collection}/`)
    )
  );

/** Recover a display-only legacy hierarchy while respecting modern records.
 * Explicit child memberships win. Name-based legacy fallback is restricted to
 * untouched migrated products under untouched migrated parents with no children.
 * New/edited records and invalid assignments retain their saved memberships. */
export function catalogCategoryHierarchy(categories, products) {
  const visible = categories.filter((item) => item.active !== false && !item.deleted);
  const projected = [...visible];
  const categoryById = new Map(visible.map((item) => [item.id, item]));
  const ids = new Set(categories.map((item) => item.id));
  const originalChildren = new Map();
  for (const item of categories) {
    if (!originalChildren.has(item.parentId)) originalChildren.set(item.parentId, []);
    originalChildren.get(item.parentId).push(item);
  }
  const legacyParents = new Map();
  for (const parent of visible) {
    if (parent.parentId || originalChildren.get(parent.id)?.length) continue;
    const saved = Array.isArray(parent.subcategories)
      ? parent.subcategories.filter(legacyLabel) : [];
    const migrated = untouchedMigration(parent, "categories");
    const defaults = migrated
      ? DEFAULTS.get(typeof parent.name === "string" ? parent.name.trim().toUpperCase() : "") : [];
    const labels = saved.length ? saved : defaults || [];
    if (!labels.length) continue;
    const distinct = new Set();
    for (const name of labels) {
      const key = labelKey(name);
      if (distinct.has(key)) continue;
      distinct.add(key);
      const id = `~legacy-subcategory~${encodeURIComponent(parent.id)}~${encodeURIComponent(key)}`;
      if (ids.has(id)) continue;
      ids.add(id);
      const child = { id, name, parentId: parent.id, sortOrder: distinct.size - 1, displayOnly: true };
      projected.push(child);
      categoryById.set(id, child);
    }
    legacyParents.set(parent.id, { labels: [...distinct], migrated });
  }
  const children = new Map();
  for (const item of projected) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item);
  }
  const productCategoryIds = new Map();
  for (const product of products) {
    const memberships = Array.isArray(product.categoryIds) ? [...product.categoryIds] : [];
    productCategoryIds.set(product.id, memberships);
    const parentId = memberships[0];
    const parent = categoryById.get(parentId);
    if (!parent || parent.parentId) continue;
    const descendants = categoryFilterIds(projected, parentId);
    if (memberships.some((id) => id !== parentId && descendants.has(id))) continue;
    let label = legacyLabel(product.subcategory) ? product.subcategory : "";
    const legacy = legacyParents.get(parentId);
    if (!label && legacy?.migrated && (
      untouchedMigration(product, "items") || untouchedMigration(product, "products")
    )) {
      const name = typeof product.name === "string" ? product.name.toLowerCase() : "";
      for (const [candidate, keywords] of RULES) {
        if (legacy.labels.includes(labelKey(candidate)) && keywords.some((keyword) => name.includes(keyword))) {
          label = candidate;
          break;
        }
      }
      label ||= children.get(parentId)?.[0]?.name || "";
    }
    if (!label) continue;
    const matches = (children.get(parentId) || []).filter((item) =>
      typeof item.name === "string" && labelKey(item.name) === labelKey(label));
    if (matches.length === 1) memberships.push(matches[0].id);
  }
  return { categories: projected, productCategoryIds };
}
