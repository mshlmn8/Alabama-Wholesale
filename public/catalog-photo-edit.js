const normalized = (value) =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
function text(value, label, max, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label} is invalid. Review the photo details.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required.`);
  return result;
}

/** Prepare an editable proposal. Never replace an existing parent's commercial fields. */
export function preparePhotoProduct({
  productId = null,
  details,
  products = [],
}) {
  if (!details || typeof details !== "object")
    throw new Error("Review the product details first.");
  const parent = productId
    ? products.find(
        (product) =>
          product.id === productId &&
          product.active !== false &&
          !product.deleted,
      )
    : null;
  if (productId && !parent)
    throw new Error(
      "This product is no longer available. Choose another product.",
    );
  const variant = text(details.variant ?? "", "Variant", 200, !!parent);
  if (["__proto__", "constructor", "prototype"].includes(variant))
    throw new Error("Choose a different variant name.");
  const barcode = text(details.barcode ?? "", "Barcode", 200);
  if (
    parent?.variants?.some((value) => normalized(value) === normalized(variant))
  )
    throw new Error(
      `The variant “${variant}” already exists for ${parent.name}. Edit that variant in the product editor.`,
    );
  if (parent?.variants?.length >= 200)
    throw new Error("This product already has the maximum of 200 variants.");
  if (barcode) {
    const duplicate = products.find(
      (product) =>
        !product.deleted &&
        [product.barcode, ...Object.values(product.variantBarcodes || {})].some(
          (value) => value && normalized(value) === normalized(barcode),
        ),
    );
    if (duplicate)
      throw new Error(
        `This barcode already belongs to ${duplicate.name}. Review that product, or clear the barcode if it was misread.`,
      );
  }
  if (parent)
    return {
      ...structuredClone(parent),
      variants: [...(parent.variants || []), variant],
      variantBarcodes: {
        ...(parent.variantBarcodes || {}),
        ...(barcode ? { [variant]: barcode } : {}),
      },
    };
  const name = text(details.name ?? "", "Product name", 300, true);
  const packSize = details.packSize ?? null;
  if (
    packSize !== null &&
    (!Number.isSafeInteger(packSize) || packSize < 1 || packSize > 1_000_000)
  )
    throw new Error(
      "Units per case must be a whole number between 1 and 1,000,000, or left blank.",
    );
  return {
    name,
    sku: "",
    variants: variant ? [variant] : [],
    barcode: variant ? "" : barcode,
    variantBarcodes: variant && barcode ? { [variant]: barcode } : {},
    priceCents: null,
    variantPricesCents: {},
    packSize,
    categoryIds: [],
    taxable: true,
    stockStatus: "active",
    active: true,
  };
}
