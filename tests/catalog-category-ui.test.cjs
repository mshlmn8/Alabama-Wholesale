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
    this.children = children.flat(Infinity).filter((child) => child != null);
    this.dataset = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
  }
  append(...children) { this.children.push(...children.flat(Infinity)); }
  replaceChildren(...children) { this.children = children.flat(Infinity); }
  setAttribute(key, value) { this[key] = value; }
  querySelectorAll(tag) { return controls(this).filter((item) => item.tag === tag); }
  focus() {}
  scrollIntoView() {}
}
const controls = (node) => [node, ...node.children.flatMap((child) => child instanceof Control ? controls(child) : [])];
async function fixture(category = "") {
  const preferences = { catalogLayout: { view: "grid", columns: 2, compact: true } };
  const state = {
    categories: [{ id: "drinks", name: "Drinks", subcategories: ["Water", "Juice"] }],
    products: [{ id: "water", name: "Bottle", categoryIds: ["drinks"], subcategory: "Water" }, { id: "juice", name: "Orange", categoryIds: ["drinks"], subcategory: "Juice" }],
  };
  const el = (tag, attrs = {}, ...children) => new Control(tag, attrs, children);
  const workspace = { preferences: () => preferences, rememberPreferences: (values) => Object.assign(preferences, values) };
  const context = vm.createContext({
    ...(await importFile("view-helpers.js")), ...(await importFile("category-navigation.js")),
    state, category, search: "", favoritesOnly: false, storeId: "shop", draft: null,
    preferences: () => preferences, currentStore: () => ({}), ws: workspace,
    operationScope: () => ({ workspace }), scopeCurrent: () => true,
    matchMedia: () => ({ matches: true }), master: () => false,
    act: async (fn) => fn(), bindCatalogSearch() {}, showScanner() {}, showAssistant() {},
    el, input: (type, value, attrs) => el("input", { type, value, ...attrs }),
    select: (options, value, attrs) => el("select", { options, value, ...attrs }),
    button: (label, callback, className) => el("button", { label, callback, class: className }),
    iconButton: (label, icon, callback) => el("button", { label, callback }),
    heading: (name, subtitle, actions) => el("h1", {}, name, subtitle, actions),
    append: (node, ...children) => node.append(...children),
    renderProductCard: (product) => el("article", { productId: product.id }),
    empty: (name) => el("div", {}, name),
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.slice(source.indexOf("function renderCatalog()"), source.indexOf("function renderProductCard")), context);
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
