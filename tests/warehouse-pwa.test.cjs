const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../public/warehouse");
test("warehouse installs as its own scoped application", () => {
  assert.ok(
    fs.existsSync(path.join(root, "manifest.webmanifest")),
    "Warehouse manifest exists",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"),
  );
  assert.equal(manifest.id, "/warehouse/");
  assert.equal(manifest.scope, "/warehouse/");
  assert.equal(manifest.start_url, "/warehouse/");
  assert.equal(manifest.name, "Alabama Wholesale Operations");
  assert.ok(manifest.icons.every((icon) => icon.src.startsWith("/warehouse/")));
});
test("warehouse worker only deletes its own caches and never caches private API responses", () => {
  assert.ok(fs.existsSync(path.join(root, "sw.js")), "Warehouse worker exists");
  const source = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.match(source, /aw-warehouse-shell-/);
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\)/);
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.doesNotMatch(
    source,
    /startsWith\(["']aw-["']\)|startsWith\(["']alabama-/,
  );
});
test("warehouse shell has a separate manifest and complete responsive accessible entry", () => {
  assert.ok(
    fs.existsSync(path.join(root, "index.html")),
    "Warehouse shell exists",
  );
  const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(source, /\/warehouse\/manifest\.webmanifest/);
  assert.match(source, /name="viewport"/);
  assert.match(source, /type="module"/);
  assert.match(source, /Alabama Wholesale Operations/);
});
