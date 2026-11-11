// Quantity rules for ordering straight from the catalog. Pure: every function
// returns a new array, or the same array when nothing changes, so a caller can
// skip saving. Mix / Each lines are never edited here.
const LIMIT = 1_000_000;
const isManual = (line) => !["mix", "each"].includes(line.selectionMode);
const isFor = (line, productId, variant) =>
  line.productId === productId && (line.variant || "") === (variant || "");
const isPlain = (line) =>
  isManual(line) &&
  (line.unit ?? "each") === "each" &&
  !String(line.note || "").trim();
const count = (line) =>
  Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0;

export function variantQuantity(lines, productId, variant) {
  let total = 0;
  for (const line of lines || [])
    if (isManual(line) && isFor(line, productId, variant)) total += count(line);
  return total;
}

export function productQuantity(lines, productId) {
  let total = 0;
  for (const line of lines || [])
    if (line.productId === productId) total += count(line);
  return total;
}

export function draftUnits(lines) {
  let total = 0;
  for (const line of lines || []) total += count(line);
  return total;
}

function withQuantity(lines, index, quantity) {
  return quantity > 0
    ? lines.map((line, at) => (at === index ? { ...line, quantity } : line))
    : lines.filter((_, at) => at !== index);
}

function plainLine(productId, variant, quantity, makeId) {
  return {
    id: makeId(),
    productId,
    variant: variant || "",
    quantity,
    unit: "each",
    note: "",
  };
}

export function stepVariantQuantity(lines, productId, variant, delta, makeId) {
  const plain = lines.findIndex(
    (line) => isFor(line, productId, variant) && isPlain(line),
  );
  if (delta > 0) {
    if (plain < 0) return [...lines, plainLine(productId, variant, 1, makeId)];
    const next = count(lines[plain]) + 1;
    return next > LIMIT ? lines : withQuantity(lines, plain, next);
  }
  const target =
    plain >= 0
      ? plain
      : lines.findLastIndex(
          (line) => isFor(line, productId, variant) && isManual(line),
        );
  if (target < 0) return lines;
  const next = count(lines[target]) - 1;
  // A line with a note or a case unit is only removed deliberately, in Order.
  if (next <= 0 && !isPlain(lines[target])) return lines;
  return withQuantity(lines, target, next);
}

export function setVariantQuantity(lines, productId, variant, quantity, makeId) {
  if (
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > LIMIT
  )
    throw new Error("Use a whole number from 0 to 1,000,000.");
  if (quantity === variantQuantity(lines, productId, variant)) return lines;
  const plain = lines.findIndex(
    (line) => isFor(line, productId, variant) && isPlain(line),
  );
  const held =
    variantQuantity(lines, productId, variant) -
    (plain >= 0 ? count(lines[plain]) : 0);
  const wanted = Math.max(0, quantity - held);
  if (plain >= 0) return withQuantity(lines, plain, wanted);
  return wanted > 0
    ? [...lines, plainLine(productId, variant, wanted, makeId)]
    : lines;
}
