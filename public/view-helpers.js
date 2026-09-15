export function formatSavedDate(value, locale = "en-US") {
  if (!value) return "Date unavailable";
  const plain = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = plain
    ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]))
    : new Date(value);
  return Number.isNaN(d.valueOf())
    ? "Date unavailable"
    : d.toLocaleDateString(locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}
const catalogText = (value) =>
  typeof value === "string" || typeof value === "number"
    ? String(value).normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")
    : "";
const catalogTokens = (value) => value.match(/[\p{L}\p{N}]+/gu) || [];
export function indexCatalogProducts(products) {
  return products.map((product, index) => {
    const name = catalogText(product.name);
    const identifiers = [
      product.sku,
      product.barcode,
      product.id,
      ...Object.values(product.variantBarcodes || {}),
    ]
      .map(catalogText)
      .filter(Boolean);
    const brands = [product.brand, product.brandName]
      .map(catalogText)
      .filter(Boolean);
    const terms = [
      name,
      ...identifiers,
      ...brands,
      ...(product.variants || []).map(catalogText),
    ].filter(Boolean);
    return {
      product,
      index,
      name,
      identifiers,
      brands,
      terms,
      tokens: [...new Set(terms.flatMap(catalogTokens))],
    };
  });
}
export function rankCatalogProducts(index, query) {
  const normalized = catalogText(query);
  if (!normalized) return index.map((entry) => entry.product);
  const tokens = catalogTokens(normalized);
  const score = (entry) => {
    if (entry.name === normalized) return 0;
    if (entry.identifiers.includes(normalized)) return 1;
    if (entry.brands.includes(normalized)) return 2;
    if (entry.name.startsWith(normalized)) return 3;
    if (entry.terms.some((term) => term.startsWith(normalized))) return 4;
    if (tokens.length && tokens.every((token) => entry.tokens.includes(token)))
      return 5;
    if (
      tokens.length &&
      tokens.every((token) =>
        entry.tokens.some((term) => term.startsWith(token)),
      )
    )
      return 6;
    // A short product abbreviation must not match incidental suffixes such as
    // "ss" in "glass" or "floss". Longer queries retain substring discovery.
    if (normalized.length > 2 && entry.name.includes(normalized)) return 7;
    if (
      normalized.length > 2 &&
      entry.terms.some((term) => term.includes(normalized))
    )
      return 8;
    if (
      tokens.length > 1 &&
      tokens.every(
        (token) =>
          token.length > 2 && entry.terms.some((term) => term.includes(token)),
      )
    )
      return 9;
    return Infinity;
  };
  return index
    .map((entry) => ({ entry, score: score(entry) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.entry.index - b.entry.index)
    .map((item) => item.entry.product);
}
export function normalizeCatalogLayout(raw, defaultColumns = 2) {
  const columns = Number(raw?.columns);
  return {
    view: raw?.view === "grid" ? "grid" : "list",
    columns:
      Number.isInteger(columns) && columns >= 1 && columns <= 5
        ? columns
        : Math.max(1, Math.min(5, defaultColumns)),
    compact: raw?.compact !== false,
  };
}
export function isHistoricalOrder(order) {
  return Boolean(
    order.status === "legacy" ||
      order.legacy?.needsPriceReview ||
      order.missingSnapshots ||
      order.missingPriceSnapshots,
  );
}
export function orderDocumentOptions(order) {
  if (order.status === "draft") return [];
  if (isHistoricalOrder(order)) return [["historical-copy", "Historical copy"]];
  if (
    !["submitted", "approved", "picking", "delivered", "cancelled"].includes(
      order.status,
    )
  )
    return [];
  return [
    ["invoice", "Invoice PDF"],
    ["pick-list", "Pick list"],
    ["delivery-note", "Delivery note"],
  ];
}
export function safeProductImage(value) {
  if (typeof value !== "string") return null;
  if (/^(images|assets)\//.test(value)) value = `/${value}`;
  if (value.startsWith("/") && !value.startsWith("//")) {
    try {
      const url = new URL(value, "https://alabama.invalid");
      return ["/assets/", "/images/", "/media/products/"].some((prefix) =>
        url.pathname.startsWith(prefix),
      )
        ? url.pathname + url.search
        : null;
    } catch {
      return null;
    }
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
export function recoverLegacyLines(order, products) {
  const lines = [],
    warnings = [];
  for (const [index, line] of (Array.isArray(order?.lines)
    ? order.lines
    : []
  ).entries()) {
    const product = products.find(
      (p) => p.id === (line.itemId || line.productId),
    );
    if (!product) {
      warnings.push(`Line ${index + 1}: product could not be matched.`);
      continue;
    }
    const entries =
      Array.isArray(line.entries) && line.entries.length
        ? line.entries
        : [{ variant: line.variant || "", qty: line.quantity ?? line.qty }];
    for (const entry of entries) {
      const raw = entry?.qty ?? entry?.quantity;
      const quantity =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^[1-9]\d*$/.test(raw.trim())
            ? Number(raw)
            : NaN;
      const variant = String(entry?.variant || "");
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        warnings.push(
          `Line ${index + 1}: quantity needs review (${String(raw)}).`,
        );
        continue;
      }
      if (
        (product.variants?.length &&
          !product.variants.includes(variant) &&
          !(variant === "" && product.standardVariantEnabled === true)) ||
        (!product.variants?.length && variant)
      ) {
        warnings.push(
          `Line ${index + 1}: variant ${variant || "(blank)"} could not be matched.`,
        );
        continue;
      }
      if (!["each", "case"].includes(line.unit))
        warnings.push(
          `Line ${index + 1}: legacy unit was unspecified; review the proposed each unit.`,
        );
      lines.push({
        productId: product.id,
        name: product.name,
        variant,
        quantity,
        unit: line.unit === "case" ? "case" : "each",
        note: [
          line.note,
          line.except ? `Except: ${line.except}` : "",
          line.suffix || "",
          line.literalText || "",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }
  }
  return { lines, warnings };
}
