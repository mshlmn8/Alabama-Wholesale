const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/more-tools.js");
const mod = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const product = {
  id: "p",
  name: "Drink",
  active: true,
  variants: ["Orange", "Lime"],
  packSize: 12,
};
test("list review uses current products, preserves selection modes and blocks unavailable rows without partial additions", async () => {
  const { reviewSavedList } = await mod;
  assert.equal(typeof reviewSavedList, "function");
  const saved = {
    lines: [
      {
        id: "old",
        productId: "p",
        variant: "Orange",
        quantity: 2,
        unit: "case",
        unitPriceCents: 1,
      },
      {
        id: "mix",
        productId: "p",
        variant: "",
        selectionMode: "each",
        allowedVariants: ["Orange"],
        excludedVariants: ["Lime"],
        quantity: 3,
        unit: "each",
      },
    ],
  };
  const result = reviewSavedList(saved, [product]);
  assert.equal(result.problems.length, 0);
  assert.equal(result.lines[0].id, undefined);
  assert.equal(result.lines[0].unitPriceCents, undefined);
  assert.equal(result.lines[1].selectionMode, "each");
  assert.deepEqual(result.lines[1].excludedVariants, ["Lime"]);
  assert.equal(
    reviewSavedList(saved, [{ ...product, active: false }]).lines.length,
    0,
  );
  assert.equal(
    reviewSavedList(saved, [{ ...product, variants: ["Lime"] }]).lines.length,
    0,
  );
  assert.equal(
    reviewSavedList(saved, [{ ...product, packSize: null }]).lines.length,
    0,
  );
});
test("documents include only the chosen store and approved credit memos, search literal text and exclude drafts", async () => {
  const { documentEntries } = await mod;
  assert.equal(typeof documentEntries, "function");
  const orders = [
    {
      id: "o1",
      storeId: "s1",
      invoiceNumber: "AW-1",
      status: "delivered",
      createdAt: 1,
    },
    {
      id: "other",
      storeId: "s2",
      invoiceNumber: "PRIVATE",
      status: "delivered",
    },
    { id: "draft", storeId: "s1", status: "draft" },
    { id: "deleted", storeId: "s1", status: "delivered", deleted: true },
  ];
  const returns = [
    {
      id: "r1",
      storeId: "s1",
      status: "approved",
      creditMemoNumber: "CM-1",
      invoiceNumber: "AW-1",
      approvedAt: 2,
    },
    { id: "r2", storeId: "s1", status: "pending", totalCents: 100 },
  ];
  const result = documentEntries(orders, returns, "s1", "");
  assert.deepEqual(
    result.map((row) => row.id),
    ["r1", "o1"],
  );
  assert.deepEqual(
    documentEntries(orders, returns, "s1", "CM-1").map((row) => row.id),
    ["r1"],
  );
  assert.equal(documentEntries(orders, returns, "s1", "<script>").length, 0);
});
test("Overview is not mislabeled as the active More page on mobile", async () => {
  const { mobileDestination } = await mod;
  assert.equal(typeof mobileDestination, "function");
  assert.equal(mobileDestination("home"), null);
  assert.equal(mobileDestination("more"), "more");
  assert.equal(mobileDestination("documents"), "more");
  assert.equal(mobileDestination("orders"), "orders");
});
