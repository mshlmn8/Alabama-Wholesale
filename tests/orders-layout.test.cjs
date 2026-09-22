const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    Object.assign(this, attrs);
    this.children = children
      .flat(Infinity)
      .filter((child) => child != null && child !== false);
  }
  append(...children) {
    this.children.push(...children.flat(Infinity));
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(key, value) {
    this[key] = value;
  }
  focus() {
    this.focused = true;
  }
}
const controls = (node) => [
  node,
  ...node.children.flatMap((child) =>
    child instanceof Control ? controls(child) : [],
  ),
];
const text = (node) =>
  node instanceof Control ? node.children.map(text).join(" ") : String(node);
const source = fs.readFileSync(
  path.join(__dirname, "../public/app.js"),
  "utf8",
);
const start = source.includes("let orderHistorySearch =")
  ? source.indexOf("let orderHistorySearch =")
  : source.indexOf("function renderOrders()");
const ordersSource = source.slice(
  start,
  source.indexOf("async function showOrder(order)"),
);

async function fixture() {
  const stores = [
    { id: "a", name: "Current name" },
    { id: "b", name: "Another store" },
  ];
  const orders = [
    {
      id: "first",
      storeId: "a",
      storeSnapshot: { name: "Original store" },
      invoiceNumber: "AW-101",
      createdAt: 10,
      status: "delivered",
      paymentStatus: "unpaid",
      totalCents: 12345,
    },
    {
      id: "second",
      storeId: "a",
      storeName: "<img src=x onerror=alert(1)>",
      invoiceNumber: "AW-102",
      createdAt: 20,
      status: "submitted",
      summary: true,
      totalCents: 300,
    },
    {
      id: "other",
      storeId: "b",
      invoiceNumber: "AW-103",
      createdAt: 30,
      status: "draft",
    },
    {
      id: "deleted",
      storeId: "a",
      invoiceNumber: "AW-104",
      createdAt: 40,
      status: "submitted",
      deleted: true,
    },
  ];
  const state = { orders, stores, me: { uid: "customer", role: "customer" } };
  const opened = [],
    events = [];
  let generation = 1;
  const el = (tag, attrs = {}, ...children) =>
    new Control(tag, attrs, children);
  const context = vm.createContext({
    ...(await import("../public/order-names.mjs")),
    state,
    storeId: "a",
    orderStoreScope: "selected",
    orderFilter: "",
    orderCursor: "older",
    orderHistoryLoading: false,
    orderHistoryError: "",
    operationScope: () => generation,
    scopeCurrent: (scope) => scope === generation,
    orderHistoryStoreId: () =>
      context.orderStoreScope === "all" ? "" : context.storeId,
    storeById: (id) => stores.find((store) => store.id === id),
    currentStore: () => stores.find((store) => store.id === context.storeId),
    cash: (cents) => `$${(cents / 100).toFixed(2)}`,
    date: (value) => `Date ${value}`,
    el,
    append: (node, ...children) => node.append(...children),
    input: (type, value = "", attrs = {}) =>
      el("input", { type, value, ...attrs }),
    select: (options, value, attrs) =>
      el("select", { options, value, ...attrs }),
    button: (label, callback, kind, symbol) =>
      el("button", { label, callback, class: kind, symbol }, label),
    iconButton: (label, symbol, callback) =>
      el("button", { "aria-label": label, callback, symbol }),
    icon: (name) => el("svg", { name }),
    status: (value) => el("span", { class: "status" }, value),
    heading: (title, description, actions) =>
      el("header", {}, el("h1", {}, title), el("p", {}, description), actions),
    empty: (title, description, actions) =>
      el("div", { class: "empty" }, title, description, actions),
    notice: (message) => el("div", { role: "alert" }, message),
    orderList: (orders) =>
      el(
        "div",
        {},
        orders.map((order) => el("div", {}, order.id)),
      ),
    beginDraft: () => events.push("begin"),
    showOrder: (order) => opened.push(order),
    resetOrderHistory: () => events.push("reset"),
    loadOlderOrders: async () => events.push("load"),
    act: (fn) => fn(),
  });
  vm.runInContext(ordersSource, context);
  let root = context.renderOrders();
  return {
    state,
    context,
    opened,
    events,
    get root() {
      return root;
    },
    redraw() {
      root = context.renderOrders();
    },
    node: (id) => controls(root).find((node) => node.id === id),
    rows: () =>
      controls(root).filter((node) => node.class === "order-history-row"),
    session: () => {
      generation++;
    },
  };
}

function search(f, value) {
  const control = f.node("order-history-search");
  assert.ok(control, "Loaded order history has a search input");
  control.value = value;
  control.onInput({ target: control });
  return control;
}

test("loaded orders search matches saved store names or invoice references without replacing its input", async () => {
  const f = await fixture();
  const control = search(f, "original AW-101");
  assert.equal(f.node("order-history-search"), control);
  assert.equal(f.rows().length, 1);
  assert.match(text(f.rows()[0]), /Original store.*AW-101/);
  search(f, "AW-102");
  assert.equal(f.rows().length, 1);
  assert.match(text(f.rows()[0]), /<img src=x onerror=alert\(1\)>/);
  assert.equal(
    controls(f.rows()[0]).some((node) => node.tag === "img" || node.innerHTML),
    false,
  );
  search(f, "AW-104");
  assert.equal(f.rows().length, 0, "Deleted orders never appear in search");
  assert.match(text(f.root), /No matching loaded orders/);
  assert.ok(
    f.node("load-older-orders"),
    "Search does not hide access to older pages",
  );
});

test("search stays applied to new history pages and resets across identity scopes", async () => {
  const f = await fixture();
  search(f, "AW-105");
  f.state.orders.push({
    id: "later",
    storeId: "a",
    invoiceNumber: "AW-105",
    status: "submitted",
    createdAt: 5,
  });
  f.redraw();
  assert.equal(f.node("order-history-search").value, "AW-105");
  assert.equal(f.rows().length, 1);
  f.session();
  f.redraw();
  assert.equal(f.node("order-history-search").value, "");
  assert.equal(f.rows().length, 3);
});

test("compact rows preserve sorting, scope and status filters and open the original summary object", async () => {
  const f = await fixture();
  assert.equal(f.rows().length, 2);
  assert.match(text(f.rows()[0]), /AW-102/);
  const open = controls(f.rows()[0]).find((node) => node.tag === "button");
  assert.ok(open["aria-label"].startsWith("Open "));
  await open.callback();
  assert.equal(f.opened[0], f.state.orders[1]);
  f.context.orderStoreScope = "all";
  f.redraw();
  assert.equal(f.rows().length, 3);
  const filter = f.node("order-status-filter");
  filter.onChange({ target: { value: "delivered" } });
  f.redraw();
  assert.equal(f.rows().length, 1);
  assert.match(text(f.rows()[0]), /AW-101.*delivered.*unpaid.*\$123.45/);
  assert.deepEqual(f.events, ["reset", "load"]);
});

test("loading and failed history stay actionable alongside search", async () => {
  const f = await fixture();
  search(f, "not loaded yet");
  f.context.orderHistoryError = "Saved history could not be loaded.";
  f.redraw();
  assert.match(text(f.root), /Saved history could not be loaded/);
  assert.equal(f.node("load-older-orders").label, "Retry loading orders");
  f.context.orderHistoryLoading = true;
  f.redraw();
  assert.equal(f.node("load-older-orders").disabled, true);
  assert.equal(f.node("order-history-search").value, "not loaded yet");
});
