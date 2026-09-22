const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { executeCommand } = require("../lib/domain.cjs");
const { MemoryRepository } = require("../lib/repository.cjs");

class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    Object.assign(this, attrs);
    this.children = children.flat(Infinity).filter((child) => child != null);
  }
  append(...children) {
    this.children.push(...children.flat(Infinity));
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
const source = fs.readFileSync(
  path.join(__dirname, "../public/app.js"),
  "utf8",
);
const categorySource = source.slice(
  source.indexOf("function showCategories()"),
  source.indexOf("function showInvite()"),
);
const helpers = import(
  "data:text/javascript;base64," +
    Buffer.from(
      fs.readFileSync(
        path.join(__dirname, "../public/category-navigation.js"),
        "utf8",
      ),
    ).toString("base64")
);

async function fixture() {
  const state = {
    categories: [
      { id: "drinks", name: "Drinks", version: 1 },
      { id: "juice", name: "Juice", parentId: "drinks", version: 2 },
    ],
  };
  const repo = new MemoryRepository({
    categories: structuredClone(state.categories),
  });
  const dialogs = [],
    commands = [];
  let id = 0,
    current = true,
    master = true,
    failure = null;
  const context = vm.createContext({
    ...(await helpers),
    state,
    uuid: () => `category-test-${++id}`,
    operationScope: () => "original-session",
    scopeCurrent: () => current,
    master: () => master,
    SessionChanged: class extends Error {},
    render() {},
    toast() {},
    el: (tag, attrs = {}, ...children) => new Control(tag, attrs, children),
    input: (type, value = "", attrs = {}) =>
      new Control("input", { type, value, ...attrs }),
    select: (options, value, attrs = {}) =>
      new Control("select", { value, options, ...attrs }),
    field: (label, control) => {
      control.label = label;
      return control;
    },
    button: (label, callback) => new Control("button", { label, callback }),
    append: (node, ...children) => node.append(...children),
    act: async (fn) => fn(),
    modal: (title, subtitle) => {
      const modal = {
        title,
        subtitle,
        dialog: { open: true },
        content: new Control("div"),
        footer: new Control("div"),
      };
      modal.close = () => {
        modal.dialog.open = false;
      };
      dialogs.push(modal);
      return modal;
    },
    command: async (type, payload) => {
      commands.push({ type, payload });
      if (failure) throw failure;
      // The write succeeds but no /api/state refresh is applied, reproducing the
      // original case where a confirmed child disappeared from the reopened list.
      return repo.transaction((tx) =>
        executeCommand(
          tx,
          { uid: "owner", role: "master", storeIds: [] },
          { id: `command-${++id}`, type, payload: structuredClone(payload) },
        ),
      );
    },
  });
  vm.runInContext(categorySource, context);
  context.showCategories();
  const latest = () => dialogs.at(-1);
  const action = (dialog, name) =>
    [...controls(dialog.content), ...controls(dialog.footer)].find(
      (control) => control.tag === "button" && control.label === name,
    );
  const field = (dialog, label) =>
    controls(dialog.content).find((control) => control.label === label);
  const child = () => {
    const rows = controls(latest().content).filter(
      (control) => control.class === "category-editor-row",
    );
    controls(rows[1])
      .find((control) => control.label === "Add subcategory")
      .callback();
    return latest();
  };
  const submit = (dialog) =>
    controls(dialog.content)
      .find((control) => control.tag === "form")
      .onSubmit({ preventDefault() {} });
  return {
    state,
    repo,
    dialogs,
    commands,
    latest,
    action,
    field,
    child,
    submit,
    stale: () => {
      current = false;
    },
    revoke: () => {
      master = false;
    },
    fail: (error) => {
      failure = error;
    },
  };
}

test("Add subcategory opens a dedicated form with the chosen nested parent", async () => {
  const f = await fixture(),
    child = f.child();
  assert.equal(child.title, "Add subcategory");
  assert.equal(f.field(child, "Parent category").value, "juice");
  assert.equal(f.field(child, "Category name").focused, true);
  assert.equal(f.commands.length, 0);
});

test("submitting a child renders the confirmed result even if state refresh failed", async () => {
  const f = await fixture(),
    child = f.child();
  assert.equal(child.title, "Add subcategory");
  f.field(child, "Category name").value = "  Apple  ";
  await f.submit(child);
  const saved = f.state.categories.find(
    (category) => category.name === "Apple",
  );
  assert.equal(saved.parentId, "juice");
  assert.equal((await f.repo.get("categories", saved.id)).parentId, "juice");
  assert.equal(f.commands.length, 1);
  assert.equal(child.dialog.open, false);
  assert.equal(f.latest().title, "Catalog categories");
  assert(
    controls(f.latest().content).some((control) =>
      control.children.includes("Drinks / Juice / Apple"),
    ),
  );
});

test("canceling a child performs no command and a closed form cannot save", async () => {
  const f = await fixture(),
    child = f.child();
  assert.equal(child.title, "Add subcategory");
  f.field(child, "Category name").value = "Apple";
  f.action(child, "Cancel").callback();
  await f.submit(child);
  assert.equal(f.commands.length, 0);
  assert.equal(f.state.categories.length, 2);
});

test("failed writes retain child input and parent for review", async () => {
  const f = await fixture(),
    child = f.child();
  assert.equal(child.title, "Add subcategory");
  f.field(child, "Category name").value = "Apple";
  f.fail(new Error("Connection lost"));
  await assert.rejects(() => f.submit(child), /Connection lost/);
  assert.equal(child.dialog.open, true);
  assert.equal(f.field(child, "Category name").value, "Apple");
  assert.equal(f.field(child, "Parent category").value, "juice");
  assert.equal(f.field(child, "Category name").disabled, false);
  assert.equal(f.state.categories.length, 2);
});

test("stale sessions and revoked administrator access cannot save a child", async () => {
  for (const invalidate of ["stale", "revoke"]) {
    const f = await fixture(),
      child = f.child();
    assert.equal(child.title, "Add subcategory");
    f.field(child, "Category name").value = "Apple";
    f[invalidate]();
    await assert.rejects(() => f.submit(child));
    assert.equal(f.commands.length, 0);
  }
});

test("editing retains version checks and permits moving a category to the top level", async () => {
  const f = await fixture();
  controls(f.latest().content)
    .filter((control) => control.label === "Edit")[1]
    .callback();
  const edit = f.latest();
  assert.equal(edit.title, "Edit category");
  f.field(edit, "Category name").value = "Beverages";
  f.field(edit, "Parent category").value = "";
  await f.submit(edit);
  assert.equal(f.commands[0].payload.expectedVersion, 2);
  assert.equal(
    f.state.categories.find((category) => category.id === "juice").name,
    "Beverages",
  );
  assert.equal(
    f.state.categories.find((category) => category.id === "juice").parentId,
    "",
  );
});

test("a parent removed while management is open cannot silently create a top-level category", async () => {
  const f = await fixture();
  f.state.categories = f.state.categories.filter(
    (category) => category.id !== "juice",
  );
  assert.throws(() => f.child(), /parent category is no longer available/);
  assert.equal(f.commands.length, 0);
});

test("Add category opens a top-level form and Enter submission retains an empty parent", async () => {
  const f = await fixture();
  f.action(f.latest(), "Add category").callback();
  const edit = f.latest();
  assert.equal(edit.title, "Add category");
  assert.equal(f.field(edit, "Parent category").value, "");
  f.field(edit, "Category name").value = "Snacks";
  await f.submit(edit);
  assert.equal(f.commands[0].payload.parentId, "");
  assert.equal(
    f.state.categories.find((category) => category.name === "Snacks").parentId,
    "",
  );
});
