const test = require("node:test");
const assert = require("node:assert/strict");
const load = () => import("../public/order-collapse.js");
function button() {
  const attributes = {},
    events = {};
  return {
    attributes,
    events,
    setAttribute(key, value) {
      attributes[key] = value;
    },
    addEventListener(name, fn) {
      events[name] = fn;
    },
  };
}
test("collapse button hides only its target and retains editable values", async () => {
  const { bindOrderCollapse } = await load();
  const control = button(),
    note = { value: "Unsaved delivery instruction" };
  const target = { id: "items-1", hidden: false, note },
    changes = [];
  bindOrderCollapse(control, target, {
    label: "order items",
    onChange: (value) => changes.push(value),
  });
  assert.equal(control.attributes["aria-expanded"], "true");
  assert.equal(control.attributes["aria-controls"], "items-1");
  control.events.click();
  assert.equal(target.hidden, true);
  assert.equal(control.attributes["aria-label"], "Expand order items");
  assert.equal(control.textContent, "Expand");
  assert.equal(note.value, "Unsaved delivery instruction");
  control.events.click();
  assert.equal(target.hidden, false);
  assert.deepEqual(changes, [true, false]);
});
test("collapse can restore a saved display state independently for each product", async () => {
  const { bindOrderCollapse } = await load();
  const first = button(),
    second = button(),
    a = { id: "a" },
    b = { id: "b" };
  bindOrderCollapse(first, a, {
    label: "flavors for Product A",
    collapsed: true,
  });
  bindOrderCollapse(second, b, { label: "flavors for Product B" });
  assert.equal(a.hidden, true);
  assert.equal(b.hidden, false);
  first.events.click();
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, false);
});
