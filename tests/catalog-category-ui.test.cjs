const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const importFile = (file) => import("data:text/javascript;base64," + Buffer.from(fs.readFileSync(path.join(__dirname, "../public", file), "utf8")).toString("base64"));
class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    Object.assign(this, attrs);
    this.children = [];
    this.append(...children);
    this.dataset = {};
    this.classList = { add() {} };
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  adopt(children) {
    const list = children.flat(Infinity).filter((child) => child != null);
    for (const child of list) {
      if (!(child instanceof Control)) continue;
      if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
      child.parent = this;
    }
    return list;
  }
  append(...children) { this.children.push(...this.adopt(children)); }
  prepend(...children) { this.children.unshift(...this.adopt(children)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  after(...nodes) {
    const list = this.parent.adopt(nodes);
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, ...list);
  }
  get firstElementChild() { return this.children.find((child) => child instanceof Control); }
  setAttribute(key, value) { this[key] = value; }
  querySelectorAll(tag) { return controls(this).filter((item) => item.tag === tag); }
  focus() {}
  scrollIntoView() {}
}
const controls = (node) => [node, ...node.children.flatMap((child) => child instanceof Control ? controls(child) : [])];
async function fixture(category = "", catalogSort) {
  const preferences = { catalogLayout: { view: "grid", columns: 2, compact: true }, catalogSort };
  const state = {
    categories: [{ id: "drinks", name: "Drinks", subcategories: ["Water", "Juice"] }],
    products: [{ id: "water", name: "Bottle", categoryIds: ["drinks"], subcategory: "Water", createdAt: 1 }, { id: "juice", name: "Orange", categoryIds: ["drinks"], subcategory: "Juice", createdAt: 2 }],
    orders: [],
  };
  const el = (tag, attrs = {}, ...children) => new Control(tag, attrs, children);
  const workspace = { preferences: () => preferences, rememberPreferences: (values) => Object.assign(preferences, values) };
  const context = vm.createContext({
    ...(await importFile("view-helpers.js")), ...(await importFile("category-navigation.js")), ...(await importFile("catalog-sort.js")),
    state, category, search: "", favoritesOnly: false, storeId: "shop", draft: null,
    preferences: () => preferences, currentStore: () => ({}), ws: workspace,
    operationScope: () => ({ workspace }), scopeCurrent: () => true, isPhone: () => false,
    matchMedia: () => ({ matches: true }), master: () => false,
    act: async (fn) => fn(), bindCatalogSearch() {}, showScanner() {}, showAssistant() {},
    el, input: (type, value, attrs) => el("input", { type, value, ...attrs }),
    select: (options, value, attrs) => el("select", { options, value, ...attrs }),
    button: (label, callback, className) => el("button", { label, callback, class: className }),
    iconButton: (label, icon, callback) => el("button", { label, callback }),
    heading: (name, subtitle, actions) => el("h1", {}, name, subtitle, actions),
    append: (node, ...children) => node.append(...children),
    icon: (name) => el("svg", { name }), knownLastOrdered: () => null,
    cash: (cents) => String(cents), uuid: () => "id", catalogQuantities: {}, phoneCatalogExpanded: new Set(),
    productVariants: (product) => (product.variants?.length ? product.variants : [""]),
    productById: (id) => state.products.find((product) => product.id === id),
    createPhoneCatalog: () => ({
      nodes: (products) => products.map((product) => el("article", { productId: product.id })),
      orderBar: el("div"), orderPanel: el("aside"), refresh() {},
    }),
    empty: (name) => el("div", {}, name),
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("function renderCatalog()"), source.indexOf("async function toggleFavorite")), context);
  return { root: context.renderCatalog(), context, preferences };
}

test("catalog child chips filter legacy memberships and remain selected across rerenders", async () => {
  const f = await fixture();
  const button = (label) => controls(f.root).find((item) => item.tag === "button" && item.label === label);
  button("Drinks").callback();
  assert.ok(button("Water"), "saved legacy child appears below its parent");
  button("Water").callback();
  assert.deepEqual(controls(f.root).filter((item) => item.productId).map((item) => item.productId), ["water"]);
  const selected = f.context.category;
  const next = await fixture(selected);
  assert.equal(next.context.category, selected);
  assert.deepEqual(controls(next.root).filter((item) => item.productId).map((item) => item.productId), ["water"]);
  button("All Drinks").callback();
  assert.deepEqual(controls(f.root).filter((item) => item.productId).map((item) => item.productId), ["water", "juice"]);
});

test("the saved sort choice orders the catalog and a new choice is remembered on the device", async () => {
  const f = await fixture("", "newest");
  const shown = () => controls(f.root).filter((item) => item.productId).map((item) => item.productId);
  assert.deepEqual(shown(), ["juice", "water"]);
  const sort = controls(f.root).find((item) => item.tag === "select" && item.id === "catalog-sort");
  assert.equal(sort.value, "newest");
  assert.deepEqual(sort.options.map(([value]) => value), ["catalog", "newest", "oldest", "az", "lastOrdered"]);
  sort.value = "oldest";
  sort.onChange();
  assert.deepEqual(shown(), ["water", "juice"]);
  assert.equal(f.preferences.catalogSort, "oldest");
  const unknown = await fixture("", "za");
  assert.deepEqual(controls(unknown.root).filter((item) => item.productId).map((item) => item.productId), ["water", "juice"]);
});
