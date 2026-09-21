// Device copies are optional side effects of a confirmed order. None of these
// operations submits an order or changes its financial retry state.
import { orderFilename } from "./order-names.mjs";
const clone = (value) => JSON.parse(JSON.stringify(value));
const FINAL_STATUSES = new Set([
  "submitted",
  "approved",
  "picking",
  "delivered",
  "cancelled",
]);
const amount = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === "string" && value.trim().length > 0;
const issue = (code, message) => Object.assign(new Error(message), { code });
export function normalizeDeviceCopyOptions(raw) {
  return {
    enabled: raw?.enabled !== false,
    format: ["pdf", "json", "both"].includes(raw?.format) ? raw.format : "pdf",
  };
}
function validateOrder(order) {
  if (
    !order ||
    !text(order.id) ||
    !text(order.storeId) ||
    !text(order.invoiceNumber) ||
    !Number.isSafeInteger(order.version) ||
    order.version < 1 ||
    !FINAL_STATUSES.has(order.status) ||
    order.summary ||
    order.legacy?.needsPriceReview ||
    !Array.isArray(order.lines) ||
    !order.lines.length ||
    order.lines.length > 1000 ||
    ![order.subtotalCents, order.taxCents, order.totalCents].every(amount)
  )
    throw issue(
      "ORDER_NOT_CONFIRMED",
      "A complete, confirmed invoice is required for a device copy.",
    );
  let subtotal = 0,
    tax = 0;
  for (const line of order.lines) {
    if (
      !line ||
      !text(line.name) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      !["each", "case"].includes(line.unit) ||
      (line.unit === "case" &&
        (!Number.isSafeInteger(line.packSize) || line.packSize < 1)) ||
      ![line.unitPriceCents, line.lineTotalCents, line.taxCents].every(
        amount,
      ) ||
      line.quantity * line.unitPriceCents !== line.lineTotalCents
    )
      throw issue(
        "ORDER_NOT_CONFIRMED",
        "The invoice is missing complete original quantities, prices or tax.",
      );
    subtotal += line.lineTotalCents;
    tax += line.taxCents;
  }
  if (
    !amount(subtotal) ||
    !amount(tax) ||
    !amount(subtotal + tax) ||
    subtotal !== order.subtotalCents ||
    tax !== order.taxCents ||
    subtotal + tax !== order.totalCents
  )
    throw issue(
      "ORDER_NOT_CONFIRMED",
      "The invoice totals do not match its original line items.",
    );
}
const initial = (format) => ({
  phase: "idle",
  format,
  requestedFormats: [],
  failedFormats: [],
  error: null,
  code: null,
});
export function createOrderDownloads({
  fetchPdf,
  download,
  isCurrent = () => true,
  onChange = () => {},
}) {
  const statuses = new Map(),
    active = new Map(),
    receipts = new Map();
  let disposed = false;
  function current() {
    try {
      return !disposed && isCurrent();
    } catch {
      return false;
    }
  }
  function status(id) {
    return clone(statuses.get(id) || initial("pdf"));
  }
  function publish(id, value) {
    if (!current()) return;
    statuses.set(id, clone(value));
    try {
      onChange(id, clone(value));
    } catch {
      /* A view error cannot change a download or an order's confirmation. */
    }
  }
  function cancelled(value) {
    return {
      ...value,
      phase: "idle",
      code: "SESSION_CHANGED",
      error:
        "The signed-in account changed before the device copy was requested.",
    };
  }
  function failed(id, format, error) {
    const result = {
      ...initial(format),
      phase: "error",
      code: error?.code || "DEVICE_COPY_FAILED",
      error: error?.message || "The device copy could not be requested.",
    };
    publish(id, result);
    return result;
  }
  async function prepare(order, options) {
    let value = { ...initial(options.format), phase: "preparing" };
    if (!current()) return cancelled(value);
    publish(order.id, value);
    const formats =
      options.format === "both" ? ["pdf", "json"] : [options.format];
    const failures = [];
    for (const [index, format] of formats.entries()) {
      // WebKit can replace a pending Blob navigation when another download is
      // clicked back-to-back. A zero-delay task still replaces the first download
      // in WebKit, so allow a short bounded gap before requesting the next file.
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      if (!current()) return cancelled(value);
      try {
        let content, mime;
        if (format === "pdf") {
          content = await fetchPdf(clone(order));
          if (!current()) return cancelled(value);
          if (!(content instanceof Blob) || content.size < 5)
            throw issue(
              "INVALID_PDF",
              "The server did not return a valid invoice PDF.",
            );
          const header = await content.slice(0, 5).text();
          if (!current()) return cancelled(value);
          if (header !== "%PDF-")
            throw issue(
              "INVALID_PDF",
              "The server did not return a valid invoice PDF.",
            );
          mime = "application/pdf";
        } else {
          content = JSON.stringify(
            {
              format: "aw-order-copy",
              version: 1,
              exportedAt: new Date().toISOString(),
              order,
            },
            null,
            2,
          );
          mime = "application/json";
        }
        if (!current()) return cancelled(value);
        await download(
          orderFilename(order, { format }),
          content,
          mime,
        );
        if (!current()) return cancelled(value);
        value.requestedFormats.push(format);
      } catch (error) {
        if (!current()) return cancelled(value);
        value.failedFormats.push(format);
        failures.push(
          `${format.toUpperCase()}: ${error?.message || "The download could not be requested."}`,
        );
        value.code = error?.code || "DEVICE_COPY_FAILED";
      }
    }
    value.phase = value.failedFormats.length
      ? value.requestedFormats.length
        ? "partial"
        : "error"
      : "requested";
    value.error = failures.length ? failures.join(" ") : null;
    publish(order.id, value);
    return clone(value);
  }
  function start(order, options) {
    if (!current()) return Promise.resolve(cancelled(initial(options.format)));
    try {
      validateOrder(order);
    } catch (error) {
      return Promise.resolve(failed(order?.id, options.format, error));
    }
    if (active.has(order.id)) return active.get(order.id);
    let snapshot;
    try {
      snapshot = clone(order);
    } catch (error) {
      return Promise.resolve(
        failed(
          order.id,
          options.format,
          issue(
            "INVALID_ORDER_COPY",
            "The confirmed order could not be prepared for download.",
          ),
        ),
      );
    }
    const operation = Promise.resolve()
      .then(() => prepare(snapshot, options))
      .catch((error) =>
        current()
          ? failed(snapshot.id, options.format, error)
          : cancelled(initial(options.format)),
      )
      .finally(() => {
        if (active.get(snapshot.id) === operation) active.delete(snapshot.id);
      });
    active.set(snapshot.id, operation);
    return operation;
  }
  function automatic(order, { requestId, options } = {}) {
    const normalized = normalizeDeviceCopyOptions(options);
    if (!current())
      return Promise.resolve(cancelled(initial(normalized.format)));
    if (!normalized.enabled)
      return Promise.resolve(
        statuses.has(order?.id) ? status(order.id) : initial(normalized.format),
      );
    if (!text(requestId))
      return Promise.resolve(
        failed(
          order?.id,
          normalized.format,
          issue(
            "MISSING_REQUEST_ID",
            "The confirmed submission receipt is required for automatic downloads.",
          ),
        ),
      );
    const previous = receipts.get(requestId);
    if (previous) {
      if (previous.orderId !== order?.id)
        return Promise.resolve(
          failed(
            order?.id,
            normalized.format,
            issue(
              "RECEIPT_MISMATCH",
              "This submission receipt belongs to a different order.",
            ),
          ),
        );
      return previous.operation.then(clone);
    }
    const operation = start(order, normalized);
    receipts.set(requestId, { orderId: order?.id, operation });
    return operation.then(clone);
  }
  function save(order, options) {
    return start(order, normalizeDeviceCopyOptions(options)).then(clone);
  }
  function dispose() {
    disposed = true;
  }
  return { automatic, save, status, dispose };
}
