export const WAREHOUSE_VIEWS = [
  "overview",
  "stock",
  "purchasing",
  "receive",
  "suppliers",
];
const COMMANDS = new Set([
  "supplier.save",
  "supplierProduct.save",
  "purchase.save",
  "purchase.order",
  "purchase.amend",
  "purchase.close",
  "purchase.receive",
  "inventory.configure",
  "inventory.adjust",
]);
export function warehouseQuantity(
  value,
  { nullable = false, min = 0, max = 1_000_000, label = "Quantity" } = {},
) {
  const raw = String(value ?? "").trim();
  if (nullable && !raw) return null;
  const result = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(result) ||
    result < min ||
    result > max
  )
    throw new Error(
      `${label} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    );
  return result;
}
export function warehouseMoney(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw))
    throw new Error(
      "Unit cost must be a nonnegative amount with at most two decimals.",
    );
  const result = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(result) || result > 1_000_000_000_000)
    throw new Error("Unit cost is too large.");
  return result;
}
export function preparePurchaseLines(entries) {
  const lines = [];
  for (const { mapping, quantity, id } of entries) {
    const amount = warehouseQuantity(quantity || 0);
    if (!amount) continue;
    if (!mapping?.id || mapping.active === false)
      throw new Error("Choose an active supplier product.");
    if (
      mapping.orderMultiple != null &&
      (!Number.isSafeInteger(mapping.orderMultiple) ||
        mapping.orderMultiple < 1)
    )
      throw new Error(
        "The supplier ordering multiple must be a positive whole number.",
      );
    if (mapping.orderMultiple != null && amount % mapping.orderMultiple)
      throw new Error(
        `Order quantity must be a multiple of ${mapping.orderMultiple}.`,
      );
    if (
      mapping.unitCostCents != null &&
      (!Number.isSafeInteger(mapping.unitCostCents) ||
        mapping.unitCostCents < 0)
    )
      throw new Error("The unit cost must be a nonnegative amount.");
    if (
      mapping.unit === "case" &&
      mapping.packSize != null &&
      (!Number.isSafeInteger(mapping.packSize) || mapping.packSize < 1)
    )
      throw new Error("Confirm the supplier case size.");
    lines.push({ id, supplierProductId: mapping.id, quantity: amount });
  }
  if (!lines.length)
    throw new Error("Enter a quantity for at least one purchase item.");
  return lines;
}
export function prepareReceiptLines(po, rows, owner) {
  const seen = new Set(),
    results = [];
  for (const row of rows) {
    const line = po.lines.find((item) => item.id === row.lineId);
    if (!line || seen.has(line.id))
      throw new Error("Choose each existing purchase line once.");
    seen.add(line.id);
    const acceptedQuantity = warehouseQuantity(row.acceptedQuantity || 0),
      rejectedQuantity = warehouseQuantity(row.rejectedQuantity || 0);
    if (!acceptedQuantity && !rejectedQuantity) continue;
    const outstanding =
      line.outstandingQuantity ??
      Math.max(
        0,
        line.quantity -
          (line.acceptedQuantity || 0) -
          (line.closedQuantity || 0),
      );
    if (acceptedQuantity + rejectedQuantity > outstanding)
      throw new Error(
        `Delivered quantity exceeds the ${outstanding} outstanding units. Ask the owner to amend the order first.`,
      );
    if (!["replacement", "close"].includes(row.rejectedDisposition))
      throw new Error("Choose whether rejected goods need replacement.");
    if (rejectedQuantity && row.rejectedDisposition === "close" && !owner)
      throw new Error("Only the owner can close rejected quantities.");
    results.push({
      lineId: line.id,
      acceptedQuantity,
      rejectedQuantity,
      rejectedDisposition: row.rejectedDisposition,
    });
  }
  if (!results.length)
    throw new Error("Enter an accepted or rejected quantity.");
  return results;
}
export function filterWarehouseStock(
  stock,
  products,
  { query = "", lowOnly = false } = {},
) {
  const term = String(query).trim().toLocaleLowerCase(),
    byId = new Map(products.map((product) => [product.id, product]));
  return stock.filter((row) => {
    const product = byId.get(row.productId) || {};
    const available = row.availableEach ?? row.available;
    return (
      (!lowOnly ||
        (Number.isFinite(available) &&
          Number.isFinite(row.reorderPoint) &&
          available <= row.reorderPoint)) &&
      (!term ||
        [
          row.name,
          product.name,
          product.sku,
          product.barcode,
          product.variantBarcodes?.[row.variant],
          row.variant,
          row.bin,
          row.warehouseBin,
        ].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(term),
        ))
    );
  });
}
export function createWarehouseDeviceState(storage, uid) {
  if (typeof uid !== "string" || !uid)
    throw new Error("Sign in before opening device records.");
  const prefix = `aw-warehouse:account:${encodeURIComponent(uid)}:`;
  function pending() {
    const raw = storage.getItem(prefix + "pending");
    if (!raw) return null;
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(
        "The local action record is damaged. Contact the owner before retrying.",
      );
    }
    const command = envelope.command;
    if (
      envelope.uid !== uid ||
      typeof command?.id !== "string" ||
      !COMMANDS.has(command.type) ||
      !command.payload ||
      typeof command.payload !== "object"
    )
      throw new Error(
        "The local action record cannot be verified for this account.",
      );
    return structuredClone(command);
  }
  return {
    pending,
    savePending(command) {
      if (!COMMANDS.has(command?.type) || !command.id)
        throw new Error("Unsupported warehouse action.");
      const existing = pending();
      if (existing && JSON.stringify(existing) !== JSON.stringify(command))
        throw new Error(
          "Resolve the pending warehouse action before starting another.",
        );
      storage.setItem(prefix + "pending", JSON.stringify({ uid, command }));
    },
    clearPending(expected) {
      const current = pending();
      if (
        !expected ||
        !current ||
        JSON.stringify(current) !== JSON.stringify(expected)
      )
        return false;
      storage.removeItem(prefix + "pending");
      return true;
    },
    getView() {
      const value = storage.getItem(prefix + "view");
      return WAREHOUSE_VIEWS.includes(value) ? value : "overview";
    },
    setView(view) {
      if (WAREHOUSE_VIEWS.includes(view))
        storage.setItem(prefix + "view", view);
    },
  };
}
export const purchaseTitle = (po) =>
  po.purchaseNumber || po.purchaseOrderNumber || po.number || "Purchase order";
export const dateText = (value) =>
  value
    ? new Date(value).toLocaleDateString([], { dateStyle: "medium" })
    : "Not scheduled";
export const moneyText = (value) =>
  Number.isSafeInteger(value)
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value / 100)
    : "Unknown cost";
export const quantityText = (value) =>
  Number.isFinite(value) ? value.toLocaleString() : "Unknown";
