const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/warehouse/helpers.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(
          fs.readFileSync(file, "utf8") +
            "\n//# sourceURL=warehouse/helpers.js",
        ).toString("base64")
    )
  : Promise.resolve({});
test("warehouse quantities preserve unknown versus zero and reject invalid unit quantities", async () => {
  const { warehouseQuantity, warehouseMoney } = await helpers;
  assert.equal(typeof warehouseQuantity, "function");
  assert.equal(warehouseQuantity("", { nullable: true }), null);
  assert.equal(warehouseQuantity("0"), 0);
  for (const value of ["", "1.5", "-1", "1e3", "1000001"])
    assert.throws(() => warehouseQuantity(value), /whole/i);
  assert.equal(warehouseMoney("12.34"), 1234);
  assert.equal(warehouseMoney(""), null);
  for (const value of ["-1", "1.001", "1e3"])
    assert.throws(() => warehouseMoney(value), /cost/i);
});
test("PO entry respects supplier order multiples and never invents missing ordering terms", async () => {
  const { preparePurchaseLines } = await helpers;
  assert.equal(typeof preparePurchaseLines, "function");
  const mapping = {
    id: "map",
    active: true,
    unit: "case",
    packSize: 12,
    orderMultiple: 2,
    unitCostCents: 1200,
  };
  assert.deepEqual(
    preparePurchaseLines([{ mapping, quantity: "4", id: "line" }]),
    [{ id: "line", supplierProductId: "map", quantity: 4 }],
  );
  assert.throws(
    () => preparePurchaseLines([{ mapping, quantity: "3", id: "line" }]),
    /multiple/i,
  );
  const unknownTerms = {
    ...mapping,
    orderMultiple: null,
    unitCostCents: null,
    packSize: null,
  };
  assert.deepEqual(
    preparePurchaseLines([
      { mapping: unknownTerms, quantity: "2", id: "line" },
    ]),
    [{ id: "line", supplierProductId: "map", quantity: 2 }],
  );
  assert.deepEqual(unknownTerms, {
    ...mapping,
    orderMultiple: null,
    unitCostCents: null,
    packSize: null,
  });
  for (const invalid of [
    { orderMultiple: 0 },
    { packSize: -1 },
    { unitCostCents: -1 },
  ])
    assert.throws(() =>
      preparePurchaseLines([
        { mapping: { ...mapping, ...invalid }, quantity: "2", id: "line" },
      ]),
    );
  assert.throws(
    () => preparePurchaseLines([{ mapping, quantity: "0", id: "line" }]),
    /one|quantity/i,
  );
});
test("receipts never overreceive and rejected replacement stock remains distinct from accepted goods", async () => {
  const { prepareReceiptLines } = await helpers;
  assert.equal(typeof prepareReceiptLines, "function");
  const po = {
    lines: [
      {
        id: "line",
        quantity: 10,
        acceptedQuantity: 4,
        closedQuantity: 0,
        outstandingQuantity: 6,
      },
    ],
  };
  assert.deepEqual(
    prepareReceiptLines(
      po,
      [
        {
          lineId: "line",
          acceptedQuantity: "2",
          rejectedQuantity: "3",
          rejectedDisposition: "replacement",
        },
      ],
      false,
    ),
    [
      {
        lineId: "line",
        acceptedQuantity: 2,
        rejectedQuantity: 3,
        rejectedDisposition: "replacement",
      },
    ],
  );
  assert.throws(
    () =>
      prepareReceiptLines(
        po,
        [
          {
            lineId: "line",
            acceptedQuantity: "4",
            rejectedQuantity: "3",
            rejectedDisposition: "replacement",
          },
        ],
        true,
      ),
    /outstanding/i,
  );
  assert.throws(
    () =>
      prepareReceiptLines(
        po,
        [
          {
            lineId: "line",
            acceptedQuantity: "0",
            rejectedQuantity: "2",
            rejectedDisposition: "close",
          },
        ],
        false,
      ),
    /owner/i,
  );
  assert.throws(
    () =>
      prepareReceiptLines(
        po,
        [
          {
            lineId: "line",
            acceptedQuantity: "0",
            rejectedQuantity: "0",
            rejectedDisposition: "replacement",
          },
        ],
        true,
      ),
    /quantity/i,
  );
});
test("warehouse device receipts isolate accounts and keep one immutable command for safe retry", async () => {
  const { createWarehouseDeviceState } = await helpers;
  assert.equal(typeof createWarehouseDeviceState, "function");
  const map = new Map(),
    storage = {
      getItem: (key) => map.get(key) || null,
      setItem: (key, value) => map.set(key, value),
      removeItem: (key) => map.delete(key),
    };
  const a = createWarehouseDeviceState(storage, "alice"),
    b = createWarehouseDeviceState(storage, "bob");
  const command = {
    id: "command-1",
    type: "purchase.receive",
    payload: { id: "po1", expectedVersion: 2, lines: [] },
  };
  a.savePending(command);
  assert.deepEqual(a.pending(), command);
  assert.equal(b.pending(), null);
  assert.throws(
    () => a.savePending({ ...command, id: "different" }),
    /pending/i,
  );
  a.savePending(command);
  assert.throws(
    () => a.savePending({ ...command, payload: { id: "po2" } }),
    /pending/i,
  );
  a.clearPending(command);
  assert.equal(a.pending(), null);
  assert.ok(
    [...map.keys()].every((key) => key.startsWith("aw-warehouse:account:")),
  );
});
test("storage failure blocks an unrecorded command instead of claiming a recoverable action", async () => {
  const { createWarehouseDeviceState } = await helpers;
  assert.equal(typeof createWarehouseDeviceState, "function");
  const store = createWarehouseDeviceState(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    },
    "alice",
  );
  assert.throws(
    () =>
      store.savePending({
        id: "c",
        type: "purchase.order",
        payload: { id: "po" },
      }),
    /blocked/,
  );
});
test("warehouse search includes variant barcode and unknown stock is not low counted stock", async () => {
  const { filterWarehouseStock } = await helpers;
  assert.equal(typeof filterWarehouseStock, "function");
  const products = [
      {
        id: "water",
        name: "Water",
        sku: "W",
        barcode: "001",
        variantBarcodes: { Lime: "002" },
      },
    ],
    stock = [
      {
        productId: "water",
        variant: "Lime",
        onHand: null,
        available: null,
        reorderPoint: 10,
      },
      {
        productId: "water",
        variant: "Orange",
        onHand: 0,
        available: 0,
        reorderPoint: 10,
      },
    ];
  assert.equal(
    filterWarehouseStock(stock, products, { query: "002" }).length,
    1,
  );
  assert.equal(
    filterWarehouseStock(stock, products, { lowOnly: true })[0].variant,
    "Orange",
  );
});

test("a late acknowledgement cannot erase a newer command from another tab", async () => {
  const { createWarehouseDeviceState } = await helpers;
  const map = new Map(),
    storage = {
      getItem: (key) => map.get(key) || null,
      setItem: (key, value) => map.set(key, value),
      removeItem: (key) => map.delete(key),
    };
  const a = createWarehouseDeviceState(storage, "alice"),
    b = createWarehouseDeviceState(storage, "alice"),
    first = { id: "first", type: "purchase.receive", payload: { id: "p1" } },
    second = { id: "second", type: "purchase.receive", payload: { id: "p2" } };
  a.savePending(first);
  b.clearPending(first);
  b.savePending(second);
  a.clearPending(first);
  assert.deepEqual(a.pending(), second);
});

test("supplier flavors, receiving quantities and amendment fields mount as controls", async () => {
  const helperURL =
    "data:text/javascript;base64," +
    Buffer.from(fs.readFileSync(file, "utf8")).toString("base64");
  const source = fs
    .readFileSync(
      path.join(__dirname, "../public/warehouse/screens.js"),
      "utf8",
    )
    .replace('"./helpers.js"', JSON.stringify(helperURL));
  const { createWarehouseScreens } = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  // Native append/replaceChildren stringify arrays; only the application's el helper flattens them.
  class Element {
    constructor(tag, attrs = {}) {
      this.tag = tag;
      Object.assign(this, attrs);
      this.children = [];
      this.listeners = {};
    }
    append(...children) {
      this.children.push(
        ...children.map((child) =>
          child instanceof Element ? child : String(child),
        ),
      );
    }
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }
    addEventListener(type, action) {
      this.listeners[type] = action;
    }
  }
  const el = (tag, attrs = {}, ...children) => {
    const node = new Element(tag, attrs);
    node.append(
      ...children
        .flat(Infinity)
        .filter((child) => child != null && child !== false),
    );
    return node;
  };
  const find = (node, predicate) =>
    node instanceof Element &&
    (predicate(node)
      ? node
      : node.children.map((child) => find(child, predicate)).find(Boolean));
  const textOf = (node) =>
    node instanceof Element ? node.children.map(textOf).join("") : String(node);
  const button = (label, action) => el("button", { action }, label);
  const field = (label, control) => el("label", { label }, label, control);
  const input = (type, value = "", attrs = {}) =>
    el("input", { type, value, ...attrs });
  const select = (choices, value = "") =>
    el(
      "select",
      { value },
      choices.map(([id, label]) => el("option", { value: id }, label)),
    );
  const po = {
    id: "po",
    status: "ordered",
    version: 2,
    supplierId: "supplier",
    lines: [
      {
        id: "line",
        name: "Water",
        productId: "water",
        variant: "Lime",
        quantity: 10,
        unit: "case",
        packSize: 12,
        outstandingQuantity: 10,
      },
    ],
  };
  const data = {
    me: { role: "master" },
    products: [{ id: "water", name: "Water", variants: ["Lime", "Orange"] }],
    suppliers: [{ id: "supplier", name: "Supplier" }],
    supplierProducts: [],
    purchaseOrders: [po],
  };
  let current;
  const screens = createWarehouseScreens({
    el,
    input,
    select,
    field,
    button,
    getData: () => data,
    notice: (text) => el("p", {}, text),
    scope: () => ({}),
    isCurrent: () => true,
    api: async () => ({ purchaseOrder: po, receipts: [] }),
    modal: () => {
      current = {
        dialog: { open: true },
        content: el("div"),
        footer: el("div"),
        guard() {},
        close() {},
      };
      return current;
    },
  });
  const suppliers = screens.render("suppliers");
  find(
    suppliers,
    (node) =>
      node.tag === "button" && textOf(node) === "Map a supplier product",
  ).action();
  const flavor = find(
    current.content,
    (node) => node.label === "Flavor",
  ).children.find((node) => node.tag === "select");
  assert.deepEqual(
    flavor.children.map((option) => option.value),
    ["Lime", "Orange"],
  );
  const purchases = screens.render("purchasing");
  await find(
    purchases,
    (node) => node.tag === "button" && textOf(node) === "View purchase",
  ).action();
  const purchaseDialog = current;
  find(
    purchaseDialog.footer,
    (node) => node.tag === "button" && textOf(node) === "Record delivery",
  ).action();
  for (const label of [
    "Accepted (case)",
    "Rejected / damaged (case)",
    "For rejected goods",
  ])
    assert.ok(
      find(current.content, (node) => node.label === label),
      `${label} must be mounted`,
    );
  find(
    purchaseDialog.footer,
    (node) => node.tag === "button" && textOf(node) === "Amend quantities",
  ).action();
  assert.ok(
    find(current.content, (node) => node.label === "Water / Lime (case)"),
    "amend quantity must be mounted",
  );
});
