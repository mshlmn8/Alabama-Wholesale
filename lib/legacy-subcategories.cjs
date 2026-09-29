// Preserve the v9 catalog's display taxonomy and ordered name heuristics.
// Source: alabama-wholesale-v9.html, v7-mobile-requested-js.
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

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isLabel = (value) => typeof value === "string" && value.trim().length > 0;

function getLegacySubcategories(category) {
  if (!isRecord(category)) return ["General"];
  const saved = Array.isArray(category.subcategories)
    ? category.subcategories.filter(isLabel)
    : [];
  if (saved.length) return saved;
  const name = typeof category.name === "string" ? category.name.trim().toUpperCase() : "";
  return [...(DEFAULTS.get(name) || DEFAULTS.get(name.replace(/S$/, "")) || ["General"])];
}

function getLegacySubcategory(product, primaryCategory) {
  if (!isRecord(product)) return "General";
  // Invalid explicit assignments remain visible to the caller for review.
  // The caller decides whether this label exists under the primary category.
  if (isLabel(product.subcategory)) return product.subcategory;
  const subcategories = getLegacySubcategories(primaryCategory);
  const name = typeof product.name === "string" ? product.name.toLowerCase() : "";
  for (const [subcategory, keywords] of RULES) {
    if (subcategories.includes(subcategory) && keywords.some((keyword) => name.includes(keyword))) {
      return subcategory;
    }
  }
  return subcategories[0] || "General";
}

module.exports = { getLegacySubcategories, getLegacySubcategory };
