const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(
  require("node:path").join(__dirname, "../public/app.js"),
  "utf8",
);

function pricing(product, store = {}) {
  const context = vm.createContext({
    productById: (id) => (product?.id === id ? product : undefined),
    currentStore: () => store,
    storeById: () => store,
  });
  vm.runInContext(
    source.slice(
      source.indexOf("function linePrice("),
      source.indexOf("function balance("),
    ),
    context,
  );
  return context;
}
const line = { productId: "p", variant: "Mint", unit: "each", quantity: 3 };

test("unpriced draft lines review at zero with no missing-price blocker", () => {
  for (const price of [undefined, null]) {
    const { linePrice, draftTotals } = pricing(
      { id: "p", priceCents: price, taxable: true },
      { taxRateBps: 1000 },
    );
    assert.equal(linePrice(line), 0);
    const totals = draftTotals({ lines: [line] });
    assert.equal(totals.total, 0);
    assert.equal(totals.tax, 0);
    assert.equal(totals.missing.length, 0);
  }
});

test("store and variant price precedence preserves explicit zero", () => {
  const product = {
    id: "p",
    priceCents: 125,
    variantPricesCents: { Mint: 200 },
    packSize: 12,
  };
  assert.equal(pricing(product).linePrice(line), 200);
  assert.equal(
    pricing(product, { priceOverrides: { p: 0 } }).linePrice(line),
    0,
  );
  assert.equal(
    pricing(product, {
      priceOverrides: {
        p: { priceCents: 300, variantPricesCents: { Mint: 0 } },
      },
    }).linePrice(line),
    0,
  );
  assert.equal(pricing(product).linePrice({ ...line, unit: "case" }), 2400);
});

test("invalid price or case size and missing products remain review blockers", () => {
  for (const priceCents of [-1, 1.5, "10", NaN, Infinity])
    assert.equal(pricing({ id: "p", priceCents }).linePrice(line), null);
  assert.equal(
    pricing({ id: "p", priceCents: null }).linePrice({ ...line, unit: "case" }),
    null,
  );
  assert.equal(pricing(undefined).linePrice(line), null);
});

test("mixed priced and unpriced draft totals apply tax only to actual amounts", () => {
  const context = pricing(
    { id: "p", taxable: true, priceCents: null },
    { taxRateBps: 1000 },
  );
  context.productById = (id) => ({
    id,
    taxable: true,
    priceCents: id === "p" ? null : 150,
  });
  const totals = context.draftTotals({
    lines: [line, { ...line, productId: "paid", quantity: 2 }],
  });
  assert.equal(totals.subtotal, 300);
  assert.equal(totals.tax, 30);
  assert.equal(totals.total, 330);
  assert.equal(totals.missing.length, 0);
});
