const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const file = path.join(__dirname, "../public/order-names.mjs");
async function names() {
  assert.ok(fs.existsSync(file), "Shared order naming is available");
  return import(pathToFileURL(file).href);
}

test("new order names and references use only the assigned number without changing fiscal IDs", async () => {
  const { orderName, orderReference, orderFilename } = await names();
  const order = {
    id: "new-order",
    orderNumber: 1,
    storeName: "Shop",
    invoiceNumber: "AW-2026-000042",
  };
  assert.equal(orderName(order, { name: "Renamed" }), "1");
  assert.equal(orderReference(order), "1");
  assert.equal(orderFilename(order), "1-invoice.pdf");
  assert.equal(orderFilename({ ...order, orderNumber: 2 }), "2-invoice.pdf");
  assert.equal(
    orderFilename(order, { kind: "draft", format: "json" }),
    "1-draft.json",
  );
  assert.equal(order.invoiceNumber, "AW-2026-000042");
  for (const number of [
    0,
    -1,
    "1",
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      orderName({ ...order, orderNumber: number }),
      "Shop — AW-2026-000042",
    );
  }
});

test("unsaved drafts display New order while recovery filenames retain their unique IDs", async () => {
  const { orderName, orderReference, orderFilename } = await names();
  const draft = { id: "draft-one", storeId: "s1", status: "draft", version: 0 };
  assert.equal(orderName(draft, { name: "Shop" }), "New order");
  assert.equal(orderReference(draft), "New order");
  assert.notEqual(
    orderFilename(draft, { kind: "draft", format: "json" }),
    orderFilename(
      { ...draft, id: "draft-two" },
      { kind: "draft", format: "json" },
    ),
  );
  assert.equal(orderName({ ...draft, orderNumber: 3 }), "3");
});

test("order names use the original store and unchanged issued invoice number", async () => {
  const { orderName } = await names();
  const order = {
    id: "order-one",
    storeName: "Draft shop",
    storeSnapshot: { name: "Original shop" },
    invoiceNumber: "AW-2026-000042",
  };
  assert.equal(
    orderName(order, { name: "Renamed shop" }),
    "Original shop — AW-2026-000042",
  );
  assert.equal(order.invoiceNumber, "AW-2026-000042");
});

test("draft references retain the entire unique ID and are stable across edits and copies", async () => {
  const { orderName } = await names();
  const first = {
    id: "01234567-0000-4000-8000-000000000001",
    storeId: "s1",
    status: "draft",
  };
  const copy = { ...first, id: "01234567-0000-4000-8000-000000000002" };
  assert.equal(orderName(first, { name: "Shop" }), `Shop — Order ${first.id}`);
  assert.notEqual(
    orderName(first, { name: "Shop" }),
    orderName(copy, { name: "Shop" }),
  );
  assert.equal(
    orderName({ ...first, lines: [1, 2] }, { name: "Shop" }),
    orderName(first, { name: "Shop" }),
  );
});

test("legacy orders keep their saved store and number with safe fallbacks for incomplete records", async () => {
  const { orderName } = await names();
  assert.equal(
    orderName(
      {
        id: "legacy-1",
        storeName: "Old shop",
        invoiceNumber: "INV/23",
        legacy: {},
      },
      { name: "New shop" },
    ),
    "Old shop — INV/23",
  );
  assert.equal(
    orderName({ id: "offline-1", storeId: "s1" }),
    "s1 — Order offline-1",
  );
});

test("filenames include the store, invoice and record ID and remain bounded and path safe", async () => {
  const { orderFilename } = await names();
  const order = {
    id: "order-one",
    storeSnapshot: { name: "Original shop" },
    invoiceNumber: "AW-2026-000042",
  };
  assert.equal(
    orderFilename(order),
    "Original-shop-AW-2026-000042-order-one-invoice.pdf",
  );
  assert.notEqual(
    orderFilename(order),
    orderFilename({ ...order, id: "order-two" }),
  );
  const unsafe = orderFilename({
    id: "../../" + "x".repeat(200),
    storeName: "../ Shop\\Name\r\n\u0000" + "x".repeat(300),
    invoiceNumber: "../ <invoice>/" + "x".repeat(200),
  });
  assert.match(unsafe, /^[A-Za-z0-9_-]+\.pdf$/);
  assert.ok(unsafe.length < 245);
  assert.equal(
    orderFilename(
      { id: "draft-one", storeName: "Shop" },
      { kind: "draft", format: "json" },
    ),
    "Shop-Order-draft-one-draft.json",
  );
});

test("credit memo filenames use the approved memo number", async () => {
  const { orderFilename } = await names();
  const returned = {
    id: "return-one",
    storeName: "Shop",
    invoiceNumber: "AW-2026-000042",
    creditMemoNumber: "CM-AW-2026-000042-return-one",
  };
  assert.equal(
    orderFilename(returned, { kind: "credit-memo" }),
    "Shop-CM-AW-2026-000042-return-one-return-one-credit-memo.pdf",
  );
});
