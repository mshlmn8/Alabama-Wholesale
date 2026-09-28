const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(__dirname, "../public/store-operations.js");
const helpers = fs.existsSync(file)
  ? import(
      "data:text/javascript;base64," +
        Buffer.from(fs.readFileSync(file, "utf8")).toString("base64")
    )
  : Promise.resolve({});
const now = Date.UTC(2026, 8, 28, 12);
const product = {
  id: "juice",
  name: "Juice",
  variants: ["Apple", "Orange"],
  packSize: 12,
  categoryIds: ["drinks"],
  variantBarcodes: { Apple: "001234" },
};
function workspace() {
  let preferences = {};
  return {
    preferences: () => structuredClone(preferences),
    setPreferences: (values) => {
      preferences = { ...preferences, ...structuredClone(values) };
    },
  };
}
test("count payload preserves counted zero and uses only a known case conversion", async () => {
  const { prepareStoreCount } = await helpers;
  assert.equal(typeof prepareStoreCount, "function");
  const base = {
    storeId: "store-a",
    productId: "juice",
    variant: "Apple",
    quantity: "0",
    unit: "each",
    measuredAt: now,
    targetEach: "",
    note: "",
  };
  assert.deepEqual(prepareStoreCount(base, product, { version: 3 }, now), {
    ...base,
    quantity: 0,
    expectedVersion: 3,
    targetEach: null,
  });
  assert.equal(
    prepareStoreCount(
      { ...base, quantity: "2", unit: "case" },
      product,
      null,
      now,
    ).quantity,
    2,
  );
  assert.throws(
    () =>
      prepareStoreCount(
        { ...base, unit: "case" },
        { ...product, packSize: null },
        null,
        now,
      ),
    /pack size/i,
  );
  for (const quantity of ["", " ", "-1", "0.5", "1e3", "1000001"])
    assert.throws(
      () => prepareStoreCount({ ...base, quantity }, product, null, now),
      /quantity/i,
    );
  assert.throws(
    () =>
      prepareStoreCount(
        { ...base, measuredAt: now + 86400000 },
        product,
        null,
        now,
      ),
    /date|future/i,
  );
});
test("inventory search includes variant barcode, category and actual count low-stock filters", async () => {
  const { storeInventoryRows } = await helpers;
  assert.equal(typeof storeInventoryRows, "function");
  const records = [
    {
      productId: "juice",
      variant: "Apple",
      countEach: 0,
      targetEach: 12,
      measuredAt: now,
    },
  ];
  const rows = storeInventoryRows([product], records, {});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].record.countEach, 0);
  assert.equal(rows[1].record, null);
  assert.equal(
    storeInventoryRows([product], records, { query: "001234" })[0].variant,
    "Apple",
  );
  assert.equal(
    storeInventoryRows([product], records, { lowOnly: true }).length,
    1,
  );
  assert.equal(
    storeInventoryRows([product], records, { categoryId: "other" }).length,
    0,
  );
});
test("count drafts are isolated by actor and store and preserve separate observations", async () => {
  const { createStoreCountDrafts } = await helpers;
  assert.equal(typeof createStoreCountDrafts, "function");
  const ws = workspace();
  const a = createStoreCountDrafts(ws, "alice", "store-a");
  a.put({ id: "one", productId: "juice", quantity: "0" });
  a.put({ id: "two", productId: "juice", quantity: "2" });
  assert.equal(a.list().length, 2);
  assert.deepEqual(createStoreCountDrafts(ws, "alice", "store-b").list(), []);
  assert.deepEqual(createStoreCountDrafts(ws, "bob", "store-a").list(), []);
  assert.throws(() => createStoreCountDrafts(ws, "", "store-a"), /account/i);
  a.remove("one");
  assert.equal(a.list()[0].id, "two");
});
test("storage failure never claims a count draft was saved", async () => {
  const { createStoreCountDrafts } = await helpers;
  assert.equal(typeof createStoreCountDrafts, "function");
  const ws = workspace();
  const drafts = createStoreCountDrafts(ws, "alice", "store-a");
  drafts.put({ id: "one", quantity: "3" });
  ws.setPreferences = () => {
    throw new Error("Device storage unavailable");
  };
  assert.throws(() => drafts.put({ id: "one", quantity: "7" }), /storage/i);
  assert.equal(drafts.list()[0].quantity, "3");
});
test("failed count sync retains the observation and successful sync removes only that observation", async () => {
  const { createStoreCountDrafts, syncStoreCount } = await helpers;
  assert.equal(typeof syncStoreCount, "function");
  const ws = workspace(),
    drafts = createStoreCountDrafts(ws, "alice", "store-a");
  const entry = {
    id: "one",
    storeId: "store-a",
    productId: "juice",
    variant: "Apple",
    quantity: "0",
    unit: "each",
    measuredAt: now,
    targetEach: "",
    note: "",
    expectedVersion: 3,
  };
  drafts.put(entry);
  drafts.put({ ...entry, id: "two" });
  await assert.rejects(
    () =>
      syncStoreCount({
        entry,
        drafts,
        product,
        command: async () => {
          throw new Error("Conflict");
        },
        now,
      }),
    /Conflict/,
  );
  assert.equal(drafts.list().length, 2);
  let sent;
  await syncStoreCount({
    entry,
    drafts,
    product,
    command: async (...args) => {
      sent = args;
      return { countEach: 0 };
    },
    now,
  });
  assert.equal(sent[0], "storeInventory.count");
  assert.equal(sent[1].expectedVersion, 3);
  assert.equal(sent[2].storeCountDraftId, "one");
  assert.equal(drafts.list()[0].id, "two");
});
test("stale comparison cannot apply after draft revision, account, store or line changes", async () => {
  const { captureReplenishmentDraft, replenishmentDraftCurrent } =
    await helpers;
  assert.equal(typeof captureReplenishmentDraft, "function");
  const draft = {
    id: "draft-a",
    storeId: "store-a",
    localRevision: 5,
    version: 1,
    lines: [
      { productId: "juice", variant: "Apple", quantity: 1, unit: "each" },
    ],
  };
  const snapshot = captureReplenishmentDraft(draft, "alice");
  assert.equal(
    replenishmentDraftCurrent(
      snapshot,
      structuredClone(draft),
      "alice",
      "store-a",
    ),
    true,
  );
  assert.equal(
    replenishmentDraftCurrent(
      snapshot,
      { ...draft, localRevision: 6 },
      "alice",
      "store-a",
    ),
    false,
  );
  assert.equal(
    replenishmentDraftCurrent(snapshot, draft, "bob", "store-a"),
    false,
  );
  assert.equal(
    replenishmentDraftCurrent(snapshot, draft, "alice", "store-b"),
    false,
  );
  assert.equal(
    replenishmentDraftCurrent(
      snapshot,
      { ...draft, lines: [{ ...draft.lines[0], quantity: 2 }] },
      "alice",
      "store-a",
    ),
    false,
  );
});
test("suggestion line needs explicit available flavor and positive quantity; mix is not an exact flavor", async () => {
  const { prepareReplenishmentLine } = await helpers;
  assert.equal(typeof prepareReplenishmentLine, "function");
  const candidate = { productId: "juice", variant: "Apple", status: "missing" };
  assert.deepEqual(prepareReplenishmentLine(candidate, product, "2", "each"), {
    productId: "juice",
    variant: "Apple",
    quantity: 2,
    unit: "each",
    note: "",
  });
  for (const quantity of ["", "0", "-1", "1.5", "1000001"])
    assert.throws(
      () => prepareReplenishmentLine(candidate, product, quantity, "each"),
      /quantity/i,
    );
  assert.throws(
    () =>
      prepareReplenishmentLine(
        { ...candidate, variant: "Gone" },
        product,
        "2",
        "each",
      ),
    /flavor|available/i,
  );
  assert.throws(
    () =>
      prepareReplenishmentLine(
        { ...candidate, status: "unavailable" },
        product,
        "2",
        "each",
      ),
    /available/i,
  );
  assert.throws(
    () =>
      prepareReplenishmentLine(
        candidate,
        { ...product, packSize: null },
        "2",
        "case",
      ),
    /pack size/i,
  );
});

class TestNode {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.events = {};
    this.value = String(attrs.value ?? "");
    this.open = tag === "dialog";
    this.isConnected = true;
    this.classList = { add() {} };
    this.append(...children);
    for (const [key, fn] of Object.entries(attrs))
      if (key.startsWith("on")) this.events[key.slice(2).toLowerCase()] = fn;
  }
  append(...children) {
    this.children.push(
      ...children
        .flat(Infinity)
        .filter((child) => child != null && child !== false),
    );
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(key, value) {
    this.attrs[key] = value;
  }
  addEventListener(type, fn) {
    this.events[type] = fn;
  }
  focus() {}
  get textContent() {
    return (
      this.text ??
      this.children
        .map((child) =>
          child instanceof TestNode ? child.textContent : String(child),
        )
        .join(" ")
    );
  }
  set textContent(value) {
    this.children = [];
    this.text = value;
  }
  querySelector(tag) {
    return walk(this).find((node) => node.tag === tag);
  }
}
function walk(root) {
  return [
    root,
    ...root.children.filter((child) => child instanceof TestNode).flatMap(walk),
  ];
}
function uiHarness(api) {
  const ws = workspace(),
    dialogs = [],
    additions = [];
  const state = {
    actorId: "alice",
    store: { id: "store-a", name: "Store A" },
    draft: { id: "draft-a", storeId: "store-a", localRevision: 1, lines: [] },
  };
  const el = (tag, attrs, ...children) => new TestNode(tag, attrs, children);
  const context = {
    el,
    input: (type, value, attrs) => el("input", { type, value, ...attrs }),
    button: (text, fn) => {
      const node = el("button", {}, text);
      node.click = fn;
      return node;
    },
    field: (label, node, help) => el("div", {}, label, node, help),
    notice: (message) => el("aside", {}, message),
    table: (headers, rows) =>
      el("table", {}, el("thead", {}, headers), el("tbody", {}, rows)),
    td: (...children) => el("td", {}, children),
    modal: (title) => {
      const dialog = el("dialog", {}, title),
        content = el("div", {}),
        footer = el("footer", {});
      dialog.append(content, footer);
      const result = {
        dialog,
        content,
        footer,
        close: () => {
          dialog.open = false;
          dialog.events.close?.();
        },
      };
      dialogs.push(result);
      return result;
    },
    getActorId: () => state.actorId,
    getStore: () => state.store,
    getDraft: () => state.draft,
    getProducts: () => [product],
    getWorkspace: () => ws,
    scope: () => ({ actorId: state.actorId }),
    isCurrent: (saved) => saved.actorId === state.actorId,
    api,
    command: async () => ({}),
    toast: () => {},
    addLines: (lines) => {
      additions.push(...lines);
    },
    editDraft: (edit) => {
      edit(state.draft);
      state.draft.localRevision++;
    },
  };
  return {
    context,
    state,
    dialogs,
    additions,
    close: () => dialogs.forEach((dialog) => dialog.close()),
  };
}
const comparison = (overrides = {}) => ({
  analysis: {
    storeId: "store-a",
    reference: { id: "reference", placedAt: now - 6 * 86400000 },
    candidates: [
      {
        id: "candidate-apple",
        productId: "juice",
        variant: "Apple",
        name: "Juice",
        status: "missing",
        priorEach: 12,
        currentEach: 0,
        laterReceiptsEach: 0,
        latestCount: null,
        suggestion: {
          quantity: 2,
          unit: "each",
          planningDays: 7,
          targetEach: 2,
          availableEach: 0,
          pendingEach: 0,
        },
      },
    ],
    metrics: [],
    history: { complete: true },
    ...overrides,
  },
  ai: { available: false, status: "unavailable", explanations: [] },
});
test("missing-items UI renders deterministic fallback and blocks stale apply without touching the draft", async () => {
  const { createStoreOperations } = await helpers;
  const ui = uiHarness(async () => comparison());
  try {
    await createStoreOperations(ui.context).showMissingItems();
    const dialog = ui.dialogs[0];
    assert.match(dialog.content.textContent, /AI explanation unavailable/);
    assert.match(dialog.content.textContent, /Not counted/);
    const add = walk(dialog.content).find(
      (node) => node.tag === "button" && node.textContent === "Add to order",
    );
    ui.state.draft.localRevision++;
    assert.throws(() => add.click(), /order changed/i);
    assert.equal(ui.additions.length, 0);
  } finally {
    ui.close();
  }
});
test("comparison request that returns after a draft edit displays a refresh error and no actions", async () => {
  const { createStoreOperations } = await helpers;
  let resolve;
  const ui = uiHarness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  try {
    const request = createStoreOperations(ui.context).showMissingItems();
    ui.state.draft.lines = [
      {
        id: "new",
        productId: "juice",
        variant: "Apple",
        quantity: 3,
        unit: "each",
      },
    ];
    resolve(comparison());
    await request;
    assert.match(ui.dialogs[0].content.textContent, /order changed/i);
    assert.equal(
      walk(ui.dialogs[0].content).filter((node) => node.tag === "button")
        .length,
      0,
    );
  } finally {
    ui.close();
  }
});
test("current flavor quantity is adjusted to suggested total rather than added to itself", async () => {
  const { createStoreOperations } = await helpers;
  const result = comparison();
  result.analysis.candidates[0].status = "quantity-review";
  result.analysis.candidates[0].currentEach = 1;
  const ui = uiHarness(async () => result);
  ui.state.draft.lines = [
    {
      id: "line-apple",
      productId: "juice",
      variant: "Apple",
      quantity: 1,
      unit: "each",
      note: "Keep cold",
    },
  ];
  try {
    await createStoreOperations(ui.context).showMissingItems();
    const adjust = walk(ui.dialogs[0].content).find(
      (node) =>
        node.tag === "button" && node.textContent === "Adjust current quantity",
    );
    adjust.click();
    walk(ui.dialogs[1].footer)
      .find((node) => node.tag === "button")
      .click();
    assert.equal(ui.state.draft.lines[0].quantity, 2);
    assert.equal(ui.state.draft.lines[0].note, "Keep cold");
    assert.equal(ui.additions.length, 0);
  } finally {
    ui.close();
  }
});
test("skip feedback is attached to the reviewed draft and reference without changing quantities", async () => {
  const { createStoreOperations } = await helpers;
  const ui = uiHarness(async () => comparison());
  try {
    await createStoreOperations(ui.context).showMissingItems();
    walk(ui.dialogs[0].content)
      .find(
        (node) =>
          node.tag === "button" && node.textContent === "Skip this order",
      )
      .click();
    assert.equal(
      ui.state.draft.replenishmentFeedback[0].candidateId,
      "candidate-apple",
    );
    assert.equal(
      ui.state.draft.replenishmentFeedback[0].referenceId,
      "reference",
    );
    assert.equal(ui.state.draft.replenishmentFeedback[0].decision, "skip");
    assert.deepEqual(ui.state.draft.lines, []);
  } finally {
    ui.close();
  }
});

test("a changed case pack cannot silently reinterpret an offline observation", async () => {
  const { prepareStoreCount } = await helpers;
  const entry = {
    storeId: "store-a",
    productId: "juice",
    variant: "Apple",
    quantity: "2",
    unit: "case",
    packSize: 12,
    measuredAt: now,
    targetEach: "",
    note: "",
  };
  assert.equal(
    prepareStoreCount(entry, product, null, now).expectedPackSize,
    12,
  );
  assert.throws(
    () => prepareStoreCount(entry, { ...product, packSize: 24 }, null, now),
    /pack size.*changed/i,
  );
});
test("local cleanup failure reports that the server already confirmed the count", async () => {
  const { syncStoreCount } = await helpers;
  const entry = {
    id: "count-local",
    storeId: "store-a",
    productId: "juice",
    variant: "Apple",
    quantity: "2",
    unit: "each",
    measuredAt: now,
    targetEach: "",
    note: "",
  };
  await assert.rejects(
    () =>
      syncStoreCount({
        entry,
        product,
        drafts: {
          remove() {
            throw new Error("Storage blocked");
          },
        },
        command: async () => ({ saved: true }),
        now,
      }),
    /confirmed online.*local draft/i,
  );
});

test("inventory record pagination loads later counts without replacing initial history streams", async () => {
  const { loadStoreInventoryRecords } = await helpers;
  const calls = [];
  const pages = [
    {
      records: [
        { id: "r1", productId: "juice", variant: "Apple", countEach: 8 },
      ],
      counts: [{ id: "c1" }],
      movements: [{ id: "m1" }],
      history: {
        nextRecordsCursor: "r1",
        nextCountsCursor: "c1",
        nextMovementsCursor: null,
      },
    },
    {
      records: [
        { id: "r1", countEach: 1 },
        { id: "r2", productId: "juice", variant: "Orange", countEach: 42 },
      ],
      counts: [{ id: "wrong-count-page" }],
      movements: [{ id: "wrong-movement-page" }],
      history: { nextRecordsCursor: null, nextCountsCursor: "wrong-cursor" },
    },
  ];
  const result = await loadStoreInventoryRecords({
    path: "/inventory",
    isCurrent: () => true,
    api: async (path) => {
      calls.push(path);
      return pages.shift();
    },
  });
  assert.deepEqual(calls, [
    "/inventory?limit=500",
    "/inventory?limit=500&recordsCursor=r1",
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].countEach, 8);
  assert.equal(result.records[1].countEach, 42);
  assert.deepEqual(result.counts, [{ id: "c1" }]);
  assert.deepEqual(result.movements, [{ id: "m1" }]);
  assert.equal(result.history.recordsComplete, true);
  assert.equal(result.history.nextCountsCursor, "c1");
});
test("inventory pagination exposes its bound and discards a page returned after account change", async () => {
  const { loadStoreInventoryRecords } = await helpers;
  let calls = 0;
  const bounded = await loadStoreInventoryRecords({
    path: "/inventory",
    maxPages: 2,
    isCurrent: () => true,
    api: async () => {
      calls++;
      return {
        records: [{ id: "r" + calls }],
        history: { nextRecordsCursor: "r" + calls },
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(bounded.history.recordsComplete, false);
  assert.equal(bounded.history.recordsTruncated, true);
  let current = true;
  calls = 0;
  await assert.rejects(
    () =>
      loadStoreInventoryRecords({
        path: "/inventory",
        isCurrent: () => current,
        api: async () => {
          calls++;
          current = false;
          return {
            records: [{ id: "private-old-account" }],
            history: { nextRecordsCursor: "next" },
          };
        },
      }),
    /account or store changed/i,
  );
  assert.equal(calls, 1);
});
test("older inventory history advances independent cursors without restarting an exhausted stream", async () => {
  const { loadOlderStoreInventoryHistory } = await helpers;
  const initial = {
    records: [{ id: "r1" }],
    counts: [{ id: "c1" }],
    movements: [{ id: "m1" }],
    history: {
      recordsComplete: true,
      nextCountsCursor: "c1",
      nextMovementsCursor: null,
    },
  };
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    return {
      counts: [{ id: "c1" }, { id: "c2" }],
      movements: [{ id: "must-not-append" }],
      history: {
        nextCountsCursor: null,
        nextMovementsCursor: "must-not-restart",
      },
    };
  };
  const result = await loadOlderStoreInventoryHistory({
    path: "/inventory",
    data: initial,
    api,
    isCurrent: () => true,
  });
  assert.deepEqual(calls, ["/inventory?limit=500&countsCursor=c1"]);
  assert.deepEqual(
    result.counts.map((row) => row.id),
    ["c1", "c2"],
  );
  assert.deepEqual(result.movements, initial.movements);
  assert.equal(result.history.nextMovementsCursor, null);
  await loadOlderStoreInventoryHistory({
    path: "/inventory",
    data: result,
    api,
    isCurrent: () => true,
  });
  assert.equal(calls.length, 1);
  assert.equal(initial.counts.length, 1);
});
test("placed-order pagination deduplicates IDs, stops at exhaustion and rejects late account results", async () => {
  const { loadPlacedOrdersPage } = await helpers;
  const initial = { placements: [{ id: "p1" }], history: { nextCursor: "p1" } };
  let calls = 0;
  const result = await loadPlacedOrdersPage({
    path: "/placements",
    data: initial,
    isCurrent: () => true,
    api: async (path) => {
      calls++;
      assert.equal(path, "/placements?limit=500&cursor=p1");
      return {
        placements: [{ id: "p1" }, { id: "p2" }],
        history: { nextCursor: null },
      };
    },
  });
  assert.deepEqual(
    result.placements.map((row) => row.id),
    ["p1", "p2"],
  );
  await loadPlacedOrdersPage({
    path: "/placements",
    data: result,
    isCurrent: () => true,
    api: async () => {
      calls++;
    },
  });
  assert.equal(calls, 1);
  let current = true;
  await assert.rejects(
    () =>
      loadPlacedOrdersPage({
        path: "/placements",
        data: initial,
        isCurrent: () => current,
        api: async () => {
          current = false;
          return { placements: [{ id: "private" }], history: {} };
        },
      }),
    /account or store changed/i,
  );
  assert.deepEqual(initial.placements, [{ id: "p1" }]);
});
test("inventory UI finds a physical count on the second record page", async () => {
  const { createStoreOperations } = await helpers;
  const calls = [];
  const ui = uiHarness(async (path) => {
    calls.push(path);
    if (path.endsWith("replenishment")) return { analysis: { metrics: [] } };
    if (path.includes("recordsCursor="))
      return {
        records: [
          { id: "r2", productId: "juice", variant: "Orange", countEach: 42 },
        ],
        history: { nextRecordsCursor: null },
      };
    return {
      records: [
        { id: "r1", productId: "juice", variant: "Apple", countEach: 8 },
      ],
      counts: [],
      movements: [],
      history: { nextRecordsCursor: "r1" },
    };
  });
  try {
    const root = createStoreOperations(ui.context).renderInventory();
    await new Promise((resolve) => setImmediate(resolve));
    const row = walk(root).find(
      (node) => node.tag === "tr" && node.textContent.includes("Orange"),
    );
    assert.match(row.textContent, /42 each/);
    assert.doesNotMatch(row.textContent, /Not counted/);
    assert.ok(
      calls.includes(
        "/api/stores/store-a/inventory?limit=500&recordsCursor=r1",
      ),
    );
  } finally {
    ui.close();
  }
});
test("inventory UI marks missing records as not loaded when automatic pagination reaches its bound", async () => {
  const { createStoreOperations } = await helpers;
  let pages = 0;
  const ui = uiHarness(async (path) => {
    if (path.endsWith("replenishment")) return { analysis: { metrics: [] } };
    pages++;
    return {
      records: [
        { id: "r" + pages, productId: "other-product-" + pages, countEach: 3 },
      ],
      counts: [],
      movements: [],
      history: { nextRecordsCursor: "r" + pages },
    };
  });
  try {
    const root = createStoreOperations(ui.context).renderInventory();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pages, 20);
    assert.match(root.textContent, /Inventory loading stopped/);
    assert.match(root.textContent, /Not loaded/);
    assert.doesNotMatch(root.textContent, /Not counted/);
  } finally {
    ui.close();
  }
});
test("history UI loads older observations once and removes the control at exhaustion", async () => {
  const { createStoreOperations } = await helpers;
  const count = {
    id: "c1",
    productId: "juice",
    variant: "Apple",
    countEach: 8,
    measuredAt: now,
    note: "first observation",
  };
  let olderCalls = 0;
  const ui = uiHarness(async (path) => {
    if (path.endsWith("replenishment")) return { analysis: { metrics: [] } };
    if (path.includes("countsCursor=")) {
      olderCalls++;
      return {
        counts: [
          count,
          {
            ...count,
            id: "c2",
            measuredAt: now - 1,
            note: "older observation",
          },
        ],
        movements: [
          {
            id: "unrequested",
            productId: "juice",
            variant: "Apple",
            reason: "must stay absent",
          },
        ],
        history: { nextCountsCursor: null, nextMovementsCursor: "wrong" },
      };
    }
    return {
      records: [
        { id: "r1", productId: "juice", variant: "Apple", countEach: 8 },
      ],
      counts: [count],
      movements: [],
      history: {
        nextRecordsCursor: null,
        nextCountsCursor: "c1",
        nextMovementsCursor: null,
      },
    };
  });
  try {
    const root = createStoreOperations(ui.context).renderInventory();
    await new Promise((resolve) => setImmediate(resolve));
    walk(root)
      .find((node) => node.tag === "button" && node.textContent === "History")
      .click();
    const content = ui.dialogs[0].content;
    await walk(content)
      .find(
        (node) =>
          node.tag === "button" && node.textContent === "Load older history",
      )
      .click();
    assert.equal(olderCalls, 1);
    assert.match(content.textContent, /older observation/);
    assert.equal(content.textContent.split("first observation").length - 1, 1);
    assert.doesNotMatch(content.textContent, /must stay absent/);
    assert.equal(
      walk(content).some(
        (node) =>
          node.tag === "button" && node.textContent === "Load older history",
      ),
      false,
    );
  } finally {
    ui.close();
  }
});
test("placement UI loads older orders without duplicate cards and drops a late result after account change", async () => {
  const { createStoreOperations } = await helpers;
  let resolveLate;
  const placed = (id) => ({
    id,
    orderNumber: id,
    placedAt: now,
    lines: [],
    provenance: "submitted",
  });
  const ui = uiHarness(async (path) => {
    if (path.includes("cursor=p2"))
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    if (path.includes("cursor=p1"))
      return {
        placements: [placed("p1"), placed("p2")],
        history: { nextCursor: "p2" },
      };
    return { placements: [placed("p1")], history: { nextCursor: "p1" } };
  });
  try {
    const root = createStoreOperations(ui.context).renderPlacementHistory();
    await new Promise((resolve) => setImmediate(resolve));
    await walk(root)
      .find(
        (node) =>
          node.tag === "button" &&
          node.textContent === "Load older placed orders",
      )
      .click();
    assert.equal(walk(root).filter((node) => node.tag === "article").length, 2);
    const pending = walk(root)
      .find(
        (node) =>
          node.tag === "button" &&
          node.textContent === "Load older placed orders",
      )
      .click();
    ui.state.actorId = "bob";
    resolveLate({
      placements: [placed("private-late-order")],
      history: { nextCursor: null },
    });
    await pending;
    assert.doesNotMatch(root.textContent, /private-late-order/);
    assert.equal(walk(root).filter((node) => node.tag === "article").length, 2);
  } finally {
    ui.close();
  }
});
