import { orderReference, orderStoreName } from "./order-names.mjs";

const CATEGORY_ORDER = [
  "Tobacco",
  "Novelties",
  "Merchandise",
  "Candy",
  "Groceries",
  "Motor oil",
  "Drinks",
];
const compare = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
}).compare;
const label = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const noteText = (value) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
const key = (value) => label(value).toLocaleLowerCase("en");
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character];
  });
const htmlText = (value) => escapeHtml(value).replace(/\n/g, "<br>");

function categoryChoice(names) {
  const clean = names.map(label).filter(Boolean);
  const selected = new Set(clean.map(key));
  const rank = CATEGORY_ORDER.findIndex((name) => selected.has(key(name)));
  if (rank >= 0) return { name: CATEGORY_ORDER[rank], rank };
  // Category snapshots and current paths both run from root to descendant.
  return {
    name: clean[0] || "",
    rank: CATEGORY_ORDER.length + (clean.length ? 0 : 1),
  };
}

function productCategoryNames(product, byCategory) {
  const names = new Set();
  for (const id of product?.categoryIds || []) {
    const trail = [],
      seen = new Set();
    let category = byCategory.get(id);
    while (category && !seen.has(category.id)) {
      seen.add(category.id);
      trail.unshift(category.name);
      category = byCategory.get(category.parentId);
    }
    for (const name of trail) names.add(name);
  }
  return [...names];
}

function productText(product) {
  const hasNamedFlavors = product.lines.some((line) => label(line.variant));
  const rows = product.lines.map((line) => ({
    flavor: label(line.variant) || (hasNamedFlavors ? "Standard" : ""),
    quantity: label(line.quantity),
    unit: line.unit,
    note: noteText(line.note),
  }));
  // Stable sorting keeps repeated flavors and their individual notes intact.
  rows.sort((a, b) => compare(a.flavor, b.flavor));
  const values = rows.map((row) => {
    const cases =
      row.unit === "case" ? (row.quantity === "1" ? " case" : " cases") : "";
    return `${row.flavor ? row.flavor + " " : ""}(${row.quantity}${cases})${
      row.note ? " — " + row.note : ""
    }`;
  });
  return `${product.name}${hasNamedFlavors ? ": " : " "}${values.join(", ")}`;
}

// One presentation contract for browser copies, printing and server email.
// Inputs remain untouched; submitted names/categories take precedence over the
// current catalog, and no financial fields enter the formatted output.
export function formatOrder(
  order,
  { store, products = [], categories = [] } = {},
) {
  const byProduct = new Map(products.map((product) => [product.id, product]));
  const byCategory = new Map(
    categories.map((category) => [category.id, category]),
  );
  const liveCategories = new Map(),
    groupedProducts = new Map();
  for (const line of order?.lines || []) {
    const productId = label(line.productId) || label(line.itemId);
    const product = byProduct.get(productId);
    const name =
      label(line.name) ||
      label(line.productName) ||
      label(product?.name) ||
      productId ||
      "Product unavailable";
    const productKey = JSON.stringify([productId, name]);
    if (!liveCategories.has(productId))
      liveCategories.set(productId, productCategoryNames(product, byCategory));
    // An explicit empty snapshot must never inherit a later catalog category.
    const choice = categoryChoice(
      Array.isArray(line.categoryNames)
        ? line.categoryNames
        : liveCategories.get(productId),
    );
    let group = groupedProducts.get(productKey);
    if (!group) {
      group = { productId, name, category: choice, lines: [] };
      groupedProducts.set(productKey, group);
    } else if (choice.rank < group.category.rank) {
      group.category = choice;
    }
    group.lines.push(line);
  }
  const groupedCategories = new Map();
  for (const product of groupedProducts.values()) {
    const categoryKey = key(product.category.name);
    if (!groupedCategories.has(categoryKey))
      groupedCategories.set(categoryKey, {
        category: product.category.name,
        rank: product.category.rank,
        items: [],
      });
    groupedCategories
      .get(categoryKey)
      .items.push({ productId: product.productId, text: productText(product) });
  }
  const groups = [...groupedCategories.values()]
    .sort((a, b) => a.rank - b.rank || compare(a.category, b.category))
    .map(({ category, items }) => ({ category, items }));
  const storeName = orderStoreName(order, store);
  const reference = orderReference(order);
  const notes = noteText(order?.notes);
  const textParts = [storeName + "\n" + reference];
  const htmlParts = [
    `<h1>${escapeHtml(storeName)}</h1>`,
    `<p>${escapeHtml(reference)}</p>`,
  ];
  for (const group of groups) {
    textParts.push(group.items.map((item) => "• " + item.text).join("\n"));
    htmlParts.push(
      "<ul>" +
        group.items.map((item) => `<li>${htmlText(item.text)}</li>`).join("") +
        "</ul>",
    );
  }
  if (notes) {
    textParts.push("Order notes: " + notes);
    htmlParts.push(`<p><strong>Order notes:</strong> ${htmlText(notes)}</p>`);
  }
  return {
    storeName,
    reference,
    subject: storeName + " — " + reference,
    groups,
    text: textParts.join("\n\n"),
    html: htmlParts.join("\n"),
  };
}
