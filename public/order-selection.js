export function productVariants(product) {
  if (!product.variants?.length) return [""];
  return product.standardVariantEnabled === true
    ? ["", ...product.variants]
    : product.variants;
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

// Group only for display: keep every original row, even repeated flavors.
export function groupDraftLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.productId))
      groups.set(line.productId, { productId: line.productId, lines: [] });
    groups.get(line.productId).lines.push(line);
  }
  return [...groups.values()];
}

function validQuantity(quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000)
    throw new Error(
      "Flavor quantity must be a whole number between 1 and 1,000,000.",
    );
}

function validateLine(line) {
  if (!line || typeof line !== "object" || Array.isArray(line))
    throw new Error("Each selected order line must be an object.");
  if (typeof line.productId !== "string" || !line.productId.trim())
    throw new Error("Each selected line needs a product ID.");
  if (typeof (line.variant ?? "") !== "string")
    throw new Error("The selected flavor must be text.");
  if (!["each", "case"].includes(line.unit ?? "each"))
    throw new Error("Choose an available order unit: each or case.");
  if (typeof (line.note ?? "") !== "string")
    throw new Error("The order line note must be text.");
  validQuantity(line.quantity);
}

function selectionKey(line) {
  return JSON.stringify([
    line.productId,
    line.variant ?? "",
    line.unit ?? "each",
    line.note ?? "",
  ]);
}

// Build the entire edit before the caller updates its draft or generates IDs.
export function addSelectedProductLines(existingLines, additions, makeId) {
  if (!Array.isArray(existingLines) || !Array.isArray(additions))
    throw new Error("Existing order lines and selected lines must be lists.");
  existingLines.forEach(validateLine);
  additions.forEach(validateLine);
  const result = existingLines.map((line) => ({ ...line }));
  const matches = new Map();
  result.forEach((line, index) => {
    const key = selectionKey(line);
    if (!matches.has(key)) matches.set(key, index);
  });
  for (const addition of additions) {
    const key = selectionKey(addition);
    if (matches.has(key)) {
      const line = result[matches.get(key)];
      const quantity = line.quantity + addition.quantity;
      validQuantity(quantity);
      line.quantity = quantity;
    } else {
      matches.set(key, result.length);
      result.push({
        ...addition,
        variant: addition.variant ?? "",
        unit: addition.unit ?? "each",
        note: addition.note ?? "",
      });
    }
  }
  const usedIds = new Set(existingLines.map((line) => line.id));
  for (let index = existingLines.length; index < result.length; index++) {
    if (typeof makeId !== "function")
      throw new Error("New order lines need an ID factory.");
    const id = makeId();
    if (typeof id !== "string" || !id.trim() || usedIds.has(id))
      throw new Error(
        "Each new order line needs a unique ID. Please try again.",
      );
    usedIds.add(id);
    result[index].id = id;
  }
  return result;
}
