// Names are derived from saved identifiers. Rendering, exporting or retrying an
// order must never allocate a new number or change an issued invoice.
const text = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const numbered = (order) =>
  Number.isSafeInteger(order?.orderNumber) && order.orderNumber > 0;
const unsaved = (order) =>
  order?.status === "draft" &&
  order.version === 0 &&
  !order.invoiceNumber &&
  !order.legacy;

export function orderStoreName(order, store) {
  return (
    text(order?.storeSnapshot?.name) ||
    text(order?.storeName) ||
    text(store?.name) ||
    text(order?.storeId) ||
    "Store"
  );
}

export function orderReference(order, kind = "invoice") {
  return (
    (kind === "credit-memo" && text(order?.creditMemoNumber)) ||
    (kind !== "credit-memo" && numbered(order) && String(order.orderNumber)) ||
    text(order?.invoiceNumber) ||
    (unsaved(order) && "New order") ||
    `Order ${text(order?.id) || "unsaved"}`
  );
}

export function orderName(order, store, kind = "invoice") {
  if (kind !== "credit-memo" && (numbered(order) || unsaved(order)))
    return orderReference(order, kind);
  return `${orderStoreName(order, store)} — ${orderReference(order, kind)}`;
}

function filenamePart(value, limit) {
  return (
    text(value)
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, limit) || "order"
  );
}

export function orderFilename(
  order,
  { store, kind = "invoice", format = "pdf" } = {},
) {
  if (kind !== "credit-memo" && numbered(order)) {
    return `${order.orderNumber}-${filenamePart(kind, 24)}${
      format === "json" ? ".json" : ".pdf"
    }`;
  }
  const issued =
    (kind === "credit-memo" && text(order?.creditMemoNumber)) ||
    text(order?.invoiceNumber);
  // Keep the record ID on issued copies as well: historical imports may have
  // reused invoice numbers, and sanitizing old invoice text can collapse names.
  return (
    [
      filenamePart(orderStoreName(order, store), 48),
      filenamePart(orderReference(order, kind), 80),
      ...(issued || unsaved(order) ? [filenamePart(order?.id, 80)] : []),
      filenamePart(kind, 24),
    ].join("-") + (format === "json" ? ".json" : ".pdf")
  );
}
