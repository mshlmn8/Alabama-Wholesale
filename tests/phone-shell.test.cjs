const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (file) =>
  fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("the offline shell carries every phone redesign file under a new version", () => {
  const worker = read("public/sw.js");
  const shell = worker.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  for (const asset of [
    "/phone-redesign.css",
    "/phone-layout.js",
    "/phone-catalog.js",
    "/catalog-quantities.js",
  ])
    assert.ok(shell.includes(`"${asset}"`), `${asset} is cached for offline use`);
  assert.notEqual(
    worker.match(/const VERSION = "([^"]+)"/)[1],
    "aw-v2-20261105-more-1",
  );
});

test("the phone stylesheet loads last so it can restyle phone screens", () => {
  const html = read("public/index.html");
  const mobile = html.indexOf('href="/mobile-layout.css"');
  const phone = html.indexOf('href="/phone-redesign.css"');
  assert.ok(mobile > 0 && phone > mobile);
  assert.equal(html.lastIndexOf('rel="stylesheet"') < phone, true);
});

test("every phone redesign rule is confined to phone-sized screens", () => {
  const css = read("public/phone-redesign.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const opener = "@media screen and (max-width: 800px) {";
  let rest = "";
  let index = 0;
  while (index < css.length) {
    const start = css.indexOf(opener, index);
    if (start < 0) {
      rest += css.slice(index);
      break;
    }
    rest += css.slice(index, start);
    let depth = 1;
    let at = start + opener.length;
    while (depth && at < css.length) {
      if (css[at] === "{") depth++;
      else if (css[at] === "}") depth--;
      at++;
    }
    assert.equal(depth, 0, "media block is closed");
    index = at;
  }
  assert.equal(rest.trim(), "");
  assert.ok(css.includes(opener));
});

test("the build check knows the phone redesign files", () => {
  const build = read("scripts/build.cjs");
  for (const file of [
    "public/phone-layout.js",
    "public/phone-catalog.js",
    "public/catalog-quantities.js",
    "public/phone-redesign.css",
  ])
    assert.ok(build.includes(`"${file}"`), `${file} is checked by the build`);
});
