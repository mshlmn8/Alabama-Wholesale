const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let modulePromise;
function load() {
  return (modulePromise ||= import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, "../public/storage.js"), "utf8"),
      ).toString("base64")
  ));
}
function memory() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
}
test("failed persistence is surfaced and does not claim a draft was saved", async () => {
  const { Workspace } = await load();
  const store = memory();
  const ws = new Workspace(store, "test");
  store.setItem = () => {
    throw new Error("quota");
  };
  assert.throws(
    () => ws.saveDraft({ id: "draft", lines: [] }),
    /save|storage/i,
  );
  assert.equal(ws.getDraft("draft"), null);
});
test("commands retain their id and contents after a failed send and reload", async () => {
  const { Workspace } = await load();
  const store = memory();
  const ws = new Workspace(store, "test");
  const command = {
    id: "stable-command",
    type: "order.submit",
    payload: { id: "draft" },
  };
  ws.enqueue(command);
  ws.fail(command.id, "Offline");
  const reloaded = new Workspace(store, "test");
  assert.deepEqual(reloaded.pending()[0].command, command);
  assert.equal(reloaded.pending()[0].error, "Offline");
  reloaded.acknowledge(command.id);
  assert.equal(new Workspace(store, "test").pending().length, 0);
});
test("same command cannot be silently reused for a different operation", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  ws.enqueue({ id: "same", type: "order.submit", payload: { id: "a" } });
  assert.throws(
    () =>
      ws.enqueue({ id: "same", type: "order.submit", payload: { id: "b" } }),
    /different|reuse/i,
  );
  assert.equal(ws.pending().length, 1);
});
test("remote refresh preserves unsynced local drafts", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  ws.saveDraft({ id: "local", lines: [{ quantity: 2 }] });
  ws.mergeRemoteDrafts([
    { id: "other", status: "draft", version: 4, lines: [] },
  ]);
  assert.equal(ws.getDraft("local").lines[0].quantity, 2);
  assert.equal(ws.getDraft("other").version, 4);
});
test("a stale tab cannot overwrite a draft edited elsewhere", async () => {
  const { Workspace } = await load();
  const store = memory();
  const first = new Workspace(store, "test");
  first.saveDraft({ id: "draft", lines: [] });
  const second = new Workspace(store, "test");
  const stale = second.getDraft("draft");
  first.saveDraft({ ...first.getDraft("draft"), notes: "First tab" });
  assert.throws(
    () => second.saveDraft({ ...stale, notes: "Stale tab" }),
    /another tab|conflict/i,
  );
  assert.equal(first.getDraft("draft").notes, "First tab");
});
test("acknowledged remote save does not erase newer local edits", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  const initial = ws.saveDraft({ id: "draft", lines: [], notes: "one" });
  ws.saveDraft({ ...initial, notes: "two" });
  ws.markDraftSynced("draft", initial.localRevision, {
    id: "draft",
    version: 8,
  });
  assert.equal(ws.getDraft("draft").notes, "two");
  assert.equal(ws.getDraft("draft").syncState, "local");
  assert.equal(ws.getDraft("draft").version, 8);
});
test("backup imports only valid local draft records, rejects executable shapes", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  assert.throws(
    () =>
      ws.importBackup({
        format: "aw-workspace",
        version: 1,
        drafts: [{ id: "a", lines: "bad" }],
      }),
    /invalid/i,
  );
  assert.equal(ws.listDrafts().length, 0);
  ws.importBackup({
    format: "aw-workspace",
    version: 1,
    drafts: [{ id: "b", storeId: "store", lines: [] }],
    preferences: { theme: "light" },
  });
  assert.equal(ws.listDrafts()[0].id, "b");
  assert.equal(ws.preferences().theme, "light");
});

test("workspaces isolate drafts and commands by signed-in account", async () => {
  const { Workspace } = await load();
  const store = memory();
  const a = new Workspace(store, "customer-a"),
    b = new Workspace(store, "customer-b");
  a.saveDraft({ id: "draft", lines: [] });
  a.enqueue({ id: "command", type: "order.save", payload: { id: "draft" } });
  assert.equal(b.listDrafts().length, 0);
  assert.equal(b.pending().length, 0);
});
test("backup cannot import prototype property names as draft identifiers", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  assert.throws(
    () =>
      ws.importBackup({
        format: "aw-workspace",
        version: 1,
        drafts: [{ id: "__proto__", storeId: "store", lines: [] }],
      }),
    /invalid/i,
  );
});
test("failed import is atomic and preserves all existing drafts", async () => {
  const { Workspace } = await load();
  const ws = new Workspace(memory(), "test");
  ws.saveDraft({ id: "existing", lines: [], notes: "preserve" });
  assert.throws(
    () =>
      ws.importBackup({
        format: "aw-workspace",
        version: 1,
        drafts: [
          { id: "valid", storeId: "store", lines: [] },
          {
            id: "bad",
            lines: [{ productId: "p", quantity: -2, unit: "each" }],
          },
        ],
      }),
    /invalid/i,
  );
  assert.equal(ws.listDrafts().length, 1);
  assert.equal(ws.getDraft("existing").notes, "preserve");
});

async function helpers() {
  return import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(
          path.join(__dirname, "../public/view-helpers.js"),
          "utf8",
        ),
      ).toString("base64")
  );
}
test("legacy date-only orders retain their recorded calendar day", async () => {
  const { formatSavedDate } = await helpers();
  const original = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    assert.equal(formatSavedDate("2025-01-10"), "Jan 10, 2025");
    assert.equal(formatSavedDate("not-a-date"), "Date unavailable");
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
test("legacy relative catalog images resolve safely and reject traversal and script URLs", async () => {
  const { safeProductImage } = await helpers();
  assert.equal(
    safeProductImage("images/SS%20Cigarillos%20.jpg"),
    "/images/SS%20Cigarillos%20.jpg",
  );
  assert.equal(
    safeProductImage("/media/products/example.png"),
    "/media/products/example.png",
  );
  assert.equal(safeProductImage("/images/%2e%2e/server.js"), null);
  assert.equal(safeProductImage("javascript:alert(1)"), null);
});

async function sessions() {
  return import(
    "data:text/javascript;base64," +
      Buffer.from(
        fs.readFileSync(path.join(__dirname, "../public/session.js"), "utf8"),
      ).toString("base64")
  );
}
test("late private state response cannot apply after switching accounts", async () => {
  const { runSessionTask } = await sessions();
  let current = "alice",
    resolveRequest,
    applied = false;
  const request = new Promise((resolve) => (resolveRequest = resolve));
  const pending = runSessionTask(
    { uid: "alice" },
    (scope) => scope.uid === current,
    () => request,
    () => {
      applied = true;
    },
  );
  current = "bob";
  resolveRequest({ orders: ["alice-private-order"] });
  await assert.rejects(pending, /account changed/);
  assert.equal(applied, false);
});
test("late command acknowledgment cannot mutate the next account workspace", async () => {
  const { runSessionTask } = await sessions();
  const store = memory();
  const { Workspace } = await load();
  const alice = new Workspace(store, "alice"),
    bob = new Workspace(store, "bob");
  alice.enqueue({ id: "command", type: "order.submit", payload: { id: "a" } });
  bob.enqueue({ id: "command", type: "order.submit", payload: { id: "b" } });
  let generation = 1,
    resolveRequest;
  const request = new Promise((resolve) => (resolveRequest = resolve));
  const pending = runSessionTask(
    { generation: 1, workspace: alice },
    (scope) => scope.generation === generation,
    () => request,
    (_, scope) => scope.workspace.acknowledge("command"),
  );
  generation = 2;
  resolveRequest({ id: "a" });
  await assert.rejects(pending, /account changed/);
  assert.equal(alice.pending().length, 1);
  assert.equal(bob.pending().length, 1);
});
test("confirmed mutation remains successful when its following state refresh fails", async () => {
  const { afterConfirmation } = await sessions();
  const confirmed = { id: "payment-1", status: "pending" };
  let warned = false;
  const result = await afterConfirmation(
    confirmed,
    async () => {
      throw new Error("Network failed");
    },
    () => {
      warned = true;
    },
  );
  assert.equal(result, confirmed);
  assert.equal(warned, true);
});
test("late history pages cannot replace the active store, status, or refreshed cursor", async () => {
  const { createRequestGate } = await sessions();
  for (const reason of [
    "store changed",
    "status changed",
    "workspace refreshed",
  ]) {
    const gate = createRequestGate();
    let resolvePage;
    let orders = ["current-order"],
      cursor = "current-cursor";
    const pending = gate.run(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve;
        }),
      (page) => {
        orders = page.orders;
        cursor = page.nextCursor;
      },
    );
    gate.invalidate();
    resolvePage({ orders: ["stale-order"], nextCursor: "stale-cursor" });
    await pending;
    assert.deepEqual(orders, ["current-order"], reason);
    assert.equal(cursor, "current-cursor", reason);
  }
});
test("only the newest simultaneous history request applies its page", async () => {
  const { createRequestGate } = await sessions();
  const gate = createRequestGate();
  let resolveFirst, cursor;
  const first = gate.run(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    (value) => {
      cursor = value;
    },
  );
  await gate.run(
    async () => "newer-cursor",
    (value) => {
      cursor = value;
    },
  );
  resolveFirst("older-cursor");
  await first;
  assert.equal(cursor, "newer-cursor");
});
test("a draft being submitted cannot gain edits that acknowledgment would delete", async () => {
  const { Workspace } = await load();
  const storage = memory(),
    a = new Workspace(storage, "account"),
    b = new Workspace(storage, "account");
  a.saveDraft({ id: "draft", lines: [], notes: "submitted" });
  const before = b.getDraft("draft");
  a.enqueue({
    id: "submit-command",
    type: "order.submit",
    payload: { id: "draft" },
  });
  assert.throws(
    () => b.saveDraft({ ...before, notes: "would be lost" }),
    /submission|submitted/i,
  );
  assert.equal(b.getDraft("draft").notes, "submitted");
});
test("legacy recovery keeps variant quantities exact and flags malformed lines", async () => {
  const { recoverLegacyLines } = await helpers();
  const result = recoverLegacyLines(
    {
      lines: [
        {
          itemId: "p",
          entries: [
            { variant: "Lime", qty: "2" },
            { variant: "Orange", qty: "2x" },
          ],
          note: "retain note",
          except: "Blue",
        },
      ],
    },
    [{ id: "p", name: "Water", variants: ["Lime", "Orange"] }],
  );
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, 2);
  assert.equal(result.lines[0].variant, "Lime");
  assert.match(result.lines[0].note, /retain note.*Except: Blue/);
  assert.ok(result.warnings.some((w) => w.includes("2x")));
  assert.ok(result.warnings.some((w) => w.includes("unit")));
});
