// Names are derived from saved identifiers. Rendering, exporting or retrying an
// order must never allocate a new number or change an issued invoice.
const text = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

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
    text(order?.invoiceNumber) ||
    `Order ${text(order?.id) || "unsaved"}`
  );
}

export function orderName(order, store, kind = "invoice") {
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
  const issued =
    (kind === "credit-memo" && text(order?.creditMemoNumber)) ||
    text(order?.invoiceNumber);
  // Keep the record ID on issued copies as well: historical imports may have
  // reused invoice numbers, and sanitizing old invoice text can collapse names.
  return (
    [
      filenamePart(orderStoreName(order, store), 48),
      filenamePart(orderReference(order, kind), 80),
      ...(issued ? [filenamePart(order?.id, 80)] : []),
      filenamePart(kind, 24),
    ].join("-") + (format === "json" ? ".json" : ".pdf")
  );
}
