const test = require("node:test");
const assert = require("node:assert/strict");

async function fixture({ resizeObserver = true } = {}) {
  const { observeWorkspaceChrome } = await import(
    "../public/workspace-chrome.js"
  );
  const values = new Map();
  const root = {
    style: { setProperty: (key, value) => values.set(key, value) },
  };
  const dimensions = { header: 76, navigation: 0, dock: 68.2 };
  const element = (key) => ({
    getBoundingClientRect: () => ({ height: dimensions[key] }),
  });
  const elements = Object.fromEntries(
    Object.keys(dimensions).map((key) => [key, element(key)]),
  );
  const listeners = new Set();
  let observer;
  const environment = {
    addEventListener(type, listener) {
      assert.equal(type, "resize");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "resize");
      listeners.delete(listener);
    },
    ...(resizeObserver
      ? {
          ResizeObserver: class {
            constructor(callback) {
              this.callback = callback;
              this.observed = [];
              observer = this;
            }
            observe(node) {
              this.observed.push(node);
            }
            disconnect() {
              this.disconnected = true;
            }
          },
        }
      : {}),
  };
  const dispose = observeWorkspaceChrome(root, elements, environment);
  return {
    values,
    dimensions,
    observer,
    dispose,
    listeners,
    resize: () => listeners.forEach((fn) => fn()),
  };
}

test("space follows visible navigation and a review strip that wraps after resizing", async () => {
  const f = await fixture();
  assert.equal(f.values.get("--mobile-nav-height"), "0px");
  assert.equal(f.values.get("--order-dock-height"), "69px");
  assert.equal(f.observer.observed.length, 3);
  Object.assign(f.dimensions, { header: 142, navigation: 83.3, dock: 112.5 });
  f.observer.callback();
  assert.equal(f.values.get("--workspace-header-height"), "142px");
  assert.equal(f.values.get("--mobile-nav-height"), "84px");
  assert.equal(f.values.get("--order-dock-height"), "113px");
  f.dispose();
});

test("a disposed workspace cannot overwrite the next screen's spacing", async () => {
  const f = await fixture();
  f.dispose();
  assert.equal(f.observer.disconnected, true);
  assert.equal(f.listeners.size, 0);
  const before = [...f.values];
  f.dimensions.dock = 999;
  f.observer.callback();
  f.resize();
  assert.deepEqual([...f.values], before);
  f.dispose();
});

test("browsers without ResizeObserver update spacing on resize and release their listener", async () => {
  const f = await fixture({ resizeObserver: false });
  f.dimensions.navigation = 62;
  f.resize();
  assert.equal(f.values.get("--mobile-nav-height"), "62px");
  f.dispose();
  assert.equal(f.listeners.size, 0);
});
