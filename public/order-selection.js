export function productVariants(product) {
  return product.variants?.length ? product.variants : [""];
}

// Validate every row before the caller changes the draft. Zero/blank rows are omitted.
export function selectedProductLines(product, quantities, unit, note = "") {
  if (
    !["each", "case"].includes(unit) ||
    (unit === "case" &&
      (!Number.isSafeInteger(product.packSize) || product.packSize <= 0))
  )
    throw new Error(
      "Choose an available order unit. Cases need a configured pack size.",
    );
  const lines = productVariants(product)
    .map((variant, index) => {
      const quantity = Number(quantities[index] ?? 0);
      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 0 ||
        quantity > 1_000_000
      )
        throw new Error(
          `${variant || "Standard"}: quantity must be a whole number between 0 and 1,000,000.`,
        );
      return {
        productId: product.id,
        variant,
        quantity,
        unit,
        note: note.trim(),
      };
    })
    .filter((line) => line.quantity > 0);
  if (!lines.length)
    throw new Error("Choose a quantity for at least one flavor.");
  return lines;
}
