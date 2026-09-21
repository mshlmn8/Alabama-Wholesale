const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { executeCommand } = require("../lib/domain.cjs");
const { MemoryRepository } = require("../lib/repository.cjs");
const actor = { uid: "owner", role: "master", storeIds: [] };
const categories = [
  { id: "drinks", name: "Drinks", version: 1 },
  { id: "juice", name: "Juice", parentId: "drinks", version: 1 },
  { id: "apple", name: "Apple", parentId: "juice", version: 1 },
  { id: "snacks", name: "Snacks", version: 1 },
];
const run = (repo, type, payload, user = actor) =>
  repo.transaction((tx) =>
    executeCommand(tx, user, { id: randomUUID(), type, payload }),
  );
const file = path.join(__dirname, "../public/category-navigation.js");
const helper = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});

test("category parent is saved, retained on rename, and removable", async () => {
  const repo = new MemoryRepository({ categories });
  let child = await run(repo, "category.save", {
    id: "new",
    name: "New",
    parentId: "juice",
    expectedVersion: 0,
  });
  assert.equal(child.parentId, "juice");
  child = await run(repo, "category.save", {
    id: child.id,
    name: "Renamed",
    expectedVersion: child.version,
  });
  assert.equal(child.parentId, "juice");
  child = await run(repo, "category.save", {
    id: child.id,
    parentId: "",
    expectedVersion: child.version,
  });
  assert.equal(child.parentId, "");
});
test("category parents reject missing records, self-parenting, cycles and stale edits", async () => {
  const repo = new MemoryRepository({ categories });
  for (const parentId of ["missing", "drinks", "apple"])
    await assert.rejects(() =>
      run(repo, "category.save", {
        id: "drinks",
        parentId,
        expectedVersion: 1,
      }),
    );
  await assert.rejects(
    () =>
      run(repo, "category.save", {
        id: "juice",
        parentId: "snacks",
        expectedVersion: 0,
      }),
    { code: "VERSION_CONFLICT" },
  );
  assert.equal((await repo.get("categories", "drinks")).parentId, undefined);
});
test("category structure remains administrator-only", async () => {
  const repo = new MemoryRepository({ categories });
  await assert.rejects(
    () =>
      run(
        repo,
        "category.save",
        { name: "Test", parentId: "drinks" },
        { uid: "buyer", role: "customer", storeIds: [] },
      ),
    { code: "FORBIDDEN" },
  );
});
test("parent filtering includes nested descendants without unrelated products", async () => {
  const { categoryFilterIds, categoryTrail, categoryLabel } = await helper;
  assert.equal(typeof categoryFilterIds, "function");
  assert.deepEqual(
    [...categoryFilterIds(categories, "drinks")],
    ["drinks", "juice", "apple"],
  );
  assert.deepEqual(
    categoryTrail(categories, "apple").map((c) => c.id),
    ["drinks", "juice", "apple"],
  );
  assert.equal(
    categoryLabel(categories, categories[2]),
    "Drinks / Juice / Apple",
  );
  assert.deepEqual(
    [...categoryFilterIds(categories, "juice")],
    ["juice", "apple"],
  );
});
test("malformed legacy category cycles terminate safely", async () => {
  const { categoryFilterIds, categoryTrail } = await helper;
  assert.equal(typeof categoryTrail, "function");
  const broken = [
    { id: "a", parentId: "b" },
    { id: "b", parentId: "a" },
  ];
  assert.equal(categoryTrail(broken, "a").length, 2);
  assert.equal(categoryFilterIds(broken, "a").size, 2);
});
test("builder size is stored per account, retained by other settings, validated, and defaults small", async () => {
  const repo = new MemoryRepository();
  const buyer = { uid: "buyer", role: "customer", storeIds: [] };
  let owner = await run(repo, "preferences.save", { builderSize: "large" });
  assert.equal(owner.builderSize, "large");
  const other = await run(repo, "preferences.save", {}, buyer);
  assert.equal(other.builderSize, "small");
  owner = await run(repo, "preferences.save", {
    theme: "dark",
    expectedVersion: owner.version,
  });
  assert.equal(owner.builderSize, "large");
  await assert.rejects(
    () =>
      run(repo, "preferences.save", {
        builderSize: "gigantic",
        expectedVersion: owner.version,
      }),
    { code: "INVALID_INPUT" },
  );
  assert.equal((await repo.get("preferences", "buyer")).builderSize, "small");
});
