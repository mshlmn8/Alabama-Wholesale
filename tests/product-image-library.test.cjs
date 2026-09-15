"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createProductImageLibrary,
  LIMITS,
} = require("../lib/product-image-library.cjs");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=",
  "base64",
);
async function library(t, names = []) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "aw-image-library-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of names) await fs.writeFile(path.join(directory, name), PNG);
  return {
    directory,
    find: createProductImageLibrary({
      directory,
      appOrigin: "https://app.example.com",
    }),
  };
}

test("exact product names outrank variant suffixes and unrelated brand files", async (t) => {
  const { find } = await library(t, [
    "Skittles.png",
    "Skittles Drink 1.png",
    "Skittles Drink.png",
    "Skittles Gummies.png",
  ]);
  const result = await find({
    name: "Skittles Drink",
    privateCost: "DO_NOT_SEND",
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((item) => item.image.url),
    [
      "https://app.example.com/images/Skittles%20Drink.png",
      "https://app.example.com/images/Skittles%20Drink%201.png",
    ],
  );
  assert.equal(JSON.stringify(result).includes("DO_NOT_SEND"), false);
  assert.deepEqual(result[0].image, {
    url: "https://app.example.com/images/Skittles%20Drink.png",
    mimeType: "image/png",
    data: PNG.toString("base64"),
  });
  assert.match(result[0].page.title, /Skittles Drink\.png/);
  assert.match(result[0].page.text, /filename/i);
});

test("normalizes case, spacing, punctuation and straight/curly apostrophes", async (t) => {
  const { find } = await library(t, ["Reese’s--Cups 2.png", "REESES Cups.png"]);
  const result = await find({ name: "reese's cups" });
  assert.equal(result.length, 2);
  assert.match(result[0].image.url, /REESES%20Cups/);
});

test("SS matches whole filenames rather than the substring in floss", async (t) => {
  const { find } = await library(t, [
    "Tooth floss.png",
    "SS 2.png",
    "SS.png",
    "Glass.png",
  ]);
  const result = await find({ name: "SS" });
  assert.deepEqual(
    result.map((item) => item.image.url),
    [
      "https://app.example.com/images/SS.png",
      "https://app.example.com/images/SS%202.png",
    ],
  );
});

test("does not expand a single brand or generic token to an unrelated product family", async (t) => {
  const { find } = await library(t, [
    "Skittles Drink.png",
    "Plastic Cups.png",
    "Paper Cups.png",
    "Mint Gum.png",
  ]);
  for (const name of ["Skittles", "Cups", "Gum", "Drink", "Missing product"])
    assert.deepEqual(await find({ name }), []);
});

test("allows complete informative token overlap with the same leading identity", async (t) => {
  const { find } = await library(t, [
    "Skittles Tropical Drink.png",
    "Other Skittles Drink.png",
    "Skittles Gummies.png",
  ]);
  const result = await find({ name: "Skittles Drink" });
  assert.equal(result.length, 1);
  assert.match(result[0].image.url, /Skittles%20Tropical%20Drink/);
});

test("rejects symlinks, directories, oversized files and disguised MIME data", async (t) => {
  const { directory, find } = await library(t, []);
  const outside = path.join(
    path.dirname(directory),
    path.basename(directory) + "-outside",
  );
  await fs.writeFile(outside, PNG);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.symlink(outside, path.join(directory, "Water.png"));
  await fs.mkdir(path.join(directory, "Water 1.png"));
  await fs.writeFile(
    path.join(directory, "Water 2.png"),
    Buffer.alloc(LIMITS.imageBytes + 1),
  );
  await fs.writeFile(path.join(directory, "Water 3.jpg"), PNG);
  await fs.writeFile(
    path.join(directory, "Water 4.png"),
    "<html>not an image</html>",
  );
  assert.deepEqual(await find({ name: "Water" }), []);
});

test("rechecks file identity at open time and never follows replacement symlinks", async (t) => {
  const { directory, find } = await library(t, ["Water.png"]);
  assert.equal((await find({ name: "Water" })).length, 1);
  const outside = path.join(
    path.dirname(directory),
    path.basename(directory) + "-outside",
  );
  await fs.writeFile(outside, PNG);
  t.after(() => fs.rm(outside, { force: true }));
  await fs.unlink(path.join(directory, "Water.png"));
  await fs.symlink(outside, path.join(directory, "Water.png"));
  assert.deepEqual(await find({ name: "Water" }), []);
});

test("indexes metadata once and does not construct file paths from a product name", async (t) => {
  const { directory, find } = await library(t, ["Water.png"]);
  assert.deepEqual(await find({ name: "../../private" }), []);
  await fs.writeFile(path.join(directory, "New Product.png"), PNG);
  assert.deepEqual(await find({ name: "New Product" }), []);
  assert.equal((await find({ name: "Water" })).length, 1);
});

test("caps candidates and safely rejects missing directories or invalid origin configuration", async (t) => {
  const { find, directory } = await library(t, [
    "Water 1.png",
    "Water 2.png",
    "Water 3.png",
  ]);
  assert.equal((await find({ name: "Water" })).length, 2);
  const missing = createProductImageLibrary({
    directory: path.join(directory, "missing"),
    appOrigin: "https://app.example.com/",
  });
  assert.deepEqual(await missing({ name: "Water" }), []);
  assert.throws(
    () =>
      createProductImageLibrary({
        directory,
        appOrigin: "https://user:password@app.example.com",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createProductImageLibrary({
        directory,
        appOrigin: "http://app.example.com",
      }),
    TypeError,
  );
});
