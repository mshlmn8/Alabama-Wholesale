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

test("empty and unchanged cloud merges do not write browser storage", async () => {
  const { Workspace } = await load();
  const store = memory();
  const ws = new Workspace(store, "no-op");
  const remote = { id: "cloud", status: "draft", version: 4, lines: [] };
  ws.mergeRemoteDrafts([remote]);
  ws.saveDraft({ id: "local", lines: [], notes: "Keep local edits" });
  const before = store.getItem(ws.key);
  let writes = 0;
  store.setItem = () => {
    writes++;
    throw Error("quota");
  };
  assert.doesNotThrow(() => ws.mergeRemoteDrafts([]));
  assert.doesNotThrow(() =>
    ws.mergeRemoteDrafts([remote, { ...remote, id: "local", version: 99 }]),
  );
  assert.equal(writes, 0);
  assert.equal(store.getItem(ws.key), before);
  assert.equal(ws.storageStatus().warning, null);
});

test("quota during cloud caching preserves durable drafts and queue while cloud drafts remain readable", async () => {
  const { Workspace } = await load();
  const store = memory();
  const ws = new Workspace(store, "owner");
  ws.saveDraft({
    id: "local",
    storeId: "shop",
    lines: [{ productId: "p", quantity: 2, unit: "each" }],
    notes: "Unsynced work",
  });
  const command = {
    id: "pending",
    type: "order.save",
    payload: { id: "local", notes: "Unsynced work" },
  };
  ws.enqueue(command);
  store.setItem("legacy-key", "Preserve old browser data");
  const before = store.getItem(ws.key);
  store.setItem = () => {
    throw Error("QuotaExceededError");
  };
  const remote = {
    id: "cloud",
    storeId: "shop",
    status: "draft",
    version: 4,
    lines: [{ productId: "p", quantity: 3, unit: "case" }],
  };
  assert.doesNotThrow(() => ws.mergeRemoteDrafts([remote]));
  assert.equal(ws.getDraft("cloud").lines[0].quantity, 3);
  assert.equal(ws.listDrafts().length, 2);
  assert.equal(ws.getDraft("local").notes, "Unsynced work");
  assert.deepEqual(ws.pending()[0].command, command);
  assert.equal(store.getItem(ws.key), before);
  assert.equal(store.getItem("legacy-key"), "Preserve old browser data");
  assert.match(ws.storageStatus().warning, /storage|device/i);
  assert.equal(ws.storageStatus().remoteDraftCount, 1);
  assert.equal(
    new Workspace(store, "owner").getDraft("cloud"),
    null,
    "The cache is explicitly temporary until persistence succeeds.",
  );
  const another = new Workspace(store, "another-account");
  assert.equal(another.listDrafts().length, 0);
  assert.equal(another.storageStatus().warning, null);
  ws.mergeRemoteDrafts([{ ...remote, version: 5, notes: "New cloud version" }]);
  assert.equal(ws.getDraft("cloud").version, 5);
  assert.equal(store.getItem(ws.key), before);
});

test("optional preferences can remain temporary but user writes still fail truthfully under quota", async () => {
  const { Workspace, StorageFailure } = await load();
  const store = memory();
  const ws = new Workspace(store, "owner");
  ws.setPreferences({ theme: "light" });
  ws.enqueue({ id: "old", type: "order.save", payload: { id: "existing" } });
  const before = store.getItem(ws.key);
  store.setItem = () => {
    throw Error("quota");
  };
  ws.mergeRemoteDrafts([
    {
      id: "cloud",
      status: "draft",
      version: 2,
      lines: [{ productId: "p", quantity: 2, unit: "each" }],
    },
  ]);
  assert.doesNotThrow(() =>
    ws.rememberPreferences({ theme: "dark", storeId: "shop" }),
  );
  assert.equal(ws.preferences().theme, "dark");
  assert.equal(ws.storageStatus().preferencesTemporary, true);
  const cloud = ws.getDraft("cloud");
  assert.throws(
    () => ws.saveDraft({ ...cloud, notes: "Must not silently save" }),
    StorageFailure,
  );
  assert.equal(ws.getDraft("cloud").notes, undefined);
  assert.throws(
    () =>
      ws.enqueue({ id: "new", type: "order.save", payload: { id: "cloud" } }),
    StorageFailure,
  );
  assert.throws(
    () =>
      ws.importBackup({
        format: "aw-workspace",
        version: 1,
        drafts: [{ id: "imported", lines: [] }],
      }),
    StorageFailure,
  );
  assert.throws(() => ws.setPreferences({ theme: "light" }), StorageFailure);
  assert.equal(ws.getDraft("imported"), null);
  assert.equal(ws.preferences().theme, "dark");
  assert.equal(ws.pending().length, 1);
  assert.equal(store.getItem(ws.key), before);
  const exported = ws.exportBackup();
  assert.equal(
    exported.drafts.find((draft) => draft.id === "cloud").lines[0].quantity,
    2,
  );
  assert.equal(exported.preferences.theme, "dark");
  assert.deepEqual(exported.queue, ws.pending());
  const restored = new Workspace(memory(), "restored");
  restored.importBackup(exported);
  assert.equal(
    restored.pending().length,
    0,
    "Backup import must never replay saved commands automatically.",
  );
});

test("explicit storage retry preserves queued work and durably caches the current cloud view", async () => {
  const { Workspace, StorageFailure } = await load();
  const store = memory();
  const ws = new Workspace(store, "owner");
  ws.saveDraft({ id: "local", lines: [], notes: "Preserve" });
  ws.enqueue({ id: "queued", type: "order.save", payload: { id: "local" } });
  const write = store.setItem;
  store.setItem = () => {
    throw Error("quota");
  };
  ws.mergeRemoteDrafts([
    { id: "cloud", status: "draft", version: 3, lines: [] },
  ]);
  ws.rememberPreferences({ theme: "dark" });
  assert.throws(() => ws.retryStorage(), StorageFailure);
  assert.equal(ws.storageStatus().remoteDraftCount, 1);
  let writes = 0;
  store.setItem = (key, value) => {
    writes++;
    write(key, value);
  };
  ws.retryStorage();
  assert.equal(writes, 1);
  assert.deepEqual(ws.storageStatus(), {
    warning: null,
    remoteDraftCount: 0,
    preferencesTemporary: false,
  });
  const reloaded = new Workspace(store, "owner");
  assert.equal(reloaded.getDraft("cloud").version, 3);
  assert.equal(reloaded.getDraft("local").notes, "Preserve");
  assert.equal(reloaded.preferences().theme, "dark");
  assert.equal(reloaded.pending()[0].command.id, "queued");
  ws.retryStorage();
  assert.equal(
    writes,
    2,
    "Retry must actually probe durable storage even without cached changes.",
  );
});

test("saving one temporary cloud draft succeeds independently of an oversized optional cache", async () => {
  const { Workspace } = await load();
  const store = memory();
  const ws = new Workspace(store, "owner");
  const write = store.setItem;
  store.setItem = () => {
    throw Error("quota");
  };
  ws.mergeRemoteDrafts([
    { id: "selected", status: "draft", version: 3, lines: [] },
    {
      id: "large",
      status: "draft",
      version: 1,
      notes: "x".repeat(10000),
      lines: [],
    },
  ]);
  store.setItem = (key, value) => {
    if (value.length > 2000) throw Error("quota");
    write(key, value);
  };
  ws.rememberPreferences({ theme: "dark" });
  assert.equal(JSON.parse(store.getItem(ws.key)).drafts.large, undefined);
  const saved = ws.saveDraft({
    ...ws.getDraft("selected"),
    notes: "Now saved",
  });
  assert.equal(saved.syncState, "local");
  assert.equal(
    new Workspace(store, "owner").getDraft("selected").notes,
    "Now saved",
  );
  assert.equal(ws.storageStatus().remoteDraftCount, 1);
  ws.removeDraft("large");
  assert.equal(ws.getDraft("large"), null);
  assert.equal(ws.storageStatus().warning, null);
});

test("temporary cloud revisions cannot conceal another tab's durable edit", async () => {
  const { Workspace, DraftConflict } = await load();
  const store = memory();
  const first = new Workspace(store, "owner");
  first.mergeRemoteDrafts([
    { id: "shared", status: "draft", version: 1, lines: [], notes: "Original" },
  ]);
  const write = store.setItem;
  store.setItem = () => {
    throw Error("quota");
  };
  first.mergeRemoteDrafts([
    {
      id: "shared",
      status: "draft",
      version: 2,
      lines: [],
      notes: "Cloud update",
    },
  ]);
  const stale = first.getDraft("shared");
  store.setItem = write;
  const second = new Workspace(store, "owner");
  second.saveDraft({ ...second.getDraft("shared"), notes: "Other tab's edit" });
  assert.throws(
    () => first.saveDraft({ ...stale, notes: "Stale overwrite" }),
    DraftConflict,
  );
  first.retryStorage();
  assert.equal(first.getDraft("shared").notes, "Other tab's edit");
});

test("strict write failures set a visible warning without replacing unreadable data", async () => {
  const { Workspace, StorageFailure } = await load();
  const store = memory();
  const ws = new Workspace(store, "owner");
  const write = store.setItem;
  store.setItem = () => {
    throw Error("quota");
  };
  assert.throws(
    () => ws.enqueue({ id: "save", type: "order.save", payload: {} }),
    StorageFailure,
  );
  assert.match(ws.storageStatus().warning, /storage|device/i);
  store.setItem = write;
  ws.retryStorage();
  assert.equal(ws.storageStatus().warning, null);
  store.setItem(ws.key, "corrupt browser evidence");
  assert.throws(() => ws.mergeRemoteDrafts([]), StorageFailure);
  assert.throws(
    () => ws.rememberPreferences({ theme: "dark" }),
    StorageFailure,
  );
  assert.throws(() => ws.retryStorage(), StorageFailure);
  assert.equal(store.getItem(ws.key), "corrupt browser evidence");
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
test("order summaries fetch complete saved lines before reorder and return review", async () => {
  const { loadOrderDetails } = await sessions();
  const summary = {
    id: "history-one",
    storeId: "store",
    status: "delivered",
    summary: true,
  };
  const original = {
    ...summary,
    summary: undefined,
    lines: [
      {
        id: "line",
        productId: "p",
        quantity: 2,
        unit: "case",
        packSize: 12,
        unitPriceCents: 500,
      },
    ],
  };
  let calls = 0;
  const result = await loadOrderDetails(summary, async (id) => {
    calls++;
    assert.equal(id, summary.id);
    return { order: original };
  });
  assert.equal(result, original);
  assert.equal(result.lines[0].quantity, 2);
  assert.equal(calls, 1);
  assert.equal(
    await loadOrderDetails(original, () => {
      throw new Error("unexpected read");
    }),
    original,
  );
  assert.equal(summary.lines, undefined);
});
test("failed or mismatched order detail cannot become an empty reorder", async () => {
  const { loadOrderDetails, runSessionTask } = await sessions();
  const summary = { id: "history-one", summary: true };
  await assert.rejects(
    () =>
      loadOrderDetails(summary, async () => {
        throw new Error("Offline");
      }),
    /Offline/,
  );
  await assert.rejects(
    () =>
      loadOrderDetails(summary, async () => ({
        order: { id: "another", lines: [] },
      })),
    /complete order/i,
  );
  await assert.rejects(
    () => loadOrderDetails(summary, async () => ({ order: summary })),
    /complete order/i,
  );
  let current = "alice",
    resolveRequest;
  const pending = loadOrderDetails(summary, () =>
    runSessionTask(
      "alice",
      (uid) => uid === current,
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    ),
  );
  current = "bob";
  resolveRequest({ order: { id: summary.id, lines: [] } });
  await assert.rejects(pending, /account changed/);
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

test("historical order action produces a historical PDF without requiring frozen prices", async () => {
  const { orderDocumentOptions } = await helpers();
  const { renderDocument } = require("../lib/documents.cjs");
  const legacy = {
    id: "hist-example",
    storeId: "store1",
    status: "legacy",
    legacy: { needsPriceReview: true, date: "2025-01-10" },
    lines: [{ productId: "p1", name: "Saved item", quantity: 2 }],
    totalCents: 1234,
    billText: "Original saved bill: $12.34",
  };
  const options = orderDocumentOptions(legacy);
  assert.deepEqual(options, [["historical-copy", "Historical copy"]]);
  const pdf = await renderDocument(
    legacy,
    { id: "store1", name: "Example Market" },
    options[0][0],
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.deepEqual(
    orderDocumentOptions({ ...legacy, status: "delivered" }),
    options,
  );
});

test("finalized orders retain valid invoice and fulfillment documents while drafts expose none", async () => {
  const { orderDocumentOptions } = await helpers();
  const { renderDocument } = require("../lib/documents.cjs");
  const order = {
    id: "order1",
    storeId: "store1",
    status: "submitted",
    invoiceNumber: "AW-2026-000001",
    lines: [
      {
        productId: "p1",
        name: "Saved item",
        quantity: 2,
        unit: "each",
        unitPriceCents: 500,
        lineTotalCents: 1000,
        taxCents: 80,
      },
    ],
    subtotalCents: 1000,
    taxCents: 80,
    totalCents: 1080,
  };
  const options = orderDocumentOptions(order);
  assert.deepEqual(
    options.map(([kind]) => kind),
    ["invoice", "pick-list", "delivery-note"],
  );
  for (const [kind] of options) {
    const pdf = await renderDocument(
      order,
      { id: "store1", name: "Store" },
      kind,
    );
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  }
  assert.deepEqual(orderDocumentOptions({ ...order, status: "draft" }), []);
  assert.deepEqual(
    orderDocumentOptions({ ...order, missingPriceSnapshots: true }),
    [["historical-copy", "Historical copy"]],
  );
});

test("explicit cloud staging retains quota-failed edits without claiming device durability", async () => {
  const { Workspace, StorageFailure } = await load();
  const store = memory(),
    ws = new Workspace(store, "cloud-stage");
  const first = ws.saveDraft({
    id: "draft",
    storeId: "shop",
    lines: [],
    notes: "old",
    version: 0,
  });
  const original = store.getItem(ws.key);
  store.setItem = () => {
    throw Error("quota");
  };
  const staged = ws.saveDraftForCloud({ ...first, notes: "new" });
  assert.equal(staged.localPersisted, false);
  assert.equal(ws.getDraft("draft").notes, "new");
  assert.ok(staged.draft.localRevision > first.localRevision);
  assert.equal(ws.localDraftStatus("draft").localPersisted, false);
  assert.equal(ws.exportBackup().drafts[0].notes, "new");
  assert.equal(store.getItem(ws.key), original);
  assert.throws(
    () =>
      ws.enqueue({
        id: "submit",
        type: "order.submit",
        payload: { id: "draft" },
      }),
    StorageFailure,
  );
  assert.equal(new Workspace(store, "other").getDraft("draft"), null);
});
test("cloud acknowledgements stay confirmed under quota and retain newer edits", async () => {
  const { Workspace } = await load();
  const store = memory(),
    ws = new Workspace(store, "cloud-ack");
  const initial = ws.saveDraft({
    id: "draft",
    storeId: "shop",
    lines: [],
    notes: "original",
    version: 0,
  });
  const raw = store.getItem(ws.key);
  store.setItem = () => {
    throw Error("quota");
  };
  const sent = ws.saveDraftForCloud({ ...initial, notes: "sent" }).draft;
  const latest = ws.saveDraftForCloud({ ...sent, notes: "newer" }).draft;
  const ack = ws.ackCloudDraft(sent, { ...sent, status: "draft", version: 1 });
  assert.equal(ack.draft.notes, "newer");
  assert.equal(ack.draft.localRevision, latest.localRevision);
  assert.equal(ack.draft.version, 1);
  assert.equal(ack.draft.syncState, "local");
  assert.equal(ack.localPersisted, false);
  const final = ws.ackCloudDraft(ack.draft, {
    ...ack.draft,
    status: "draft",
    version: 2,
  });
  assert.equal(final.draft.syncState, "synced");
  assert.equal(final.draft.notes, "newer");
  assert.equal(store.getItem(ws.key), raw);
});
test("working drafts preserve another tab edits and refuse to overwrite them during retry", async () => {
  const { Workspace, DraftConflict } = await load();
  const store = memory(),
    originalSet = store.setItem;
  const a = new Workspace(store, "tabs-cloud"),
    b = new Workspace(store, "tabs-cloud");
  const saved = a.saveDraft({
    id: "draft",
    lines: [],
    notes: "first",
    version: 0,
  });
  store.setItem = () => {
    throw Error("quota");
  };
  const working = a.saveDraftForCloud({ ...saved, notes: "A unsaved" }).draft;
  store.setItem = originalSet;
  b.saveDraft({ ...saved, notes: "B newer" });
  const raw = store.getItem(a.key);
  assert.equal(a.getDraft("draft").notes, "A unsaved");
  assert.equal(a.localDraftStatus("draft").conflicted, true);
  assert.throws(
    () => a.saveDraftForCloud({ ...working, notes: "A retry" }),
    DraftConflict,
  );
  assert.throws(() => a.retryStorage(), DraftConflict);
  const ack = a.ackCloudDraft(working, {
    ...working,
    status: "draft",
    version: 1,
  });
  assert.equal(ack.draft.version, 1);
  assert.equal(ack.localPersisted, false);
  assert.equal(store.getItem(a.key), raw);
});
test("autosave recovery retains immutable request bodies and tombstones without replaying imports", async () => {
  const { Workspace } = await load();
  const store = memory(),
    ws = new Workspace(store, "recovery");
  const recovery = {
    command: {
      id: "stable",
      type: "order.save",
      payload: { id: "draft", lines: [], notes: "sent", expectedVersion: 0 },
    },
    sentDraft: { id: "draft", lines: [], notes: "sent", localRevision: 1 },
  };
  ws.rememberDraftSave("draft", recovery);
  assert.deepEqual(
    new Workspace(store, "recovery").autosaveRecovery().draft,
    recovery,
  );
  store.setItem = () => {
    throw Error("quota");
  };
  ws.rememberDraftSave("draft", null);
  assert.deepEqual(ws.autosaveRecovery(), {});
  assert.deepEqual(ws.exportBackup().draftAutosave, {});
  assert.deepEqual(
    new Workspace(store, "recovery").autosaveRecovery().draft,
    recovery,
  );
  const other = new Workspace(memory(), "import");
  other.importBackup({
    format: "aw-workspace",
    version: 1,
    drafts: [],
    draftAutosave: { draft: recovery },
  });
  assert.deepEqual(other.autosaveRecovery(), {});
});
test("retry saves working drafts, exact recovery and preferences without changing queued commands", async () => {
  const { Workspace } = await load();
  const store = memory(),
    set = store.setItem,
    ws = new Workspace(store, "retry-working");
  ws.enqueue({
    id: "pending",
    type: "payment.report",
    payload: { amountCents: 100 },
  });
  store.setItem = () => {
    throw Error("quota");
  };
  const staged = ws.saveDraftForCloud({
    id: "draft",
    lines: [],
    notes: "keep",
    version: 0,
  }).draft;
  ws.rememberDraftSave("draft", {
    command: {
      id: "retry",
      type: "order.save",
      payload: { id: "draft", lines: [], expectedVersion: 0 },
    },
    sentDraft: staged,
  });
  ws.rememberPreferences({ storeId: "shop" });
  store.setItem = set;
  ws.retryStorage();
  const reloaded = new Workspace(store, "retry-working");
  assert.equal(reloaded.getDraft("draft").notes, "keep");
  assert.equal(reloaded.getDraft("draft").localRevision, staged.localRevision);
  assert.equal(ws.localDraftStatus("draft").localPersisted, true);
  assert.equal(reloaded.autosaveRecovery().draft.command.id, "retry");
  assert.equal(reloaded.pending()[0].command.id, "pending");
  assert.equal(reloaded.preferences().storeId, "shop");
});
test("cloud staging cannot change a draft queued for submission", async () => {
  const { Workspace } = await load();
  const store = memory(),
    ws = new Workspace(store, "submit-block");
  const draft = ws.saveDraft({ id: "draft", lines: [] });
  ws.enqueue({ id: "submit", type: "order.submit", payload: { id: "draft" } });
  store.setItem = () => {
    throw Error("quota");
  };
  assert.throws(
    () => ws.saveDraftForCloud({ ...draft, notes: "unsafe" }),
    /being submitted/,
  );
  assert.equal(ws.getDraft("draft").notes, undefined);
});

test("cloud reload is explicit, durable when possible, and cannot erase another tab working copy", async () => {
  const { Workspace, DraftConflict } = await load();
  const store = memory(),
    ws = new Workspace(store, "reload");
  const local = ws.saveDraft({
    id: "draft",
    status: "draft",
    lines: [],
    notes: "local",
    version: 1,
  });
  const remote = {
    id: "draft",
    status: "draft",
    lines: [],
    notes: "online",
    version: 2,
  };
  assert.throws(
    () => ws.reloadDraftFromCloud(remote, local.localRevision - 1),
    DraftConflict,
  );
  const loaded = ws.reloadDraftFromCloud(remote, local.localRevision);
  assert.equal(loaded.localPersisted, true);
  assert.equal(loaded.draft.syncState, "synced");
  assert.equal(loaded.draft.notes, "online");
  const before = store.getItem(ws.key);
  store.setItem = () => {
    throw Error("quota");
  };
  const newer = ws.reloadDraftFromCloud(
    { ...remote, notes: "new online", version: 3 },
    loaded.draft.localRevision,
  );
  assert.equal(newer.localPersisted, false);
  assert.equal(ws.getDraft("draft").notes, "new online");
  assert.equal(store.getItem(ws.key), before);
});
test("imports preserve session-only drafts and cloud acknowledgement keeps newer durable fields", async () => {
  const { Workspace } = await load();
  const store = memory(),
    set = store.setItem,
    ws = new Workspace(store, "preserve-stage");
  const initial = ws.saveDraft({
    id: "draft",
    status: "draft",
    lines: [],
    notes: "sent",
    version: 0,
  });
  const newer = ws.saveDraft({ ...initial, notes: "newer local" });
  const ack = ws.ackCloudDraft(initial, { ...initial, version: 1 });
  assert.equal(ack.draft.notes, "newer local");
  assert.equal(ack.draft.localRevision, newer.localRevision);
  assert.equal(ack.draft.syncState, "local");
  store.setItem = () => {
    throw Error("quota");
  };
  ws.saveDraftForCloud({
    id: "memory",
    status: "draft",
    lines: [],
    notes: "session only",
    version: 0,
  });
  store.setItem = set;
  const result = ws.importBackup({
    format: "aw-workspace",
    version: 1,
    drafts: [{ id: "memory", lines: [], notes: "old backup" }],
  });
  assert.equal(result.skipped, 1);
  assert.equal(ws.getDraft("memory").notes, "session only");
});

test("a replaced local draft with reused revision numbers is not overwritten by a working copy", async () => {
  const { Workspace, DraftConflict } = await load();
  const store = memory(),
    set = store.setItem,
    ws = new Workspace(store, "revision-reuse");
  const saved = ws.saveDraft({
    id: "draft",
    status: "draft",
    version: 0,
    lines: [],
    notes: "original",
  });
  store.setItem = () => {
    throw Error("quota");
  };
  ws.saveDraftForCloud({ ...saved, notes: "session copy" });
  store.setItem = set;
  const data = JSON.parse(store.getItem(ws.key));
  data.drafts.draft.notes = "restored from a different backup";
  store.setItem(ws.key, JSON.stringify(data));
  assert.equal(ws.localDraftStatus("draft").conflicted, true);
  assert.throws(() => ws.retryStorage(), DraftConflict);
  assert.equal(
    JSON.parse(store.getItem(ws.key)).drafts.draft.notes,
    "restored from a different backup",
  );
});
