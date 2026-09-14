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
        (product.variants?.length && !product.variants.includes(variant)) ||
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
