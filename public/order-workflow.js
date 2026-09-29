function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function contents(order) {
  return JSON.stringify([
    order?.id,
    order?.storeId,
    order?.notes || "",
    [...(order?.creditRequestIds || [])].sort(),
    (order?.lines || []).map((line) => ({
      id: line.id,
      productId: line.productId,
      variant: line.variant || "",
      quantity: line.quantity,
      unit: line.unit || "each",
      note: line.note || "",
      selectionMode: line.selectionMode === "mix" ? "mix" : "exact",
      allowedVariants: line.allowedVariants || [],
      excludedVariants: line.excludedVariants || [],
      allocations: line.allocations || [],
    })),
  ]);
}
function changed(
  message = "The selected account, store or order changed. Reopen this action.",
) {
  return Object.assign(new Error(message), {
    code: "WORKFLOW_CONTEXT_CHANGED",
  });
}
function localDate(value = Date.now()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
export function prepareReceiptAllocations(placement, rows) {
  const lines = (placement.lines || []).filter(
    (line) => line.selectionMode === "mix",
  );
  if (
    !Array.isArray(rows) ||
    rows.length !== lines.length ||
    new Set(rows.map((row) => row.lineId)).size !== rows.length
  )
    throw new Error("Enter the actual flavor quantities for every mixed item.");
  return lines.map((line) => {
    const row = rows.find((item) => item.lineId === line.id);
    if (!row || !Array.isArray(row.allocations))
      throw new Error("Enter actual flavor quantities for this mixed item.");
    const seen = new Set();
    const allocations = row.allocations
      .map((allocation) => {
        if (
          !line.allowedVariants?.includes(allocation.variant) ||
          seen.has(allocation.variant)
        )
          throw new Error("Choose a permitted flavor without duplicate rows.");
        seen.add(allocation.variant);
        const raw = String(allocation.quantity ?? "").trim();
        const quantity = Number(raw);
        if (
          !/^\d+$/.test(raw) ||
          !Number.isSafeInteger(quantity) ||
          quantity < 0 ||
          quantity > 1_000_000
        )
          throw new Error(
            "Flavor quantity must be a whole number from 0 to 1,000,000.",
          );
        return { variant: allocation.variant, quantity };
      })
      .filter((allocation) => allocation.quantity > 0);
    if (
      allocations.reduce(
        (total, allocation) => total + allocation.quantity,
        0,
      ) !== line.quantity
    )
      throw new Error(
        `Actual flavor quantities must total ${line.quantity} ${line.unit || "each"}.`,
      );
    return { lineId: line.id, allocations };
  });
}

export function createOrderWorkflow(context) {
  const {
    el,
    input,
    button,
    field,
    modal,
    notice,
    toast,
    command,
    getStore,
    getDraft,
    scope,
    isCurrent,
    syncDraft,
    activateDraft,
  } = context;
  const preparedScopes = new WeakMap();
  const capture = (storeId) => {
    const saved = { session: scope(), storeId };
    requireCurrent(saved);
    return saved;
  };
  function current(saved) {
    try {
      return isCurrent(saved.session) && getStore()?.id === saved.storeId;
    } catch {
      return false;
    }
  }
  function requireCurrent(saved) {
    if (!current(saved)) throw changed();
  }
  function scopedModal(saved, ...args) {
    const view = modal(...args);
    const timer = setInterval(() => {
      if (!current(saved)) view.close();
    }, 400);
    view.dialog.addEventListener("close", () => clearInterval(timer), {
      once: true,
    });
    return view;
  }
  async function prepareHandoff(order) {
    if (!order?.id || !order.storeId)
      throw new Error("Choose an order to prepare for Mail.");
    const saved = capture(order.storeId);
    const original = structuredClone(order);
    const fingerprint = contents(original);
    const active = getDraft()?.id === order.id;
    const ensureOrder = () => {
      requireCurrent(saved);
      if (active && contents(getDraft()) !== fingerprint)
        throw changed(
          "This order changed while preparing Mail. Reopen Email order to use the current revision.",
        );
    };
    try {
      let confirmed = original;
      if (active) {
        const result = await syncDraft(original);
        ensureOrder();
        confirmed = result?.order || result || getDraft();
        if (contents(confirmed) !== fingerprint)
          throw changed(
            "The saved order changed. Reopen Email order before continuing.",
          );
      }
      if (!Number.isSafeInteger(confirmed.version) || confirmed.version < 1)
        throw new Error("This order has not been confirmed online.");
      const handoff = await command("order.handoff", {
        id: confirmed.id,
        expectedVersion: confirmed.version,
      });
      ensureOrder();
      if (
        !handoff?.id ||
        handoff.orderId !== order.id ||
        handoff.storeId !== order.storeId ||
        !handoff.contentHash ||
        !handoff.snapshot ||
        contents(handoff.snapshot) !== fingerprint
      )
        throw new Error("The saved Mail handoff could not be verified.");
      const prepared = freeze({
        order: structuredClone(handoff.snapshot),
        handoff: structuredClone(handoff),
        warning: null,
      });
      preparedScopes.set(prepared, saved);
      return prepared;
    } catch (error) {
      requireCurrent(saved);
      if (error?.code === "WORKFLOW_CONTEXT_CHANGED") throw error;
      ensureOrder();
      return freeze({
        order: original,
        handoff: null,
        warning:
          "Mail can still open with this order. Its snapshot could not be recorded online, so Mark as placed is unavailable for this handoff.",
      });
    }
  }
  async function markPlaced(prepared) {
    const saved = preparedScopes.get(prepared);
    if (!saved || !prepared.handoff?.id)
      throw new Error(
        "This Mail handoff was not recorded online. Reopen Email order before marking it placed.",
      );
    requireCurrent(saved);
    const placement = await command("order.place", {
      handoffId: prepared.handoff.id,
    });
    requireCurrent(saved);
    return placement;
  }
  async function startAddition(parent, { placement = false } = {}) {
    if (!parent?.id || !parent.storeId)
      throw new Error("Choose the original placed order.");
    const saved = capture(parent.storeId);
    const id = crypto.randomUUID();
    const result = await command("order.addition", {
      id,
      storeId: parent.storeId,
      [placement ? "parentPlacementId" : "parentOrderId"]: parent.id,
    });
    requireCurrent(saved);
    if (
      result?.id !== id ||
      result.storeId !== saved.storeId ||
      result.status !== "draft"
    )
      throw new Error(
        "The new addition could not be verified. Refresh the workspace.",
      );
    await activateDraft(result);
    return result;
  }
  function showPlacementReceipt(placement) {
    const saved = capture(placement?.storeId);
    if (!placement?.id || placement.provenance !== "mail-confirmed")
      throw new Error("App orders are received when staff confirm delivery.");
    if (placement.receivedAt)
      throw new Error("This placement already has a confirmed receipt.");
    const m = scopedModal(
      saved,
      "Confirm stock received",
      `${getStore().name} · Confirm only items that have physically arrived.`,
      true,
    );
    const openedAt = Date.now();
    const received = input("datetime-local", localDate(openedAt), {
      max: localDate(),
      min: localDate(placement.placedAt),
    });
    const note = el("textarea", { maxlength: 1000, rows: 3 });
    m.content.append(
      notice(
        "Confirm the entire order only when every listed item has arrived. This records one receipt and preserves the original purchase.",
      ),
      field("Received at", received),
      field("Receipt note (optional)", note),
    );
    const mixed = (placement.lines || []).filter(
      (line) => line.selectionMode === "mix",
    );
    const entries = mixed.map((line) => {
      const status = el("p", {
        class: "small",
        role: "status",
        "aria-live": "polite",
      });
      const rows = (line.allowedVariants || []).map((variant) => ({
        variant,
        control: input(
          "number",
          line.allocations?.find((item) => item.variant === variant)
            ?.quantity ?? 0,
          { min: 0, max: 1_000_000, step: 1, inputmode: "numeric" },
        ),
      }));
      const update = () => {
        const total = rows.reduce(
          (sum, row) => sum + Number(row.control.value || 0),
          0,
        );
        status.textContent = `${Number.isFinite(total) ? total : "Invalid"} of ${line.quantity} ${line.unit || "each"} allocated`;
      };
      rows.forEach(({ control }) => control.addEventListener("input", update));
      const section = el(
        "section",
        { class: "store-placement-card" },
        el("h3", {}, line.name || line.productName || line.productId),
        el(
          "p",
          {},
          `Mix: ${line.quantity} ${line.unit || "each"} total. Enter the actual flavor split in the same unit.`,
        ),
        rows.map(({ variant, control }) =>
          field(variant || "Standard", control),
        ),
        status,
      );
      update();
      m.content.append(section);
      return { line, rows };
    });
    if (!mixed.length)
      m.content.append(
        el(
          "ul",
          {},
          (placement.lines || []).map((line) =>
            el(
              "li",
              {},
              `${line.name || line.productName || line.productId}${line.variant ? ` / ${line.variant}` : ""} · ${line.quantity} ${line.unit || "each"}`,
            ),
          ),
        ),
      );
    m.footer.append(
      button("Cancel", m.close),
      button(
        "Confirm received",
        async () => {
          requireCurrent(saved);
          if (globalThis.navigator?.onLine === false)
            throw new Error("Reconnect before confirming the receipt.");
          const effectiveAt =
            received.value === localDate(openedAt)
              ? openedAt
              : new Date(received.value).getTime();
          if (
            !Number.isSafeInteger(effectiveAt) ||
            effectiveAt < placement.placedAt ||
            effectiveAt > Date.now()
          )
            throw new Error(
              "Choose a receipt date after placement and not in the future.",
            );
          const actualMixAllocations = prepareReceiptAllocations(
            placement,
            entries.map(({ line, rows }) => ({
              lineId: line.id,
              allocations: rows.map(({ variant, control }) => ({
                variant,
                quantity: control.value,
              })),
            })),
          );
          const result = await command("placement.receive", {
            id: placement.id,
            effectiveAt,
            note: note.value.trim(),
            ...(mixed.length ? { actualMixAllocations } : {}),
          });
          requireCurrent(saved);
          m.close();
          toast?.("Receipt confirmed online.");
          await context.refresh?.();
          return result;
        },
        "primary",
      ),
    );
    return m;
  }
  return { prepareHandoff, markPlaced, startAddition, showPlacementReceipt };
}
