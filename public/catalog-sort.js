// Catalog sort choices. Pure: sorting returns a new array and is stable, so
// ties and products without the needed date keep the order they arrived in.
export const CATALOG_SORTS = [
  ["catalog", "Catalog order"],
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["az", "A–Z"],
  ["lastOrdered", "Last ordered"],
];

export function normalizeCatalogSort(value) {
  return CATALOG_SORTS.some(([key]) => key === value) ? value : "catalog";
}

const moment = (value) => {
  const time = typeof value === "number" ? value : new Date(value).valueOf();
  return Number.isFinite(time) ? time : null;
};

// productId -> when this store last ordered it, from submitted orders only.
export function lastOrderedIndex(orders, storeId) {
  const index = new Map();
  for (const order of orders || []) {
    if (
      order.storeId !== storeId ||
      order.deleted ||
      ["draft", "cancelled"].includes(order.status)
    )
      continue;
    const when =
      moment(order.date ?? order.legacy?.date) ?? moment(order.createdAt);
    if (when == null) continue;
    for (const line of order.lines || []) {
      const id = line.productId || line.itemId;
      if (id && !(index.get(id) >= when)) index.set(id, when);
    }
  }
  return index;
}

// Missing values sort after present ones in either direction.
const byDate = (read, direction) => (left, right) => {
  const a = read(left),
    b = read(right);
  if (a == null || b == null) return (a == null) - (b == null);
  return (a - b) * direction;
};

export function sortCatalogProducts(products, mode, lastOrdered = new Map()) {
  const list = [...products];
  switch (normalizeCatalogSort(mode)) {
    case "newest":
      return list.sort(byDate((product) => moment(product.createdAt), -1));
    case "oldest":
      return list.sort(byDate((product) => moment(product.createdAt), 1));
    case "az":
      return list.sort((left, right) =>
        String(left.name ?? "").localeCompare(String(right.name ?? ""), "en", {
          numeric: true,
          sensitivity: "base",
        }),
      );
    case "lastOrdered":
      return list.sort(byDate((product) => lastOrdered.get(product.id) ?? null, -1));
    default:
      return list;
  }
}
