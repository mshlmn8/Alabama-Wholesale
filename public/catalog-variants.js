const normalized = (value) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();

/** Build catalog fields from editable rows; no catalog object is mutated. */
export function serializeCatalogVariants(rows) {
  if (!Array.isArray(rows) || rows.length > 200)
    throw new Error("A product can have up to 200 catalog variants.");
  const variants = [],
    variantPricesCents = {},
    variantBarcodes = {},
    seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (
      typeof row?.name !== "string" ||
      row.name.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(row.name) ||
      !row.name.trim()
    )
      throw new Error(
        `Enter a valid name for variant ${index + 1}, or remove that row.`,
      );
    const name = row.name.trim(),
      key = normalized(name);
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error(`Choose a different name for variant ${index + 1}.`);
    if (seen.has(key))
      throw new Error(
        `The variant “${name}” already exists. Use a different name or remove the duplicate row.`,
      );
    seen.add(key);
    if (
      row.priceCents !== null &&
      (!Number.isSafeInteger(row.priceCents) ||
        row.priceCents < 0 ||
        row.priceCents > 1_000_000_000_000)
    )
      throw new Error(`The price for variant “${name}” is invalid.`);
    if (
      typeof row.barcode !== "string" ||
      row.barcode.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(row.barcode)
    )
      throw new Error(`The barcode for variant “${name}” is invalid.`);
    variants.push(name);
    if (row.priceCents !== null) variantPricesCents[name] = row.priceCents;
    if (row.barcode.trim()) variantBarcodes[name] = row.barcode.trim();
  }
  return { variants, variantPricesCents, variantBarcodes };
}
