const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "..", file), "utf8");

// Splits a stylesheet into the text inside blocks opened by `opener` and the rest.
function partition(css, opener) {
  let inside = "";
  let outside = "";
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf(opener, index);
    if (start < 0) {
      outside += css.slice(index);
      break;
    }
    outside += css.slice(index, start);
    // The opener may be a prefix such as "@media "; the block starts at its brace.
    const brace = css.indexOf("{", start + opener.length - 1);
    let depth = 1;
    let at = brace + 1;
    while (depth && at < css.length) {
      if (css[at] === "{") depth++;
      else if (css[at] === "}") depth--;
      at++;
    }
    assert.equal(depth, 0, `${opener} block is closed`);
    inside += css.slice(brace + 1, at - 1);
    index = at;
  }
  return { inside, outside };
}
const stylesheet = () =>
  read("public/phone-redesign.css").replace(/\/\*[\s\S]*?\*\//g, "");

test("the offline shell carries every redesign file under a new version", () => {
  const worker = read("public/sw.js");
  const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  for (const asset of [
    "/phone-redesign.css",
    "/phone-layout.js",
    "/phone-catalog.js",
    "/catalog-quantities.js",
    "/catalog-sort.js",
  ])
    assert.ok(shell.includes(`"${asset}"`), `${asset} is cached for offline use`);
  const version = worker.match(/const VERSION = "([^"]+)"/)[1];
  assert.notEqual(version, "aw-v2-20261105-more-1");
  assert.notEqual(version, "aw-v2-20261111-phone-1");
});

test("the redesign stylesheet loads last so it can restyle every screen", () => {
  const html = read("public/index.html");
  const mobile = html.indexOf('href="/mobile-layout.css"');
  const phone = html.indexOf('href="/phone-redesign.css"');
  assert.ok(mobile > 0 && phone > mobile);
  assert.equal(html.lastIndexOf('rel="stylesheet"') < phone, true);
});

test("the palette applies at every width in light and dark", () => {
  const css = stylesheet();
  const top = partition(css, "@media ").outside;
  const light = top.match(/:root\s*\{([^}]*)\}/)[1];
  const dark = top.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)[1];
  for (const token of [
    "--bg",
    "--panel",
    "--panel2",
    "--ink",
    "--muted",
    "--line",
    "--accent-ink",
    "--goldwash",
    "--navy-fill",
  ]) {
    assert.match(light, new RegExp(`${token}\\s*:`), `${token} in light`);
    assert.match(dark, new RegExp(`${token}\\s*:`), `${token} in dark`);
  }
});

test("phone tabs and top bar rules stay inside the phone breakpoint", () => {
  const css = stylesheet();
  const phone = partition(css, "@media screen and (max-width: 800px) {");
  assert.match(phone.inside, /\.mobile-nav/);
  assert.match(phone.inside, /\.topbar/);
  assert.equal(/\.mobile-nav|\.topbar|data-phone/.test(phone.outside), false);
});

test("the order panel shows beside the catalog only from 1100px", () => {
  const css = stylesheet();
  const wide = partition(css, "@media (min-width: 1100px) {");
  assert.match(
    wide.outside,
    /#app \.catalog-order-panel\s*\{[^}]*display:\s*none/,
  );
  assert.match(
    wide.inside,
    /#app \.catalog-order-panel\s*\{[^}]*display:\s*flex/,
  );
  assert.match(wide.inside, /#app \.phone-order-bar\s*\{[^}]*display:\s*none/);
});

test("the build check knows the redesign files", () => {
  const build = read("scripts/build.cjs");
  for (const file of [
    "public/phone-layout.js",
    "public/phone-catalog.js",
    "public/catalog-quantities.js",
    "public/catalog-sort.js",
    "public/phone-redesign.css",
  ])
    assert.ok(build.includes(`"${file}"`), `${file} is checked by the build`);
});

test("the palette keeps the base action colour so dark buttons stay readable", () => {
  const css = read("public/phone-redesign.css");
  assert.equal(/--gold\s*:/.test(css), false);
  assert.equal(/--onaccent\s*:/.test(css), false);
  assert.match(css, /button\.primary\s*\{[^}]*border-color:\s*var\(--gold\)/);
});

test("a long order scrolls inside the desktop panel so the total and button stay in view", () => {
  const wide = partition(stylesheet(), "@media (min-width: 1100px) {").inside;
  assert.match(
    wide,
    /#app \.catalog-order-lines\s*\{[^}]*overflow-y:\s*auto/,
  );
  assert.equal(
    /#app \.catalog-order-panel\s*\{[^}]*overflow-y:\s*auto/.test(wide),
    false,
  );
});
