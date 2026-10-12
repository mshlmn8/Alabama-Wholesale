const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../public/app.js"),
  "utf8",
);
class Control {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    Object.assign(this, attrs);
    this.children = children
      .flat(Infinity)
      .filter((item) => item != null && item !== false);
  }
  append(...children) {
    this.children.push(
      ...children
        .flat(Infinity)
        .filter((item) => item != null && item !== false),
    );
  }
  setAttribute(key, value) {
    this[key] = value;
  }
}
const walk = (node) => [
  node,
  ...node.children.flatMap((item) =>
    item instanceof Control ? walk(item) : [],
  ),
];
function fixture(role) {
  const start = source.indexOf("function workspaceToolGroup(");
  assert.ok(
    start >= 0,
    "Workspace grouping helper must exist before rendering its actions",
  );
  const actions = [],
    scope = { current: true };
  const el = (tag, attrs = {}, ...children) =>
    new Control(tag, attrs, children);
  const context = {
    state: { me: { uid: "person", name: "Test person", role }, users: [] },
    master: () => role === "master",
    staff: () => role !== "customer",
    operationScope: () => scope,
    scopeCurrent: (value) => value.current,
    SessionChanged: class SessionChanged extends Error {},
    uuid: () => "group",
    el,
    append: (node, ...children) => node.append(...children),
    heading: (title, description) => el("header", {}, title, description),
    icon: (name) => el("svg", { name }),
    status: (name) => el("span", {}, name),
    button: (label, callback, kind) =>
      el("button", { callback, class: kind }, label),
    setView: (view) => actions.push(view),
    geminiChat: { open: () => actions.push("gemini") },
    productPhotos: { open: () => actions.push("photos") },
    location: { href: "" },
  };
  for (const name of [
    "showTemplates",
    "showNotificationPreferences",
    "showBuilderSettings",
    "showSyncCenter",
    "showWorkspaceBackup",
    "showInvite",
    "showCategories",
    "showMigration",
    "showBusinessBackup",
    "showAudit",
    "showOrderEmailSettings",
    "showEmailDelivery",
    "toggleWorkspaceTheme",
    "signOut",
  ])
    context[name] = () => actions.push(name);
  vm.runInNewContext(
    source.slice(start, source.indexOf("function showSyncCenter()", start)),
    context,
  );
  const root = context.renderMore();
  return {
    scope,
    actions,
    rows: walk(root).filter((node) => node.class === "workspace-tool-row"),
  };
}
const common = [
  "Overview",
  "Chat with Gemini",
  "Order templates",
  "Builder settings",
  "Store inventory",
  "Account & payments",
  "Returns & credits",
  "Notifications",
  "Notification preferences",
  "Sync center",
  "Workspace backup",
];
const owner = [
  "Product photos",
  "Invite staff or customer",
  "Manage categories",
  "Migration & reconciliation",
  "Verify business backup",
  "Audit activity",
  "Order email settings",
  "Email delivery status",
];

test("grouped menus preserve every tool and the existing role boundaries", () => {
  for (const role of ["customer", "salesman", "master"]) {
    const f = fixture(role);
    const expected = [
      ...common,
      ...(role !== "customer" ? ["Inventory", "Wholesale Operations"] : []),
      ...(role === "master" ? owner : []),
    ];
    assert.deepEqual(
      f.rows.map((row) => row["aria-label"]).sort(),
      expected.sort(),
      role,
    );
  }
});
test("a tool rendered for an earlier session cannot navigate or start an action", () => {
  const f = fixture("master");
  f.rows.find((row) => row["aria-label"] === "Overview").callback();
  assert.deepEqual(f.actions, ["home"]);
  f.scope.current = false;
  for (const row of f.rows) assert.throws(() => row.callback());
  assert.deepEqual(f.actions, ["home"]);
});
