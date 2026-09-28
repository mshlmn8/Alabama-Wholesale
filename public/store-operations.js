const MAX_QUANTITY = 1_000_000;
const MAX_EACH = 1_000_000_000;
const identity = (productId, variant = "") =>
  JSON.stringify([productId, variant]);
const normalized = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
const clone = (value) => structuredClone(value);
const knownPack = (product) =>
  Number.isSafeInteger(product?.packSize) && product.packSize > 0;
const availableVariants = (product) =>
  product?.variants?.length
    ? [
        ...(product.standardVariantEnabled === true ? [""] : []),
        ...product.variants,
      ]
    : [""];
function whole(value, label, { min = 0, max = MAX_QUANTITY } = {}) {
  const text = String(value ?? "").trim();
  if (
    !/^-?\d+$/.test(text) ||
    !Number.isSafeInteger(Number(text)) ||
    Number(text) < min ||
    Number(text) > max
  )
    throw new Error(
      `${label} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    );
  return Number(text);
}
function measurement(value, now) {
  const timestamp =
    typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now)
    throw new Error(
      "Choose a valid measurement date that is not in the future.",
    );
  return timestamp;
}
function validateUnit(unit, product, quantity) {
  if (!["each", "case"].includes(unit)) throw new Error("Choose each or case.");
  if (unit === "case" && !knownPack(product))
    throw new Error(
      "Cases need a known pack size. Enter individual units instead.",
    );
  if (Math.abs(quantity) * (unit === "case" ? product.packSize : 1) > MAX_EACH)
    throw new Error("Converted quantity is too large.");
}
export function prepareStoreCount(value, product, record, now = Date.now()) {
  if (!value.storeId || !product?.id || value.productId !== product.id)
    throw new Error("Select a store and available product.");
  const variant = value.variant || "";
  if (!availableVariants(product).includes(variant))
    throw new Error(
      "This flavor is no longer available. Review the catalog before counting.",
    );
  const quantity = whole(value.quantity, "Quantity");
  validateUnit(value.unit, product, quantity);
  if (
    value.unit === "case" &&
    value.packSize != null &&
    value.packSize !== product.packSize
  )
    throw new Error(
      "The case pack size has changed. Enter the observed individual units or review the new case size before syncing.",
    );
  const note = String(value.note || "").trim();
  if (note.length > 1000)
    throw new Error("Keep the count note within 1,000 characters.");
  const result = {
    storeId: value.storeId,
    productId: product.id,
    variant,
    quantity,
    unit: value.unit,
    measuredAt: measurement(value.measuredAt, now),
    targetEach:
      value.targetEach === "" || value.targetEach == null
        ? null
        : whole(value.targetEach, "Target stock", { max: MAX_EACH }),
    expectedVersion: whole(record?.version ?? 0, "Record version", {
      max: Number.MAX_SAFE_INTEGER,
    }),
    note,
  };
  if (value.correctionOf) result.correctionOf = String(value.correctionOf);
  if (value.unit === "case") result.expectedPackSize = product.packSize;
  return result;
}
export function storeInventoryRows(
  products,
  records,
  { query = "", categoryId = "", lowOnly = false } = {},
) {
  const byIdentity = new Map(
    records.map((record) => [
      identity(record.productId, record.variant),
      record,
    ]),
  );
  const term = normalized(query);
  return products
    .filter(
      (product) => product && !product.deleted && product.active !== false,
    )
    .flatMap((product) =>
      availableVariants(product).map((variant) => ({
        product,
        variant,
        record: byIdentity.get(identity(product.id, variant)) || null,
      })),
    )
    .filter(
      ({ product, variant, record }) =>
        (!categoryId || product.categoryIds?.includes(categoryId)) &&
        (!lowOnly ||
          (record?.countEach != null &&
            record.targetEach != null &&
            record.countEach < record.targetEach)) &&
        (!term ||
          [
            product.name,
            product.sku,
            product.barcode,
            product.variantBarcodes?.[variant],
            variant,
          ].some((value) => normalized(value).includes(term))),
    );
}
/** Captured workspace and explicit actor/store prevent delayed saves from crossing contexts. */
export function createStoreCountDrafts(workspace, actorId, storeId) {
  if (!actorId || !storeId || !workspace?.setPreferences)
    throw new Error("Choose an account and store before saving a count.");
  const all = () =>
    Array.isArray(workspace.preferences().storeCountDrafts)
      ? workspace.preferences().storeCountDrafts
      : [];
  const mine = (entry) =>
    entry && entry.actorId === actorId && entry.storeId === storeId;
  return {
    list: () => clone(all().filter(mine)),
    put: (entry) => {
      if (typeof entry?.id !== "string" || !entry.id)
        throw new Error("A local count identifier is required.");
      const safe = { ...clone(entry), actorId, storeId };
      workspace.setPreferences({
        storeCountDrafts: [
          ...all().filter((item) => !(mine(item) && item.id === safe.id)),
          safe,
        ],
      });
      return safe;
    },
    remove: (id) =>
      workspace.setPreferences({
        storeCountDrafts: all().filter(
          (item) => !(mine(item) && item.id === id),
        ),
      }),
  };
}
export async function syncStoreCount({
  entry,
  drafts,
  product,
  command,
  now = Date.now(),
}) {
  const payload = prepareStoreCount(
    entry,
    product,
    { version: entry.expectedVersion ?? 0 },
    now,
  );
  const result = await command("storeInventory.count", payload, {
    storeCountDraftId: entry.id,
  });
  try {
    drafts.remove(entry.id);
  } catch {
    throw new Error(
      "Count confirmed online, but the local draft could not be cleared. Refresh inventory before retrying.",
    );
  }
  return result;
}
export function captureReplenishmentDraft(draft, actorId) {
  if (!draft?.id || !actorId)
    throw new Error("Start an order before checking missing items.");
  return {
    actorId,
    draftId: draft.id,
    storeId: draft.storeId,
    fingerprint: JSON.stringify([
      draft.localRevision ?? null,
      draft.version ?? null,
      draft.lines || [],
      draft.notes || "",
    ]),
  };
}
export function replenishmentDraftCurrent(snapshot, draft, actorId, storeId) {
  return (
    !!draft &&
    snapshot.actorId === actorId &&
    snapshot.storeId === storeId &&
    snapshot.draftId === draft.id &&
    snapshot.fingerprint ===
      captureReplenishmentDraft(draft, actorId).fingerprint
  );
}
export function prepareReplenishmentLine(candidate, product, value, unit) {
  if (
    !product ||
    product.id !== candidate.productId ||
    product.deleted ||
    product.active === false ||
    candidate.status === "unavailable"
  )
    throw new Error("This product is no longer available. Review the catalog.");
  if (!availableVariants(product).includes(candidate.variant || ""))
    throw new Error("This flavor is no longer available. Review the catalog.");
  const quantity = whole(value, "Quantity", { min: 1 });
  validateUnit(unit, product, quantity);
  return {
    productId: product.id,
    variant: candidate.variant || "",
    quantity,
    unit,
    note: "",
  };
}
const HISTORY_PAGE_SIZE = 500;
function mergeHistoryRows(previous = [], incoming = []) {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const row of incoming) if (!rows.has(row.id)) rows.set(row.id, row);
  return [...rows.values()];
}
function requireHistoryScope(isCurrent) {
  if (!isCurrent())
    throw new Error(
      "The selected account or store changed. Reopen this screen.",
    );
}
function historyPath(path, cursors = {}) {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  for (const [key, value] of Object.entries(cursors))
    if (value) query.set(key, value);
  return `${path}?${query}`;
}
function inventoryHistory(history) {
  return {
    ...history,
    complete:
      !history.nextRecordsCursor &&
      !history.nextCountsCursor &&
      !history.nextMovementsCursor,
    recordsComplete: !history.nextRecordsCursor,
    recordsTruncated: !!history.nextRecordsCursor,
  };
}
export async function loadStoreInventoryRecords({
  api,
  path,
  isCurrent,
  maxPages = 20,
}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)
    throw new Error("Invalid inventory page bound.");
  requireHistoryScope(isCurrent);
  const first = await api(historyPath(path));
  requireHistoryScope(isCurrent);
  let records = mergeHistoryRows([], first.records || []),
    cursor = first.history?.nextRecordsCursor;
  const seen = new Set();
  for (let page = 1; cursor && page < maxPages && !seen.has(cursor); page++) {
    seen.add(cursor);
    requireHistoryScope(isCurrent);
    const next = await api(historyPath(path, { recordsCursor: cursor }));
    requireHistoryScope(isCurrent);
    records = mergeHistoryRows(records, next.records || []);
    cursor = next.history?.nextRecordsCursor;
  }
  return {
    ...first,
    records,
    counts: first.counts || [],
    movements: first.movements || [],
    history: inventoryHistory({
      ...first.history,
      nextRecordsCursor: cursor || null,
    }),
  };
}
export async function loadOlderStoreInventoryHistory({
  api,
  path,
  data,
  isCurrent,
}) {
  requireHistoryScope(isCurrent);
  const countsCursor = data.history?.nextCountsCursor,
    movementsCursor = data.history?.nextMovementsCursor;
  if (!countsCursor && !movementsCursor) return data;
  const next = await api(historyPath(path, { countsCursor, movementsCursor }));
  requireHistoryScope(isCurrent);
  if (
    (countsCursor && next.history?.nextCountsCursor === countsCursor) ||
    (movementsCursor && next.history?.nextMovementsCursor === movementsCursor)
  )
    throw new Error(
      "History did not advance. Refresh inventory and try again.",
    );
  return {
    ...data,
    counts: countsCursor
      ? mergeHistoryRows(data.counts, next.counts || [])
      : data.counts,
    movements: movementsCursor
      ? mergeHistoryRows(data.movements, next.movements || [])
      : data.movements,
    history: inventoryHistory({
      ...data.history,
      nextCountsCursor: countsCursor
        ? next.history?.nextCountsCursor || null
        : null,
      nextMovementsCursor: movementsCursor
        ? next.history?.nextMovementsCursor || null
        : null,
    }),
  };
}
export async function loadPlacedOrdersPage({ api, path, data, isCurrent }) {
  requireHistoryScope(isCurrent);
  const cursor = data?.history?.nextCursor;
  if (data && !cursor) return data;
  const next = await api(historyPath(path, { cursor }));
  requireHistoryScope(isCurrent);
  if (cursor && next.history?.nextCursor === cursor)
    throw new Error(
      "Placement history did not advance. Reopen this screen and try again.",
    );
  return {
    ...next,
    placements: mergeHistoryRows(data?.placements, next.placements || []),
  };
}
function localDateInput(value = Date.now()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
const dateLabel = (value) =>
  value
    ? new Date(value).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not recorded";
const units = (value) =>
  Number.isFinite(value)
    ? `${Number(value.toFixed(1)).toLocaleString()} each`
    : "Unknown";
const statusLabels = {
  missing: "Missing from this order",
  "ordered-recently": "Ordered recently",
  "check-flavors": "Check flavors",
  unavailable: "Unavailable",
  "quantity-review": "Review quantity",
};

export function createStoreOperations(context) {
  const {
    el,
    input,
    button,
    field,
    modal,
    notice,
    table,
    td,
    toast,
    command,
    api,
    getStore,
    getProducts,
    getDraft,
    getWorkspace,
    getActorId,
    addLines,
    editDraft,
    scope,
    isCurrent,
  } = context;
  const online = () => globalThis.navigator?.onLine !== false;
  const select = (choices, value, attrs = {}) => {
    const node = el(
      "select",
      attrs,
      choices.map(([id, label]) => el("option", { value: id }, label)),
    );
    node.value = value;
    return node;
  };
  const capture = () => ({
    session: scope(),
    actorId: getActorId(),
    storeId: getStore()?.id,
    workspace: getWorkspace(),
  });
  const current = (saved) => {
    try {
      return (
        isCurrent(saved.session) &&
        saved.actorId === getActorId() &&
        saved.storeId === getStore()?.id &&
        saved.workspace === getWorkspace()
      );
    } catch {
      return false;
    }
  };
  const scopedModal = (saved, ...args) => {
    const view = modal(...args);
    const watch = setInterval(() => {
      if (!current(saved)) view.close();
    }, 400);
    view.dialog.addEventListener("close", () => clearInterval(watch), {
      once: true,
    });
    return view;
  };
  const requireCurrent = (saved) => {
    if (!current(saved))
      throw new Error(
        "The selected account or store changed. Reopen this screen.",
      );
  };
  const endpoint = (saved, name) =>
    `/api/stores/${encodeURIComponent(saved.storeId)}/${name}`;
  const draftsFor = (saved) =>
    createStoreCountDrafts(saved.workspace, saved.actorId, saved.storeId);
  const unitChoices = (product) => [
    ["each", "Each"],
    ...(knownPack(product)
      ? [["case", `Case (${product.packSize} each)`]]
      : []),
  ];
  const pendingCount = (saved, id) =>
    saved.workspace
      .pending?.()
      .find(
        (entry) =>
          entry.storeCountDraftId === id ||
          entry.metadata?.storeCountDraftId === id,
      );
  const feedbackFor = (draft, referenceId) =>
    (draft?.replenishmentFeedback || []).filter(
      (entry) => entry.referenceId === referenceId,
    );
  function metricContent(metric) {
    const parts = [];
    for (const [type, label] of [
      ["purchases", "Weekly purchases"],
      ["depletion", "Estimated weekly depletion"],
    ]) {
      const value = metric?.[type];
      if (!value?.eligible) continue;
      parts.push(
        el("p", { class: "small" }, `${label}: ${units(value.weeklyEach)}`),
      );
      parts.push(
        el(
          "p",
          { class: "small muted" },
          type === "purchases"
            ? `${value.cycles} order cycles · ${Math.round(value.observedDays)} days · last order ${dateLabel(value.lastOrderAt)}`
            : `${value.validIntervals} count intervals · ${Math.round(value.observedDays)} observed days`,
        ),
      );
      if (value.from && value.to)
        parts.push(
          el(
            "p",
            { class: "small muted" },
            `${dateLabel(value.from)} – ${dateLabel(value.to)}`,
          ),
        );
    }
    if (!parts.length)
      parts.push(
        el(
          "p",
          { class: "small muted" },
          "Not enough history for a weekly estimate.",
        ),
      );
    return el("div", { class: "store-metric" }, parts);
  }

  function renderInventory() {
    const saved = capture(),
      store = getStore();
    if (!store?.id) return notice("Select a store to see its inventory.");
    let data = { records: [], counts: [], movements: [] },
      metrics = [],
      metricState = "pending",
      loaded = false,
      requestId = 0;
    let query = "",
      categoryId = "",
      lowOnly = false;
    const status = el("p", {
      class: "small",
      role: "status",
      "aria-live": "polite",
    });
    const messages = el("div", { class: "store-operation-messages" });
    const results = el("div", { class: "store-inventory-results" });
    const search = input("search", "", {
      placeholder: "Product, flavor, SKU or barcode",
      "aria-label": "Search store inventory",
      onInput: (event) => {
        query = event.target.value;
        draw();
      },
    });
    const categories = context.getCategories?.() || [];
    const categoryIds = [
      ...new Set(getProducts().flatMap((product) => product.categoryIds || [])),
    ];
    const category = select(
      [
        ["", "All categories"],
        ...categoryIds.map((id) => [
          id,
          categories.find((item) => item.id === id)?.name || id,
        ]),
      ],
      "",
      {
        "aria-label": "Filter inventory category",
        onChange: (event) => {
          categoryId = event.target.value;
          draw();
        },
      },
    );
    const low = input("checkbox", "", {
      onChange: (event) => {
        lowOnly = event.target.checked;
        draw();
      },
    });
    const root = el(
      "div",
      { class: "store-operations" },
      el(
        "header",
        { class: "page-heading" },
        el(
          "div",
          {},
          el("h1", { id: "page-title", tabindex: -1 }, "Store inventory"),
          el("p", {}, `${store.name} · Physical counts and received stock.`),
        ),
        el(
          "div",
          { class: "actions" },
          button("Placed orders & receipts", showPlacementHistory),
          button("Refresh inventory", load),
        ),
      ),
      notice(
        "Last counted stock stays separate from estimates. Only counts confirmed online contribute to shared insights.",
      ),
      el(
        "div",
        { class: "store-inventory-filters" },
        field("Search or enter barcode", search),
        field("Category", category),
        el("label", { class: "store-low-filter" }, low, "Below target"),
      ),
      messages,
      status,
      results,
    );
    function draw() {
      if (!current(saved)) return;
      const local = draftsFor(saved).list();
      messages.replaceChildren();
      if (local.length)
        messages.append(
          notice(
            `${local.length} count ${local.length === 1 ? "draft is" : "drafts are"} saved on this device for ${store.name}. Review and sync each count when online.`,
          ),
        );
      if (data.history?.recordsTruncated)
        messages.append(
          notice(
            `Inventory loading stopped after ${data.records.length.toLocaleString()} records (10,000 maximum). Missing records are marked Not loaded; their saved counts are unknown in this view.`,
          ),
        );
      if (data.history?.nextCountsCursor || data.history?.nextMovementsCursor)
        messages.append(
          notice(
            "Older observations are available. Open an item's History and choose Load older history.",
          ),
        );
      const draftPanel = el("div", { class: "store-count-drafts" });
      for (const entry of local) {
        const product = getProducts().find(
          (item) => item.id === entry.productId,
        );
        draftPanel.append(
          el(
            "div",
            { class: "store-count-draft" },
            el(
              "div",
              {},
              el("strong", {}, product?.name || "Unavailable product"),
              el(
                "p",
                { class: "small" },
                `${entry.variant || "Standard"} · ${entry.quantity || "Not entered"} ${entry.unit || "each"} · ${dateLabel(entry.measuredAt)}`,
              ),
            ),
            button("Review local count", () => {
              if (!product)
                throw new Error(
                  "The product is unavailable. Your local count is retained.",
                );
              showCount(
                product,
                entry.variant || "",
                data.records.find(
                  (record) =>
                    identity(record.productId, record.variant) ===
                    identity(entry.productId, entry.variant),
                ),
                entry,
                load,
              );
            }),
          ),
        );
      }
      const rows = storeInventoryRows(getProducts(), data.records, {
        query,
        categoryId,
        lowOnly,
      });
      status.textContent = loaded
        ? `${rows.length} matching product flavors${rows.length > 100 ? " · Showing the first 100; narrow your search." : ""}`
        : "Counts have not been loaded online. You can still save a local count.";
      const result = table(
        [
          "Product / flavor",
          "Last physical count",
          "Target stock",
          "Weekly pattern",
          "Actions",
        ],
        rows.slice(0, 100).map(({ product, variant, record }) => {
          const recordKnown = loaded && data.history?.recordsComplete !== false;
          const count =
            record?.countEach == null
              ? recordKnown
                ? "Not counted"
                : "Not loaded"
              : units(record.countEach);
          const metric = metrics.find(
            (item) =>
              identity(item.productId, item.variant) ===
              identity(product.id, variant),
          );
          return el(
            "tr",
            {},
            td(
              el("strong", {}, product.name),
              el("p", { class: "small" }, variant || "Standard"),
              el(
                "p",
                { class: "small muted" },
                product.variantBarcodes?.[variant] ||
                  product.barcode ||
                  product.sku ||
                  "",
              ),
            ),
            td(
              el("strong", {}, count),
              el(
                "p",
                { class: "small" },
                record?.measuredAt
                  ? dateLabel(record.measuredAt)
                  : recordKnown
                    ? "No observation saved"
                    : "Shared count is not known in this view",
              ),
              record?.measuredAt &&
                Date.now() - record.measuredAt > 7 * 86400000
                ? el("span", { class: "store-pill" }, "Older than 7 days")
                : null,
            ),
            td(
              record?.targetEach == null ? "Not set" : units(record.targetEach),
            ),
            td(
              metricState === "ready"
                ? metricContent(metric)
                : el(
                    "p",
                    { class: "small muted" },
                    metricState === "failed"
                      ? "Weekly patterns are temporarily unavailable."
                      : "Loading weekly patterns…",
                  ),
            ),
            td(
              el(
                "div",
                { class: "store-row-actions" },
                button("Count", () =>
                  showCount(product, variant, record, null, load),
                ),
                button("History", () =>
                  showHistory(product, variant, data, load),
                ),
                button("Movement", () => showMovement(product, variant, load)),
              ),
            ),
          );
        }),
      );
      result.classList.add("store-inventory-table");
      results.replaceChildren(draftPanel, result);
      if (!rows.length)
        results.append(
          notice(
            lowOnly
              ? "No counted items are below their saved target. Products without counts remain unknown."
              : "No products match these filters.",
          ),
        );
    }
    async function load() {
      requireCurrent(saved);
      const request = ++requestId;
      metricState = "pending";
      status.textContent = "Loading store counts…";
      try {
        const next = await loadStoreInventoryRecords({
          api,
          path: endpoint(saved, "inventory"),
          isCurrent: () => current(saved) && request === requestId,
        });
        if (!current(saved) || request !== requestId) return;
        data = next;
        loaded = true;
        draw();
        try {
          const insights = await api(endpoint(saved, "replenishment"), {
            method: "POST",
            body: { draft: { lines: [] }, explain: false },
          });
          if (!current(saved) || request !== requestId) return;
          metrics = insights.analysis?.metrics || [];
          metricState = "ready";
          draw();
        } catch {
          if (!current(saved) || request !== requestId) return;
          metricState = "failed";
          draw();
        }
      } catch (error) {
        if (!current(saved) || request !== requestId) return;
        metricState = "failed";
        draw();
        messages.append(
          notice(
            `${error.message || "Inventory could not be loaded."} Local counts remain on this device.`,
            true,
          ),
        );
      }
    }
    draw();
    void load();
    return root;
  }

  function showCount(
    product,
    variant,
    record,
    existing,
    afterSave,
    correction,
  ) {
    const saved = capture();
    requireCurrent(saved);
    const drafts = draftsFor(saved);
    const old =
      existing ||
      (!correction &&
        drafts
          .list()
          .find(
            (entry) =>
              entry.productId === product.id &&
              entry.variant === variant &&
              !entry.correctionOf,
          ));
    let entry = old || {
      id: crypto.randomUUID(),
      storeId: saved.storeId,
      productId: product.id,
      variant,
      quantity: "",
      unit: "each",
      measuredAt: correction?.measuredAt || Date.now(),
      expectedVersion: record?.version || 0,
      targetEach: record?.targetEach ?? "",
      note: "",
      ...(correction ? { correctionOf: correction.id } : {}),
    };
    const m = scopedModal(
      saved,
      correction || entry.correctionOf
        ? "Correct a saved count"
        : "Count store stock",
      `${getStore().name} · ${product.name} / ${variant || "Standard"}`,
    );
    const quantity = input("number", entry.quantity, {
      min: 0,
      max: MAX_QUANTITY,
      step: 1,
      inputmode: "numeric",
    });
    const unit = select(unitChoices(product), entry.unit);
    if (
      entry.unit === "case" &&
      entry.packSize != null &&
      entry.packSize !== product.packSize
    )
      m.content.append(
        notice(
          `This observation used ${entry.packSize} each per case. The catalog now uses ${product.packSize} each per case. Enter the observed individual units, or switch units after reviewing the new case size.`,
        ),
      );
    const measured = input("datetime-local", localDateInput(entry.measuredAt), {
      max: localDateInput(),
      disabled: !!entry.correctionOf,
    });
    const target = input("number", entry.targetEach ?? "", {
      min: 0,
      max: MAX_EACH,
      step: 1,
      placeholder: "Not set",
    });
    const note = el("textarea", {
      maxlength: 1000,
      value: entry.note || "",
      rows: 3,
    });
    const status = el(
      "p",
      {
        class: "store-count-save-status small",
        role: "status",
        "aria-live": "polite",
      },
      old
        ? "Saved on this device. Not yet confirmed online."
        : "Enter the quantity physically observed. Zero means none on the shelf.",
    );
    const conversion = el("p", { class: "small" });
    const conflict = (entry.expectedVersion || 0) !== (record?.version || 0);
    let reviewed = !conflict;
    const update = () => {
      requireCurrent(saved);
      const timestamp =
        entry.correctionOf ||
        measured.value === localDateInput(entry.measuredAt)
          ? entry.measuredAt
          : new Date(measured.value).getTime();
      const next = {
        ...entry,
        quantity: quantity.value,
        unit: unit.value,
        measuredAt: timestamp,
        targetEach: target.value,
        note: note.value,
        packSize:
          unit.value === "case"
            ? entry.unit === "case"
              ? (entry.packSize ?? product.packSize)
              : product.packSize
            : null,
      };
      entry = drafts.put(next);
      status.textContent =
        "Saved on this device. Sync online to include it in shared insights.";
      conversion.textContent = /^\d+$/.test(quantity.value)
        ? `${units(Number(quantity.value) * (unit.value === "case" ? entry.packSize : 1))} physically observed${unit.value === "case" ? ` · ${entry.packSize} each per case` : ""}`
        : "";
      return entry;
    };
    for (const control of [quantity, unit, measured, target, note])
      control.addEventListener("input", () => {
        try {
          update();
        } catch (error) {
          status.textContent = `Not saved: ${error.message}`;
          status.setAttribute("role", "alert");
        }
      });
    m.content.append(
      notice(
        "A count is an observation, not a receipt. Opening or placing an order never increases this count.",
      ),
      el(
        "div",
        { class: "store-count-fields" },
        field("Observed quantity", quantity),
        field("Unit", unit),
        field("Measured at", measured),
        field("Target stock (each)", target),
      ),
      conversion,
      field("Count note (optional)", note),
      status,
    );
    if (record?.countEach != null)
      m.content.append(
        el(
          "p",
          { class: "small" },
          `Latest shared count: ${units(record.countEach)} · ${dateLabel(record.measuredAt)}`,
        ),
      );
    if (conflict)
      m.content.append(
        notice(
          "A newer count was saved while this observation was on your device. Review both observations before syncing.",
        ),
        button("I reviewed the newer count", () => {
          requireCurrent(saved);
          reviewed = true;
          entry.expectedVersion = record?.version || 0;
          update();
          toast("Your observation can now be synced after review.");
        }),
      );
    m.footer.append(
      button("Keep on device", () => {
        update();
        m.close();
        if (current(saved)) afterSave?.();
      }),
      button(
        "Save count online",
        async () => {
          requireCurrent(saved);
          if (!reviewed)
            throw new Error(
              "Review the newer shared count before syncing this observation.",
            );
          const value = update();
          if (!online())
            throw new Error(
              "This count is saved on your device. Reconnect to save it online.",
            );
          if (pendingCount(saved, entry.id))
            throw new Error(
              "This count already has a pending action. Open Sync center to resolve it before retrying here.",
            );
          await syncStoreCount({ entry: value, drafts, product, command });
          if (!current(saved)) return;
          m.close();
          toast("Count confirmed online.");
          await context.refresh?.();
          if (current(saved)) await afterSave?.();
        },
        "primary",
      ),
    );
    quantity.focus();
  }

  function showHistory(product, variant, data, afterSave) {
    const saved = capture();
    const m = scopedModal(
      saved,
      "Count & movement history",
      `${getStore().name} · ${product.name} / ${variant || "Standard"}`,
      true,
    );
    const matches = (item) =>
      item.productId === product.id && (item.variant || "") === variant;
    const record = data.records.find(matches);
    let historyData = data,
      loading = false;
    const isOpen = () => m.dialog.open && current(saved);
    function draw() {
      if (!isOpen()) return;
      const counts = (historyData.counts || [])
        .filter(matches)
        .sort((a, b) => b.measuredAt - a.measuredAt);
      const movements = (historyData.movements || [])
        .filter(matches)
        .sort((a, b) => b.effectiveAt - a.effectiveAt);
      const older =
        historyData.history?.nextCountsCursor ||
        historyData.history?.nextMovementsCursor;
      m.content.replaceChildren(el("h3", {}, "Physical observations"));
      m.content.append(
        counts.length
          ? table(
              ["Measured", "Count", "Recorded online", "Note", ""],
              counts.map((count) =>
                el(
                  "tr",
                  {},
                  td(dateLabel(count.measuredAt)),
                  td(
                    units(count.countEach),
                    count.correctionOf
                      ? el(
                          "p",
                          { class: "small" },
                          "Correction of an earlier count",
                        )
                      : null,
                  ),
                  td(dateLabel(count.recordedAt)),
                  td(count.note || "—"),
                  td(
                    button("Correct", () => {
                      requireCurrent(saved);
                      m.close();
                      showCount(
                        product,
                        variant,
                        record,
                        null,
                        afterSave,
                        count,
                      );
                    }),
                  ),
                ),
              ),
            )
          : notice(
              older
                ? "No saved counts for this flavor in the loaded history."
                : "No saved counts for this flavor.",
            ),
      );
      m.content.append(
        el("h3", { class: "store-history-heading" }, "Physical movements"),
      );
      m.content.append(
        movements.length
          ? table(
              ["Effective date", "Movement", "Quantity", "Reason"],
              movements.map((movement) =>
                el(
                  "tr",
                  {},
                  td(dateLabel(movement.effectiveAt)),
                  td(movement.kind),
                  td(
                    units(
                      movement.quantityEach ??
                        movement.deltaEach ??
                        movement.each,
                    ),
                  ),
                  td(movement.reason || movement.note || "—"),
                ),
              ),
            )
          : notice(
              older
                ? "No movements for this flavor in the loaded history."
                : "No recorded receipts, returns or stock movements.",
            ),
      );
      if (older) {
        m.content.append(
          notice(
            "Older observations may contain more history for this flavor.",
          ),
        );
        const more = button(
          loading ? "Loading older history…" : "Load older history",
          loadOlder,
        );
        more.disabled = loading;
        m.content.append(more);
      }
    }
    async function loadOlder() {
      requireCurrent(saved);
      if (loading || !m.dialog.open) return;
      loading = true;
      draw();
      try {
        const next = await loadOlderStoreInventoryHistory({
          api,
          path: endpoint(saved, "inventory"),
          data: historyData,
          isCurrent: isOpen,
        });
        if (!isOpen()) return;
        historyData = next;
      } catch (error) {
        if (isOpen()) {
          loading = false;
          draw();
          m.content.append(
            notice(error.message || "Older history could not be loaded.", true),
          );
          return;
        }
      } finally {
        loading = false;
      }
      draw();
    }
    draw();
  }

  function showMovement(product, variant, afterSave) {
    const saved = capture();
    const m = scopedModal(
      saved,
      "Record a physical movement",
      `${getStore().name} · ${product.name} / ${variant || "Standard"}`,
    );
    const kind = select(
      [
        ["receipt", "Receipt from another source"],
        ["damage", "Damage / loss"],
        ["return-out", "Returned to supplier"],
        ["transfer-in", "Transfer in"],
        ["transfer-out", "Transfer out"],
        ["correction", "Documented non-sale correction"],
        ["unclassified", "Unclassified adjustment"],
      ],
      "receipt",
    );
    const quantity = input("number", "", {
      step: 1,
      max: MAX_QUANTITY,
      min: -MAX_QUANTITY,
    });
    const unit = select(unitChoices(product), "each");
    const at = input("datetime-local", localDateInput(), {
      max: localDateInput(),
    });
    const reason = el("textarea", { maxlength: 1000, rows: 3 });
    m.content.append(
      notice(
        "For an order placed in this app, use Placed orders & receipts to confirm delivery once. Use this form for other physical stock changes.",
      ),
      field("Movement", kind),
      el(
        "div",
        { class: "store-count-fields" },
        field(
          "Quantity",
          quantity,
          "Use positive quantities for receipts, damage, returns and transfers. Corrections can be signed.",
        ),
        field("Unit", unit),
        field("Effective at", at),
      ),
      field(
        "Reason",
        reason,
        "Explain the stock change. Unclassified changes prevent a depletion estimate.",
      ),
    );
    m.footer.append(
      button(
        "Save movement online",
        async () => {
          requireCurrent(saved);
          if (!online())
            throw new Error("Reconnect before recording a physical movement.");
          const amount = whole(quantity.value, "Quantity", {
            min: ["correction", "unclassified"].includes(kind.value)
              ? -MAX_QUANTITY
              : 1,
          });
          if (!amount) throw new Error("Quantity cannot be zero.");
          validateUnit(unit.value, product, amount);
          if (!reason.value.trim())
            throw new Error("Enter the reason for this movement.");
          await command("storeInventory.movement", {
            storeId: saved.storeId,
            productId: product.id,
            variant,
            kind: kind.value,
            quantity: amount,
            unit: unit.value,
            effectiveAt: measurement(at.value, Date.now()),
            reason: reason.value.trim(),
          });
          if (!current(saved)) return;
          m.close();
          toast("Physical movement recorded.");
          await afterSave?.();
        },
        "primary",
      ),
    );
  }

  async function showMissingItems() {
    const saved = capture();
    if (!saved.storeId) throw new Error("Select a store first.");
    const source = clone(getDraft());
    const snapshot = captureReplenishmentDraft(source, saved.actorId);
    if (source.storeId !== saved.storeId)
      throw new Error("Open an order for the selected store.");
    const m = scopedModal(
      saved,
      "Check missing items",
      `${getStore().name} · Review before placing this order`,
      true,
    );
    m.content.append(
      notice(
        "Comparing against the latest eligible order older than four days…",
      ),
    );
    const check = () => {
      requireCurrent(saved);
      if (
        !replenishmentDraftCurrent(
          snapshot,
          getDraft(),
          getActorId(),
          getStore()?.id,
        )
      )
        throw new Error(
          "This order changed. Close this comparison and check missing items again.",
        );
    };
    try {
      const result = await api(endpoint(saved, "replenishment"), {
        method: "POST",
        body: { draft: { lines: source.lines || [] } },
      });
      if (!m.dialog.open || !current(saved)) return;
      check();
      const analysis = result.analysis;
      if (!analysis || analysis.storeId !== saved.storeId)
        throw new Error(
          "The comparison could not be verified for this store. Try again.",
        );
      m.content.replaceChildren();
      const reference = analysis.reference;
      m.content.append(
        el(
          "div",
          { class: "store-reference" },
          el(
            "strong",
            {},
            reference
              ? `Reference order${reference.orderNumber ? ` ${reference.orderNumber}` : ""}`
              : "No prior order older than four days.",
          ),
          reference
            ? el(
                "p",
                {},
                `${dateLabel(reference.placedAt)} · ${reference.provenance === "historical-unverified" ? "Historical / unverified" : "Confirmed placement"}`,
              )
            : null,
        ),
      );
      if (analysis.history?.complete === false)
        m.content.append(
          notice(
            "Purchase history is incomplete. This comparison may omit purchases; review the selected reference carefully.",
          ),
        );
      m.content.append(
        notice(
          result.ai?.available
            ? "AI explanations accompany the verified comparison. Quantities come from recorded evidence."
            : "AI explanation unavailable. The verified rules-based comparison is still available.",
        ),
      );
      const feedback = feedbackFor(source, reference?.id || "");
      const candidates = (analysis.candidates || []).filter(
        (candidate) =>
          !feedback.some((entry) => entry.candidateId === candidate.id),
      );
      const list = el("div", { class: "store-missing-list" });
      for (const candidate of candidates) {
        const product = getProducts().find(
          (item) => item.id === candidate.productId,
        );
        const unavailable =
          candidate.status === "unavailable" ||
          !product ||
          product.active === false ||
          !availableVariants(product).includes(candidate.variant || "");
        const metric = (analysis.metrics || []).find(
          (item) =>
            identity(item.productId, item.variant) ===
            identity(candidate.productId, candidate.variant),
        );
        const suggestion = candidate.suggestion;
        const exactLines = (source.lines || []).filter(
          (line) =>
            line.productId === candidate.productId &&
            (line.variant || "") === (candidate.variant || "") &&
            line.selectionMode !== "mix",
        );
        const quantity = input(
          "number",
          exactLines.length ? "" : (suggestion?.quantity ?? ""),
          {
            min: 1,
            max: MAX_QUANTITY,
            step: 1,
            placeholder: "Enter quantity",
            "aria-label": `Quantity to add for ${candidate.name} ${candidate.variant || "Standard"}`,
          },
        );
        const unit = select(unitChoices(product), suggestion?.unit || "each", {
          "aria-label": `Order unit for ${candidate.name}`,
        });
        const latest = candidate.latestCount;
        const card = el(
          "article",
          { class: "store-missing-card" },
          el(
            "div",
            { class: "store-missing-heading" },
            el(
              "div",
              {},
              el(
                "h3",
                {},
                candidate.name || product?.name || candidate.productId,
              ),
              el("p", { class: "small" }, candidate.variant || "Standard"),
            ),
            el(
              "span",
              { class: "store-pill" },
              statusLabels[candidate.status] || "Review",
            ),
          ),
          el(
            "dl",
            { class: "store-evidence" },
            el(
              "div",
              {},
              el("dt", {}, "Reference quantity"),
              el("dd", {}, units(candidate.priorEach)),
            ),
            el(
              "div",
              {},
              el("dt", {}, "In this draft"),
              el("dd", {}, units(candidate.currentEach)),
            ),
            el(
              "div",
              {},
              el("dt", {}, "Last physical count"),
              el(
                "dd",
                {},
                latest
                  ? `${units(latest.countEach)} · ${dateLabel(latest.measuredAt)}${latest.stale ? " · Stale count" : ""}`
                  : "Not counted",
              ),
            ),
            el(
              "div",
              {},
              el("dt", {}, "Later confirmed receipts"),
              el("dd", {}, units(candidate.laterReceiptsEach)),
            ),
          ),
          candidate.recentOrderAt
            ? notice(
                `Ordered recently on ${dateLabel(candidate.recentOrderAt)}. Check that purchase before adding more.`,
              )
            : null,
          metricContent(metric),
        );
        if (candidate.status === "check-flavors")
          card.append(
            notice(
              "A different flavor or Mix is already present. Allowed in mix; not guaranteed. Only an exact split confirms a flavor quantity.",
            ),
          );
        if (suggestion)
          card.append(
            el(
              "p",
              { class: "store-suggestion small" },
              `${suggestion.planningDays || 7}-day plan: target ${units(suggestion.targetEach)} − estimated available ${units(suggestion.availableEach)}${suggestion.pendingEach ? ` (including ${units(suggestion.pendingEach)} pending receipts)` : ""}. Suggested total order quantity: ${suggestion.quantity} ${suggestion.unit}.`,
            ),
          );
        else
          card.append(
            el(
              "p",
              { class: "small" },
              "No supported quantity suggestion. Enter the quantity you want to add.",
            ),
          );
        for (const warning of candidate.warnings || [])
          card.append(
            el(
              "p",
              { class: "small store-evidence-warning" },
              typeof warning === "string"
                ? warning
                : warning.message || "Review the available evidence.",
            ),
          );
        const explanation =
          result.ai?.available &&
          result.ai.explanations?.find(
            (item) => item.candidateId === candidate.id,
          );
        if (explanation)
          card.append(
            el("p", { class: "store-ai-explanation" }, explanation.text),
          );
        const saveFeedback = (decision) => {
          check();
          editDraft((next) => {
            next.replenishmentFeedback = [
              ...(next.replenishmentFeedback || []).filter(
                (item) =>
                  !(
                    item.candidateId === candidate.id &&
                    item.referenceId === (reference?.id || "")
                  ),
              ),
              {
                candidateId: candidate.id,
                referenceId: reference?.id || "",
                decision,
                at: Date.now(),
              },
            ];
          });
          m.close();
          toast(
            decision === "enough"
              ? "Marked as already enough for this order."
              : "Skipped for this order.",
          );
        };
        const actions = el("div", { class: "store-missing-actions" });
        if (!unavailable)
          actions.append(
            field(
              exactLines.length ? "Extra quantity to add" : "Quantity to add",
              quantity,
            ),
            field("Unit", unit),
            button(
              "Add to order",
              () => {
                check();
                const line = prepareReplenishmentLine(
                  candidate,
                  product,
                  quantity.value,
                  unit.value,
                );
                addLines([line]);
                m.close();
                toast("Item added. Check again to compare the updated order.");
              },
              "primary",
            ),
          );
        else
          actions.append(
            notice(
              "Unavailable product or flavor. Review the catalog before choosing a replacement.",
            ),
            button("Review availability", () => {
              check();
              const review = scopedModal(
                saved,
                "Review availability",
                candidate.name || candidate.productId,
              );
              review.content.append(
                notice(
                  !product || product.active === false || product.deleted
                    ? "This product is unavailable in the current catalog."
                    : "The previous flavor is unavailable. Choose any replacement explicitly in the catalog.",
                ),
                product && product.active !== false && !product.deleted
                  ? el(
                      "p",
                      {},
                      `Current flavors: ${availableVariants(product)
                        .map((variant) => variant || "Standard")
                        .join(", ")}`,
                    )
                  : null,
              );
            }),
          );
        if (!unavailable && exactLines.length)
          actions.append(
            button("Adjust current quantity", () => {
              check();
              const adjust = scopedModal(
                saved,
                "Adjust current quantities",
                `${candidate.name} / ${candidate.variant || "Standard"}`,
              );
              if (suggestion)
                adjust.content.append(
                  notice(
                    `Suggested total for this flavor: ${suggestion.quantity} ${suggestion.unit}. Review the quantities across all existing rows.`,
                  ),
                );
              const entries = exactLines.map((line) => {
                const suggestedInUnit = suggestion
                  ? (suggestion.quantity *
                      (suggestion.unit === "case" ? product.packSize : 1)) /
                    (line.unit === "case" ? product.packSize : 1)
                  : null;
                const initial =
                  exactLines.length === 1 &&
                  Number.isSafeInteger(suggestedInUnit) &&
                  suggestedInUnit > 0
                    ? suggestedInUnit
                    : line.quantity;
                const control = input("number", initial, {
                  min: 1,
                  max: MAX_QUANTITY,
                  step: 1,
                });
                adjust.content.append(
                  field(
                    `${line.unit === "case" ? "Cases" : "Each"}${line.note ? ` · ${line.note}` : ""}`,
                    control,
                  ),
                );
                return { line, control };
              });
              adjust.footer.append(
                button(
                  "Save quantities",
                  () => {
                    check();
                    const changes = entries.map(({ line, control }) => ({
                      id: line.id,
                      quantity: prepareReplenishmentLine(
                        candidate,
                        product,
                        control.value,
                        line.unit,
                      ).quantity,
                    }));
                    editDraft((next) => {
                      next.lines = next.lines.map((line) => {
                        const change = changes.find(
                          (item) => item.id === line.id,
                        );
                        return change
                          ? { ...line, quantity: change.quantity }
                          : line;
                      });
                    });
                    adjust.close();
                    m.close();
                    toast(
                      "Quantities updated. Check missing items again for this revision.",
                    );
                  },
                  "primary",
                ),
              );
            }),
          );
        actions.append(
          button("Skip this order", () => saveFeedback("skip")),
          button("Already have enough", () => saveFeedback("enough")),
        );
        card.append(actions);
        list.append(card);
      }
      m.content.append(list);
      if (!candidates.length && reference)
        m.content.append(
          notice(
            feedback.length
              ? "All remaining suggestions have been reviewed for this order."
              : "No missing-item candidates were found for this reference.",
          ),
        );
      if (feedback.length)
        m.footer.append(
          button("Reset skipped items", () => {
            check();
            editDraft((next) => {
              next.replenishmentFeedback = (
                next.replenishmentFeedback || []
              ).filter((item) => item.referenceId !== (reference?.id || ""));
            });
            m.close();
            toast(
              "Review decisions reset. Check missing items again to see them.",
            );
          }),
        );
      m.footer.append(button("Done reviewing", m.close));
    } catch (error) {
      if (m.dialog.open && current(saved))
        m.content.replaceChildren(
          notice(
            error.message || "The comparison is unavailable. Try again.",
            true,
          ),
        );
    }
  }

  function renderPlacementHistory(isOpen = () => true) {
    const saved = capture();
    const root = el("div", { class: "store-placement-history" });
    if (!saved.storeId) {
      root.append(notice("Select a store to view placed orders."));
      return root;
    }
    let data = null,
      loading = false;
    const active = () => current(saved) && isOpen();
    function draw() {
      if (!active()) return;
      const result = data;
      const placements = result.placements || [];
      root.replaceChildren();
      if (result.history?.complete === false)
        root.append(notice("Older placed orders are available below."));
      if (!placements.length) {
        root.append(
          notice(
            "No confirmed placed orders for this store. Opening Mail alone does not record a purchase.",
          ),
        );
        return;
      }
      for (const placement of [...placements].sort(
        (a, b) => b.placedAt - a.placedAt,
      )) {
        const card = el(
          "article",
          { class: "store-placement-card" },
          el(
            "h3",
            {},
            placement.orderNumber
              ? `Order ${placement.orderNumber}`
              : "Placed order",
          ),
          el(
            "p",
            {},
            `${dateLabel(placement.placedAt)} · ${placement.provenance === "mail-confirmed" ? "Mail placement confirmed by user" : placement.provenance === "submitted" ? "Submitted through app" : "Historical / unverified"}`,
          ),
          placement.parentPlacementId
            ? el("p", { class: "small" }, "Addition linked to an earlier order")
            : null,
          el(
            "ul",
            { class: "store-placement-lines" },
            (placement.lines || []).map((line) =>
              el(
                "li",
                {},
                `${line.name || line.productName || getProducts().find((product) => product.id === line.productId)?.name || line.productId}${line.selectionMode === "mix" ? ` / Mix · ${(line.allowedVariants || []).map((variant) => variant || "Standard").join(", ")} allowed; not guaranteed` : line.variant ? ` / ${line.variant}` : ""} · ${line.quantity} ${line.unit}`,
              ),
            ),
          ),
        );
        if (placement.receivedAt)
          card.append(
            el(
              "p",
              { class: "store-receipt-confirmed" },
              `Receipt confirmed ${dateLabel(placement.receivedAt)}`,
            ),
          );
        else if (placement.provenance === "mail-confirmed")
          card.append(
            button("Confirm receipt", async () => {
              requireCurrent(saved);
              if (context.confirmPlacementReceipt)
                return context.confirmPlacementReceipt(placement);
              if (
                (placement.lines || []).some(
                  (line) =>
                    line.selectionMode === "mix" && !line.allocations?.length,
                )
              )
                throw new Error(
                  "Confirm the actual flavor split before receiving a mixed order.",
                );
              return showReceipt(saved, placement, card);
            }),
          );
        else
          card.append(
            el(
              "p",
              { class: "small" },
              "Receipt is recorded by confirmed fulfillment.",
            ),
          );
        if (context.startAddition)
          card.append(
            button("Start addition", async () => {
              requireCurrent(saved);
              await context.startAddition(placement);
            }),
          );
        root.append(card);
      }
      if (result.history?.nextCursor) {
        const more = button(
          loading ? "Loading older placed orders…" : "Load older placed orders",
          load,
        );
        more.disabled = loading;
        root.append(more);
      }
    }
    async function load() {
      requireCurrent(saved);
      if (loading || !isOpen()) return;
      loading = true;
      if (data) draw();
      else root.replaceChildren(notice("Loading placed orders…"));
      try {
        const next = await loadPlacedOrdersPage({
          api,
          path: endpoint(saved, "placements"),
          data,
          isCurrent: active,
        });
        if (!active()) return;
        data = next;
      } catch (error) {
        if (active()) {
          loading = false;
          if (data) draw();
          else root.replaceChildren();
          root.append(
            notice(error.message || "Could not load placements.", true),
          );
          if (!data) root.append(button("Retry placed orders", load));
        }
        return;
      } finally {
        loading = false;
      }
      draw();
    }
    void load();
    return root;
  }

  function showPlacementHistory() {
    const m = scopedModal(
      capture(),
      "Placed orders & receipts",
      getStore()?.name || "",
      true,
    );
    m.content.append(renderPlacementHistory(() => m.dialog.open));
  }
  function showReceipt(saved, placement, card) {
    requireCurrent(saved);
    const m = scopedModal(
      saved,
      "Confirm stock received",
      "Confirm only when all listed items have physically arrived.",
    );
    const openedAt = Date.now();
    const at = input("datetime-local", localDateInput(openedAt), {
      max: localDateInput(),
    });
    const note = el("textarea", { maxlength: 1000, rows: 3 });
    m.content.append(
      notice(
        "This adds one confirmed receipt for the placed order. Repeated confirmations cannot add stock twice.",
      ),
      field("Received at", at),
      field("Receipt note (optional)", note),
    );
    m.footer.append(
      button(
        "Confirm received",
        async () => {
          requireCurrent(saved);
          if (!online()) throw new Error("Reconnect to confirm the receipt.");
          await command("placement.receive", {
            id: placement.id,
            effectiveAt: measurement(
              at.value === localDateInput(openedAt) ? openedAt : at.value,
              Date.now(),
            ),
            note: note.value.trim(),
          });
          if (!current(saved)) return;
          m.close();
          card.querySelector("button")?.remove();
          card.append(
            el(
              "p",
              { class: "store-receipt-confirmed" },
              "Receipt confirmed online.",
            ),
          );
          toast("Receipt confirmed.");
        },
        "primary",
      ),
    );
  }
  return {
    renderInventory,
    showMissingItems,
    renderPlacementHistory,
    showPlacementHistory,
    showHandoffs: showPlacementHistory,
  };
}
