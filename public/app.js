import { Workspace, StorageFailure, createDraft } from "./storage.js";
import * as firebase from "./firebase.js";
import { createDraftSync } from "./draft-sync.js";
import {
  createOrderDownloads,
  normalizeDeviceCopyOptions,
} from "./order-downloads.js";
import {
  runSessionTask,
  afterConfirmation,
  SessionChanged,
  createRequestGate,
  loadOrderDetails,
} from "./session.js";
import {
  formatSavedDate as date,
  safeProductImage as safeImage,
  recoverLegacyLines,
  isHistoricalOrder,
  orderDocumentOptions,
  indexCatalogProducts,
  rankCatalogProducts,
  normalizeCatalogLayout,
} from "./view-helpers.js";

const $ = (id) => document.getElementById(id);
const uuid = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const cash = (value) =>
  Number.isSafeInteger(value)
    ? currencyFormatter.format(value / 100)
    : "Price needed";
const titleCase = (value) =>
  String(value || "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
const iconPaths = {
  home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
  catalog: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  cart: "M3 3h2l3 12h10l3-9H6M9 20h.01M18 20h.01",
  orders: "M7 3h10v3H7zM7 5H5v16h14V5h-2M9 11h6M9 15h6",
  stores: "M3 10h18l-2-6H5zM5 10v11h14V10M9 21v-7h6v7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  plus: "M12 5v14M5 12h14",
  close: "M6 6l12 12M18 6 6 18",
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z",
  search: "M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-2 4 6 6",
  arrow: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12l4 4L19 6",
  box: "m12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M7 5.8l9 5",
  wallet: "M3 6h17v14H3zM3 6V3h14v3M15 11h6v5h-6z",
  scan: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5M7 8v8M10 8v8M14 8v8M17 8v8",
  spark: "m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z",
  refresh:
    "M20 7v5h-5M4 17v-5h5M5.5 7a7.5 7.5 0 0 1 12-2l2.5 7M4 12l2.5 7a7.5 7.5 0 0 0 12-2",
  download: "M12 3v12M7 10l5 5 5-5M4 17v4h16v-4",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2",
  edit: "m4 16 12-12 4 4L8 20H4zm10-10 4 4",
  return: "M9 4 3 10l6 6M3 10h11a6 6 0 0 1 0 12",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(svg.namespaceURI, "path");
  p.setAttribute("d", iconPaths[name] || iconPaths.box);
  append(svg, p);
  return svg;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on"))
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "text") node.textContent = value;
    else if (key === "checked") node.checked = !!value;
    else if (key === "value") node.value = value;
    else if (key === "disabled") node.disabled = !!value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false)
      append(
        node,
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
}
function append(node, ...children) {
  node.append(
    ...children
      .flat(Infinity)
      .filter((child) => child != null && child !== false),
  );
}
function button(text, fn, kind = "", symbol) {
  return el(
    "button",
    {
      type: "button",
      class: kind,
      onClick: (event) => act(fn, event.currentTarget),
    },
    symbol ? icon(symbol) : null,
    text,
  );
}
function iconButton(label, symbol, fn) {
  const b = button("", fn, "icon-button subtle", symbol);
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}
async function act(fn, buttonNode) {
  if (buttonNode?.disabled) return;
  try {
    if (buttonNode) {
      buttonNode.disabled = true;
      buttonNode.setAttribute("aria-busy", "true");
      buttonNode
        .closest("dialog,form")
        ?.querySelector(".action-error")
        ?.remove();
    }
    return await fn();
  } catch (error) {
    const container = buttonNode?.closest("dialog,form");
    if (container) {
      const message = notice(friendlyError(error), true);
      message.classList.add("action-error");
      message.tabIndex = -1;
      const target = container.querySelector(".dialog-body") || container;
      append(target, message);
      message.focus();
    }
    if (error instanceof StorageFailure && state) updateStorageNotice();
    toast(friendlyError(error), true);
  } finally {
    if (buttonNode?.isConnected) {
      buttonNode.disabled = false;
      buttonNode.removeAttribute("aria-busy");
    }
  }
}
function field(label, node, help) {
  const id = node.id || `field-${uuid()}`;
  node.id = id;
  if (!node.name) node.name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const result = el(
    "div",
    { class: "field" },
    el("label", { for: id }, label),
    node,
  );
  if (help) {
    const hint = el("p", { class: "small", id: `${id}-help` }, help);
    node.setAttribute("aria-describedby", hint.id);
    append(result, hint);
  }
  return result;
}
function input(type = "text", value = "", attrs = {}) {
  return el("input", {
    type,
    value,
    autocomplete: "off",
    ...(["email", "url"].includes(type) ? { spellcheck: false } : {}),
    ...attrs,
  });
}
function select(options, value, attrs = {}) {
  const node = el(
    "select",
    attrs,
    ...options.map((option) =>
      el(
        "option",
        { value: Array.isArray(option) ? option[0] : option },
        Array.isArray(option) ? option[1] : titleCase(option),
      ),
    ),
  );
  node.value = value ?? "";
  return node;
}
function status(value) {
  return el(
    "span",
    { class: `status ${String(value || "unknown").replace(/[^a-z]/g, "")}` },
    titleCase(value || "unknown"),
  );
}
function notice(message, error = false) {
  return el(
    "div",
    { class: `notice${error ? " error" : ""}`, role: error ? "alert" : "note" },
    message,
  );
}
function empty(title, description, actions = [], symbol = "box") {
  return el(
    "div",
    { class: "empty" },
    icon(symbol),
    el("h2", {}, title),
    el("p", {}, description),
    el("div", { class: "actions" }, actions),
  );
}
function table(headers, rows) {
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          headers.map((label) => el("th", { scope: "col" }, label)),
        ),
      ),
      el("tbody", {}, rows),
    ),
  );
}
function td(...children) {
  return el("td", {}, children);
}
function heading(title, description, actions = []) {
  return el(
    "header",
    { class: "page-heading" },
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, "Alabama Wholesale"),
      el("h1", { id: "page-title", tabindex: -1 }, title),
      el("p", {}, description),
    ),
    el("div", { class: "actions" }, actions),
  );
}
function toast(message, error = false) {
  const node = el(
    "div",
    {
      class: `toast${error ? " error" : ""}`,
      role: error ? "alert" : "status",
    },
    el("span", {}, message),
    button("×", () => node.remove()),
  );
  $("toasts").append(node);
  setTimeout(() => node.remove(), error ? 16000 : 6500);
}
function announce(text) {
  $("announcements").textContent = text;
}
function friendlyError(error) {
  const messages = {
    "auth/popup-blocked":
      "Your browser blocked the sign-in window. Allow popups for this site and try again.",
    "auth/popup-closed-by-user": "Sign-in was closed before it finished.",
    "auth/invalid-credential":
      "The email or password was not accepted. Please try again.",
    "auth/email-already-in-use":
      "This email already has an account. Sign in or reset your password.",
    "auth/weak-password": "Choose a password with at least 12 characters.",
    "auth/network-request-failed":
      "The connection failed. Check your internet connection and try again.",
    "auth/too-many-requests":
      "Too many attempts. Wait a moment, then try again.",
  };
  return (
    messages[error?.code] ||
    error?.message ||
    "Something went wrong. Please try again."
  );
}
function modal(title, subtitle = "", wide = false) {
  const previous = document.activeElement;
  const dialog = el("dialog", { class: wide ? "wide" : "" });
  const titleId = `dialog-${uuid()}`;
  dialog.setAttribute("aria-labelledby", titleId);
  const body = el("div", { class: "dialog-body" });
  const header = el(
    "div",
    { class: "dialog-head" },
    el(
      "div",
      {},
      el("h2", { id: titleId }, title),
      subtitle ? el("p", {}, subtitle) : null,
    ),
    iconButton("Close dialog", "close", () => dialog.close()),
  );
  const content = el("div");
  const footer = el("div", { class: "dialog-footer" });
  append(body, header, content, footer);
  append(dialog, body);
  append(document.body, dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    previous?.isConnected && previous.focus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    }
  });
  dialog.showModal();
  return { dialog, content, footer, close: () => dialog.close() };
}
async function confirmAction(title, message, label = "Confirm") {
  return new Promise((resolve) => {
    const m = modal(title, message);
    let resolved = false;
    append(
      m.footer,
      button("Cancel", () => {
        resolved = true;
        resolve(false);
        m.close();
      }),
      button(
        label,
        () => {
          resolved = true;
          resolve(true);
          m.close();
        },
        "primary",
      ),
    );
    m.dialog.addEventListener("close", () => {
      if (!resolved) resolve(false);
    });
  });
}
function download(name, content, type = "application/json") {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  append(document.body, a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

let config,
  ws,
  session = null,
  state = null,
  view = [
    "home",
    "catalog",
    "build",
    "orders",
    "stores",
    "more",
    "inventory",
    "payments",
    "returns",
    "notifications",
  ].includes(location.hash.slice(2))
    ? location.hash.slice(2)
    : "home",
  storeId = "",
  draft = null,
  undo = [],
  redo = [],
  search = "",
  category = "",
  favoritesOnly = false,
  orderFilter = "",
  queueBusy = false,
  loading = false;
let draftSync = null;
let orderDownloads = null;
const draftProtectionCache = new Map();
const pendingProtectionUpdates = new Set();
let protectionFrame = null;
let lastRefresh = 0,
  orderCursor = undefined,
  cameraCleanup = null;
const orderHistoryRequests = createRequestGate();
function resetOrderHistory() {
  orderHistoryRequests.invalidate();
  orderCursor = undefined;
}
const staff = () =>
  state?.me?.role === "master" || state?.me?.role === "salesman";
const master = () => state?.me?.role === "master";
const currentStore = () => state?.stores.find((store) => store.id === storeId);
const productById = (id) =>
  state?.products.find((product) => product.id === id);
const storeById = (id) => state?.stores.find((store) => store.id === id);
const unread = () =>
  state?.notifications.filter((n) => !(n.readBy || []).includes(state.me.uid))
    .length || 0;
const preferences = () => ({ ...state?.me?.preferences, ...ws?.preferences() });
function deviceCopyOptions() {
  return normalizeDeviceCopyOptions(ws?.preferences().orderDeviceCopy);
}
function deviceCopySettings() {
  const scope = operationScope();
  const options = deviceCopyOptions();
  const enabled = input("checkbox", "", {
    checked: options.enabled,
    "data-automatic-order-copy": "true",
  });
  const format = select(
    [
      ["pdf", "PDF invoice"],
      ["json", "JSON order archive"],
      ["both", "PDF and JSON"],
    ],
    options.format,
    { "data-order-copy-format": "true" },
  );
  const value = () =>
    normalizeDeviceCopyOptions({
      enabled: enabled.checked,
      format: format.value,
    });
  const remember = () =>
    act(() => {
      if (!scopeCurrent(scope)) throw new SessionChanged();
      scope.workspace.rememberPreferences({ orderDeviceCopy: value() });
      updateStorageNotice();
    });
  enabled.addEventListener("change", remember);
  format.addEventListener("change", remember);
  return {
    value,
    element: el(
      "section",
      { class: "panel mt" },
      el("h3", {}, "Completed-order device copy"),
      el(
        "label",
        { class: "check-field" },
        enabled,
        "Automatically download a copy after submitting an order",
      ),
      field("Completed-order copy format", format),
      el(
        "p",
        { class: "small" },
        "For this account on this device. Your browser controls file downloads. Choose PDF to read or print, or JSON for a structured order archive.",
      ),
    ),
  };
}
async function orderPdfBlob(order, kind = "invoice", scope = operationScope()) {
  if (!scopeCurrent(scope)) throw new SessionChanged();
  const response = await api(
    `/api/documents/${encodeURIComponent(order.id)}/${kind}`,
    { raw: true },
  );
  if (!scopeCurrent(scope)) throw new SessionChanged();
  const blob = await response.blob();
  if (!scopeCurrent(scope)) throw new SessionChanged();
  return blob;
}
function updateOrderCopyPanel(panel, copyStatus = {}) {
  const phase = copyStatus.phase || "idle";
  const labels = {
    idle: "Save a copy of this completed order to this device.",
    preparing: "Preparing your device copy…",
    requested: "Download requested. Check your browser’s Downloads.",
    partial:
      "Some copies could not be prepared. Your order is still saved online.",
    error:
      "Device copy could not be prepared. Your order is still saved online.",
  };
  panel.querySelector("[data-copy-message]").textContent =
    labels[phase] || labels.idle;
  const error = panel.querySelector("[data-copy-error]");
  error.textContent = copyStatus.error || "";
  error.hidden = !copyStatus.error;
  const action = panel.querySelector("[data-copy-action]");
  action.disabled = phase === "preparing";
  action.textContent =
    phase === "preparing"
      ? "Preparing…"
      : ["requested", "partial"].includes(phase)
        ? "Download again"
        : phase === "error"
          ? "Retry device copy"
          : "Save to device";
}
function updateOrderCopyPanels(id, copyStatus) {
  document.querySelectorAll("[data-order-copy]").forEach((panel) => {
    if (panel.dataset.orderCopy === id) updateOrderCopyPanel(panel, copyStatus);
  });
}
function orderCopyPanel(order) {
  const scope = operationScope();
  const copyStatus = orderDownloads?.status(order.id);
  const format = select(
    [
      ["pdf", "PDF invoice"],
      ["json", "JSON order archive"],
      ["both", "PDF and JSON"],
    ],
    copyStatus?.phase && copyStatus.phase !== "idle"
      ? copyStatus.format
      : deviceCopyOptions().format,
  );
  const panel = el(
    "section",
    { class: "panel mt", "data-order-copy": order.id },
    el("h3", {}, "Device copy"),
    el("p", { "data-copy-message": "true", role: "status" }),
    el("p", {
      "data-copy-error": "true",
      class: "small",
      role: "alert",
      hidden: true,
    }),
    field("Device copy format", format),
    button("Save to device", async () => {
      if (!scopeCurrent(scope)) throw new SessionChanged();
      if (!orderDownloads)
        throw new Error("Reconnect before downloading this order.");
      await orderDownloads.save(order, { enabled: true, format: format.value });
    }),
    el(
      "p",
      { class: "small" },
      "Your browser controls the download location. If no file appears, try again and allow downloads. A JSON copy is an archive for review.",
    ),
  );
  panel.querySelector("button").dataset.copyAction = "true";
  updateOrderCopyPanel(panel, copyStatus);
  return panel;
}
function requestCompletedOrderCopy(entry, result, scope) {
  if (
    entry.command.type !== "order.submit" ||
    !scopeCurrent(scope) ||
    !orderDownloads
  )
    return;
  const downloader = orderDownloads;
  // This optional side effect must never re-enter the financial error path.
  void Promise.resolve()
    .then(() => {
      if (!scopeCurrent(scope)) return;
      const options = normalizeDeviceCopyOptions(
        entry.metadata?.deviceCopy ||
          scope.workspace.preferences().orderDeviceCopy,
      );
      return downloader.automatic(result.order || result, {
        requestId: entry.command.id,
        options,
      });
    })
    .catch(() => {
      if (scopeCurrent(scope))
        toast(
          "Order saved online. Open the order to retry its device copy.",
          true,
        );
    });
}
function saveWorkingDraft(value, workspace = ws) {
  const result = workspace.saveDraftForCloud(value);
  if (workspace === ws) {
    draftProtectionCache.delete(result.draft.id);
    draftSync?.stage(result.draft);
  }
  return result.draft;
}
function draftProtection(id) {
  let status = draftProtectionCache.get(id);
  if (!status) {
    if (draftSync) status = draftSync.status(id);
    else {
      const current = ws?.getDraft(id);
      status = {
        localPersisted: ws?.localDraftStatus(id)?.localPersisted ?? false,
        cloudConfirmed: current?.syncState === "synced",
      };
    }
    draftProtectionCache.set(id, status);
  }
  const { localPersisted, cloudConfirmed } = status;
  const phase =
    status?.phase ||
    (cloudConfirmed ? "saved" : navigator.onLine ? "dirty" : "offline");
  if (draft?.id === id && hasUnsavedDraftNotes())
    return {
      ...status,
      phase: "error",
      localPersisted: false,
      cloudConfirmed: false,
      label: "Changes not saved · copy or retry your notes",
      tone: "error",
    };
  let label,
    tone = "warning";
  if (cloudConfirmed) {
    label = "Saved online";
    tone = "";
  } else if (phase === "conflict") {
    label = localPersisted
      ? "Cloud conflict · edits kept on this device"
      : "Cloud conflict · keep this tab open";
    tone = "error";
  } else if (phase === "error" || phase === "blocked") {
    label = localPersisted
      ? "Only on this device · cloud save needs attention"
      : "Not yet protected · keep this tab open";
    tone = "error";
  } else if (!navigator.onLine || phase === "offline") {
    label = localPersisted
      ? "Only on this device · waiting for connection"
      : "Not yet protected · keep this tab open";
    tone = localPersisted ? "warning" : "error";
  } else {
    label = localPersisted
      ? "Saving online… · device copy saved"
      : "Not yet protected · saving online…";
  }
  return { ...status, phase, localPersisted, cloudConfirmed, label, tone };
}
function updateDraftMetadata(id) {
  if (!ws) return;
  const saved = draftSync?.get(id) || ws.getDraft(id);
  if (draft?.id === id && saved?.localRevision === draft.localRevision) {
    draft = {
      ...draft,
      version: saved.version,
      syncState: saved.syncState,
      lastSyncedAt: saved.lastSyncedAt,
    };
  }
  return saved;
}
function updateDraftProtection(id, { aggregate = true } = {}) {
  if (!ws) return;
  const saved = updateDraftMetadata(id);
  const protection = draftProtection(id);
  if (state && saved && protection.cloudConfirmed) {
    const confirmed = { ...saved, status: "draft" };
    const index = state.orders.findIndex((item) => item.id === id);
    if (index < 0) state.orders.unshift(confirmed);
    else if (state.orders[index].status === "draft")
      state.orders[index] = confirmed;
  }
  if (draft?.id === id) {
    if ($("draft-sync-message"))
      $("draft-sync-message").textContent = protection.label;
    if ($("draft-sync-dot"))
      $("draft-sync-dot").className = `sync-dot ${protection.tone}`;
  }
  document.querySelectorAll("[data-draft-protection]").forEach((node) => {
    if (node.dataset.draftProtection === id)
      node.textContent = protection.label;
  });
  if (aggregate) updateWorkspaceProtection();
}
function scheduleDraftProtectionUpdate(id, scope) {
  draftProtectionCache.delete(id);
  updateDraftMetadata(id);
  pendingProtectionUpdates.add(id);
  if (protectionFrame !== null) return;
  protectionFrame = requestAnimationFrame(() => {
    protectionFrame = null;
    const ids = [...pendingProtectionUpdates];
    pendingProtectionUpdates.clear();
    if (!scopeCurrent(scope)) return;
    try {
      for (const changedId of ids)
        updateDraftProtection(changedId, { aggregate: false });
      updateWorkspaceProtection();
    } catch {
      // Presentation or device reads cannot undo an online confirmation.
      const status = draft && draftSync?.status(draft.id);
      if ($("draft-sync-message"))
        $("draft-sync-message").textContent = status?.cloudConfirmed
          ? "Saved online · device copy unavailable"
          : "Save status unavailable · keep this tab open";
    }
  });
}
function resetDraftProtection() {
  draftProtectionCache.clear();
  pendingProtectionUpdates.clear();
  if (protectionFrame !== null) cancelAnimationFrame(protectionFrame);
  protectionFrame = null;
}
function workspaceProtection() {
  const pending = ws?.pending().length || 0;
  if (pending) return { label: `${pending} action pending`, tone: "warning" };
  const unconfirmed = unconfirmedDrafts();
  if (unconfirmed.length) {
    const unprotected = unconfirmed.some(
      (item) => !draftProtection(item.id).localPersisted,
    );
    return {
      label: unprotected
        ? "Draft not yet protected"
        : navigator.onLine
          ? `${unconfirmed.length} draft saving`
          : `${unconfirmed.length} draft on this device`,
      tone: unprotected ? "error" : "warning",
    };
  }
  return {
    label: navigator.onLine ? "Saved online" : "Offline",
    tone: navigator.onLine ? "" : "error",
  };
}
function updateWorkspaceProtection() {
  if (!$("workspace-sync-label")) return;
  const protection = workspaceProtection();
  $("workspace-sync-label").textContent = protection.label;
  $("workspace-sync-dot").className = `sync-dot ${protection.tone}`;
}
function unconfirmedDrafts() {
  return (ws?.listDrafts() || []).filter(
    (item) => !draftProtection(item.id).cloudConfirmed,
  );
}
async function flushWorkingDrafts() {
  if (!draftSync || !navigator.onLine) return;
  draftProtectionCache.clear();
  const controller = draftSync;
  try {
    await Promise.allSettled(
      unconfirmedDrafts().map((item) => controller.flush(item.id)),
    );
  } catch {
    /* Sign-out and recovery still need to work if device reads are blocked. */
  }
}
function showDraftProtection(id) {
  const scope = operationScope();
  const current = ws.getDraft(id);
  if (!current) throw new Error("This draft is no longer available.");
  const protection = draftProtection(id);
  const m = modal("Draft saving", protection.label);
  append(
    m.content,
    notice(
      protection.cloudConfirmed
        ? "This version is saved to your account online and can be reopened on another device."
        : protection.localPersisted
          ? "Your current edits are saved on this device. Keep the app connected to finish saving them online."
          : "The latest edits exist only in this tab until the online save succeeds. Keep it open or export a copy now.",
      !protection.cloudConfirmed && !protection.localPersisted,
    ),
  );
  if (protection.error)
    append(
      m.content,
      notice(
        typeof protection.error === "string"
          ? protection.error
          : friendlyError(protection.error),
        true,
      ),
    );
  append(
    m.footer,
    button(
      "Export draft",
      () =>
        download(
          `draft-${id}.json`,
          JSON.stringify(draftRecoverySnapshot(id), null, 2),
        ),
      "",
      "download",
    ),
    button("Close", m.close),
    button(
      "Retry online save",
      async () => {
        if (!scopeCurrent(scope)) throw new SessionChanged();
        if (!draftSync)
          throw new Error("Reconnect to your account before saving online.");
        await draftSync.retry(id);
        if (!scopeCurrent(scope)) throw new SessionChanged();
        m.close();
        showDraftProtection(id);
      },
      "primary",
    ),
  );
  if (["conflict", "blocked", "error"].includes(protection.phase)) {
    append(
      m.content,
      el(
        "div",
        { class: "actions mt" },
        button("Keep edits as a new draft", async () => {
          if (!scopeCurrent(scope)) throw new SessionChanged();
          const original = draftRecoverySnapshot(id);
          const copied = saveWorkingDraft({
            ...original,
            id: uuid(),
            version: 0,
            localRevision: 0,
            syncState: "local",
            createdAt: Date.now(),
          });
          draft = copied;
          storeId = copied.storeId;
          ws.rememberPreferences({
            activeDraftIds: {
              ...preferences().activeDraftIds,
              [storeId]: copied.id,
            },
          });
          undo = [];
          redo = [];
          m.close();
          setView("build");
        }),
        button(
          "Reload the online draft",
          async () => {
            if (
              !(await confirmAction(
                "Replace these edits with the online draft?",
                "Export first if you want to keep your current edits. This replaces this draft’s working copy with the saved online version.",
                "Load online version",
              ))
            )
              return;
            if (!scopeCurrent(scope)) throw new SessionChanged();
            const before = scope.workspace.getDraft(id);
            const response = await api(`/api/orders/${encodeURIComponent(id)}`);
            if (!scopeCurrent(scope)) throw new SessionChanged();
            if (response.order?.status !== "draft")
              throw new Error(
                "This order has already been submitted. Keep your edits as a new draft instead.",
              );
            const restored = scope.workspace.reloadDraftFromCloud(
              response.order,
              before.localRevision,
            );
            draftSync.forget(id);
            draftSync.seed([response.order]);
            if (draft?.id === id) {
              draft = restored.draft;
              undo = [];
              redo = [];
            }
            m.close();
            render();
          },
          "danger",
        ),
      ),
    );
  }
}
function draftRecoverySnapshot(id) {
  const saved = ws?.getDraft(id);
  const note = $("draft-notes");
  return saved &&
    note?.dataset.draftId === id &&
    note.value !== (saved.notes || "")
    ? {
        ...saved,
        notes: note.value,
        syncState: "local",
        needsReconciliation: true,
      }
    : saved;
}
function workspaceRecoverySnapshot() {
  const backup = ws.exportBackup();
  if (draft && hasUnsavedDraftNotes())
    backup.drafts = backup.drafts.map((item) =>
      item.id === draft.id ? draftRecoverySnapshot(item.id) : item,
    );
  return backup;
}
function operationScope() {
  return {
    generation: identityGeneration,
    identity: firebase.identity(),
    workspace: ws,
    session,
  };
}
function scopeCurrent(scope) {
  return (
    scope.generation === identityGeneration &&
    scope.workspace === ws &&
    scope.identity?.uid === firebase.identity()?.uid
  );
}
async function api(path, { method = "GET", body, raw = false } = {}) {
  const scope = operationScope();
  return runSessionTask(scope, scopeCurrent, async () => {
    if (!navigator.onLine)
      throw Object.assign(
        new Error(
          "You are offline. Check your draft’s save status before closing this tab.",
        ),
        { code: "NETWORK" },
      );
    const headers = await firebase.credentials(false, scope.identity);
    if (!scopeCurrent(scope)) throw new SessionChanged();
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (!navigator.onLine)
      throw Object.assign(
        new Error(
          "You are offline. Check your draft’s save status before closing this tab.",
        ),
        { code: "NETWORK" },
      );
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      throw Object.assign(
        new Error(
          error.name === "AbortError"
            ? "The request timed out. Retry uses the same request ID."
            : "Could not reach the server. Check your draft’s save status before closing this tab.",
        ),
        { code: "NETWORK" },
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!scopeCurrent(scope)) throw new SessionChanged();
    if (!response.ok) {
      let data;
      try {
        data = await response.json();
      } catch {}
      throw Object.assign(
        new Error(
          data?.error?.message ||
            `The server could not complete the request (${response.status}).`,
        ),
        {
          code: data?.error?.code || String(response.status),
          status: response.status,
        },
      );
    }
    return raw ? response : response.json();
  });
}
function editorIsActive() {
  return (
    !!document.querySelector("dialog[open]") ||
    !!document.activeElement?.matches(
      "input, textarea, select, [contenteditable=true]",
    ) ||
    hasUnsavedDraftNotes()
  );
}
function availableDrafts() {
  return ws.listDrafts();
}
function retireCanonicalDraft(order) {
  if (!order || order.status === "draft" || !ws) return;
  const result = ws.retireConfirmedDraft(order);
  if (!result.retired) return;
  draftSync?.forget(order.id);
  draftProtectionCache.delete(order.id);
}
function restoreActiveDraft(preferredId = draft?.id) {
  if (!ws || hasUnsavedDraftNotes()) return false;
  const candidates = availableDrafts().filter(
    (item) => item.storeId === storeId,
  );
  const next =
    candidates.find((item) => item.id === preferredId) ||
    candidates.find(
      (item) => item.id === preferences().activeDraftIds?.[storeId],
    ) ||
    candidates[0] ||
    null;
  const changed = JSON.stringify(next) !== JSON.stringify(draft);
  if (changed) {
    draft = next;
    undo = [];
    redo = [];
  }
  return changed;
}
let foregroundRefreshBusy = false,
  workspaceRefreshGeneration = 0,
  lastDraftRefresh = 0;
async function refreshInForeground() {
  if (
    !session ||
    !state ||
    !storeId ||
    !navigator.onLine ||
    document.visibilityState !== "visible" ||
    editorIsActive() ||
    foregroundRefreshBusy ||
    Date.now() - lastDraftRefresh < 25000
  )
    return;
  foregroundRefreshBusy = true;
  const scope = operationScope(),
    selectedStore = storeId,
    refreshGeneration = ++workspaceRefreshGeneration;
  try {
    const result = await api(
      `/api/drafts?storeId=${encodeURIComponent(selectedStore)}`,
    );
    if (
      !scopeCurrent(scope) ||
      refreshGeneration !== workspaceRefreshGeneration ||
      storeId !== selectedStore ||
      editorIsActive()
    )
      return;
    const remote = result.orders;
    if (!Array.isArray(remote)) return;
    if (
      draft?.syncState === "synced" &&
      draft.storeId === selectedStore &&
      !remote.some((item) => item.id === draft.id)
    ) {
      const result = await api(`/api/orders/${encodeURIComponent(draft.id)}`);
      if (
        !scopeCurrent(scope) ||
        refreshGeneration !== workspaceRefreshGeneration ||
        storeId !== selectedStore ||
        editorIsActive()
      )
        return;
      if (result.order?.status === "draft") remote.push(result.order);
      else if (result.order) {
        retireCanonicalDraft(result.order);
        state.orders = [
          ...state.orders.filter((item) => item.id !== result.order.id),
          result.order,
        ];
      }
    }
    scope.workspace.mergeRemoteDrafts(remote);
    draftProtectionCache.clear();
    draftSync?.seed(remote);
    state.orders = [
      ...state.orders.filter(
        (item) => item.status !== "draft" || item.storeId !== selectedStore,
      ),
      ...remote,
    ];
    const changed = restoreActiveDraft();
    lastDraftRefresh = Date.now();
    if (changed && view === "build") render();
    else updateWorkspaceProtection();
  } catch {
    /* Draft autosave reports its own status; an unavailable background read never discards local edits. */
  } finally {
    foregroundRefreshBusy = false;
  }
}
async function refresh({ renderPage = true, passive = false } = {}) {
  if (!session) return;
  resetOrderHistory();
  const scope = operationScope(),
    refreshGeneration = ++workspaceRefreshGeneration;
  return runSessionTask(
    scope,
    scopeCurrent,
    () => api("/api/state"),
    (next) => {
      // A request may finish after the user starts typing. Never replace that editor.
      if (
        refreshGeneration !== workspaceRefreshGeneration ||
        (passive && editorIsActive())
      )
        return;
      const preserveInput = hasUnsavedDraftNotes();
      for (const key of [
        "categories",
        "products",
        "stores",
        "orders",
        "inventory",
        "ledger",
        "payments",
        "returns",
        "notifications",
        "users",
      ])
        next[key] = Array.isArray(next[key]) ? next[key] : [];
      state = next;
      state.me = next.me || scope.session;
      resetOrderHistory();
      const remoteDrafts = state.orders.filter(
        (order) => order.status === "draft",
      );
      if (!preserveInput) {
        const cachedDraftIds = new Set(
          scope.workspace.listDrafts().map((item) => item.id),
        );
        state.orders
          .filter((item) => cachedDraftIds.has(item.id))
          .forEach(retireCanonicalDraft);
      }
      scope.workspace.mergeRemoteDrafts(remoteDrafts);
      draftProtectionCache.clear();
      draftSync?.seed(remoteDrafts);
      if (!state.stores.some((store) => store.id === storeId))
        storeId = state.stores[0]?.id || "";
      const changed = restoreActiveDraft();
      lastRefresh = Date.now();
      if (
        renderPage &&
        !preserveInput &&
        (!passive || changed || view !== "build")
      )
        render();
    },
  );
}
async function sendEntry(entry) {
  const scope = operationScope();
  let result;
  try {
    result = await runSessionTask(
      scope,
      scopeCurrent,
      () => api("/api/commands", { method: "POST", body: entry.command }),
      (data) => {
        const result = data.result || {};
        if (entry.command.type === "order.save") {
          scope.workspace.markDraftSynced(
            entry.command.payload.id,
            entry.metadata.localRevision,
            result.order || result,
          );
          if (draft?.id === entry.command.payload.id)
            draft = scope.workspace.getDraft(draft.id);
        }
        if (entry.command.type === "order.submit") {
          scope.workspace.removeDraft(entry.command.payload.id);
          draftSync?.forget(entry.command.payload.id);
          draftProtectionCache.delete(entry.command.payload.id);
          if (draft?.id === entry.command.payload.id) draft = null;
        }
        scope.workspace.acknowledge(entry.command.id);
        return result;
      },
    );
  } catch (error) {
    scope.workspace.fail(
      entry.command.id,
      friendlyError(error),
      error.code || "UNCONFIRMED",
      error.status,
    );
    throw error;
  }
  requestCompletedOrderCopy(entry, result, scope);
  return result;
}
async function flushQueue(manual = false) {
  if (queueBusy || !session || !navigator.onLine) return;
  queueBusy = true;
  try {
    for (const entry of ws.pending()) {
      if (entry.error && !manual) break;
      await sendEntry(entry);
    }
    await refresh();
  } catch (error) {
    if (manual) throw error;
    render();
  } finally {
    queueBusy = false;
  }
}
async function command(type, payload, metadata = {}) {
  const scope = operationScope();
  if (scope.workspace.pending().length)
    throw new Error(
      "Resolve the pending action in Sync center before starting another server action. Your other drafts can still be edited and saved online.",
    );
  const cmd = { id: uuid(), type, payload };
  const entry = scope.workspace.enqueue(cmd, metadata);
  try {
    const result = await sendEntry(entry);
    if (!scopeCurrent(scope)) throw new SessionChanged();
    return await afterConfirmation(
      result,
      () => refresh({ renderPage: false }),
      () =>
        toast(
          "Your action was confirmed. The latest workspace could not be refreshed; use Refresh workspace before making another change.",
          true,
        ),
    );
  } finally {
    if (scopeCurrent(scope)) render();
  }
}
function setView(next) {
  view = next;
  if (location.hash !== `#/${next}`) history.pushState({}, "", `#/${next}`);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  $("page-title")?.focus();
}
function persistPreferences(values) {
  ws.rememberPreferences(values);
  render();
  return command("preferences.save", {
    ...preferences(),
    ...values,
    expectedVersion: state.me.preferences?.version || 0,
  });
}
function changeStore(id) {
  storeId = id;
  resetOrderHistory();
  const prefs = preferences();
  ws.rememberPreferences({ storeId: id });
  draft = null;
  restoreActiveDraft(prefs.activeDraftIds?.[id]);
  undo = [];
  redo = [];
  render();
}
function beginDraft() {
  if (!storeId)
    throw new Error("Add or select a store before starting an order.");
  draft = saveWorkingDraft(createDraft(storeId));
  const active = { ...preferences().activeDraftIds, [storeId]: draft.id };
  ws.rememberPreferences({ activeDraftIds: active });
  undo = [];
  redo = [];
  setView("build");
}
function editDraft(change, { renderPage = true } = {}) {
  if (!draft) beginDraft();
  const previous = clone(draft);
  const next = clone(draft);
  change(next);
  let saved;
  try {
    saved = saveWorkingDraft(next);
  } catch (error) {
    if ($("draft-sync-message"))
      $("draft-sync-message").textContent =
        "Changes not saved. Retry the edit before leaving.";
    if ($("draft-sync-dot")) $("draft-sync-dot").className = "sync-dot error";
    updateDraftProtection(draft.id);
    announce("Changes not saved. Retry the edit before leaving.");
    throw error;
  }
  undo.push(previous);
  if (undo.length > 50) undo.shift();
  redo = [];
  draft = saved;
  if (renderPage) render();
  announce(draftProtection(draft.id).label);
}
function undoDraft(forward = false) {
  const source = forward ? redo : undo,
    target = forward ? undo : redo;
  if (!source.length) return;
  const next = source[source.length - 1];
  const saved = saveWorkingDraft({
    ...next,
    localRevision: draft.localRevision,
    version: draft.version,
  });
  target.push(clone(draft));
  source.pop();
  draft = saved;
  render();
}
function newDraftFromOrder(order) {
  if (!storeById(order.storeId))
    throw new Error("You no longer have access to this store.");
  changeStore(order.storeId);
  beginDraft();
  const lines = (order.lines || [])
    .filter((line) => productById(line.productId || line.itemId))
    .map((line) => ({
      id: uuid(),
      productId: line.productId || line.itemId,
      variant: line.variant || "",
      quantity: line.quantity || Number(line.qty) || 1,
      unit: line.unit || "each",
      note: line.note || "",
    }));
  editDraft((d) => {
    d.lines = lines;
    d.notes = order.notes || "";
  });
  if (lines.length !== (order.lines || []).length)
    toast(
      "Some historical items could not be matched. Review the catalog before submitting.",
      true,
    );
  setView("build");
}
async function syncDraft(target = draft) {
  const scope = operationScope();
  const controller = draftSync;
  if (!target) throw new Error("Start a draft before saving it.");
  if (draft?.id === target.id && hasUnsavedDraftNotes())
    throw new Error(
      "Your visible notes have not been saved. Copy or retry them before continuing.",
    );
  if (!controller || !navigator.onLine)
    throw new Error("Reconnect before saving this draft online.");
  let sent = clone(target);
  if (
    (sent.legacy?.requiresReview || sent.migrationBlocked) &&
    !sent.acknowledgeLegacyReview
  ) {
    if (
      !(await confirmAction(
        "Review recovered draft",
        "Check every recovered product, variant, quantity and note against the original before confirming.",
        "I reviewed this draft",
      ))
    )
      throw new Error("Review the recovered draft before continuing.");
    if (!scopeCurrent(scope)) throw new SessionChanged();
    sent = saveWorkingDraft({ ...sent, acknowledgeLegacyReview: true });
    if (draft?.id === sent.id) draft = sent;
  }
  const confirmed = await controller.flush(sent.id);
  if (!scopeCurrent(scope)) throw new SessionChanged();
  const saved = scope.workspace.getDraft(sent.id);
  if (!saved || saved.localRevision !== sent.localRevision)
    throw new Error(
      "This draft changed while saving online. Review the updated draft before submitting.",
    );
  if (!controller.status(sent.id).cloudConfirmed)
    throw new Error(
      "The latest draft has not been confirmed online yet. Retry its save before submitting.",
    );
  const result = { ...saved, version: confirmed.version };
  if (draft?.id === sent.id) draft = result;
  updateDraftProtection(sent.id);
  return result;
}

function linePrice(line, store = currentStore()) {
  const p = productById(line.productId);
  if (!p) return null;
  const override = store?.priceOverrides?.[p.id];
  const cents =
    typeof override === "number"
      ? override
      : (override?.variantPricesCents?.[line.variant] ??
        override?.priceCents ??
        p.variantPricesCents?.[line.variant] ??
        p.priceCents);
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  const pack = line.unit === "case" ? p.packSize : 1;
  if (!Number.isSafeInteger(pack) || pack <= 0) return null;
  return cents * pack;
}
function draftTotals(order = draft) {
  let subtotal = 0,
    tax = 0;
  const missing = [];
  const store = storeById(order?.storeId);
  for (const line of order?.lines || []) {
    const cents = linePrice(line, store),
      p = productById(line.productId);
    if (cents == null) {
      missing.push(p?.name || line.productId);
      continue;
    }
    const total = cents * line.quantity;
    subtotal += total;
    if (p?.taxable)
      tax += Math.round((total * (store?.taxRateBps || 0)) / 10000);
  }
  return { subtotal, tax, total: subtotal + tax, missing };
}
function balance(id) {
  return state.ledger
    .filter((entry) => entry.storeId === id)
    .reduce(
      (sum, entry) =>
        sum + (Number.isSafeInteger(entry.deltaCents) ? entry.deltaCents : 0),
      0,
    );
}
function navLink(key, label, symbol) {
  return el(
    "a",
    {
      href: `#/${key}`,
      class: view === key ? "active" : "",
      "aria-current": view === key ? "page" : null,
      onClick: (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        setView(key);
      },
    },
    icon(symbol),
    label,
  );
}
function render() {
  if (!state) return;
  const active = document.activeElement,
    activeId = active?.id,
    start = active?.selectionStart,
    end = active?.selectionEnd;
  document.documentElement.dataset.theme =
    preferences().theme === "system"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preferences().theme || "dark";
  document
    .querySelector("meta[name=theme-color]")
    ?.setAttribute(
      "content",
      document.documentElement.dataset.theme === "light"
        ? "#f5f2ec"
        : "#10151e",
    );
  const nav = [
    ["home", "Overview", "home"],
    ["catalog", "Catalog", "catalog"],
    ["build", "Build order", "cart"],
    ["orders", "Orders", "orders"],
    ["stores", "Stores", "stores"],
    ["more", "Workspace", "more"],
  ];
  const aside = el(
    "aside",
    { class: "sidebar" },
    brand(),
    el(
      "nav",
      { "aria-label": "Main navigation" },
      nav.map(([key, label, symbol]) => navLink(key, label, symbol)),
    ),
    el(
      "footer",
      {},
      el(
        "strong",
        {},
        state.me.name ||
          state.me.displayName ||
          state.me.email ||
          "Your account",
      ),
      el("div", {}, titleCase(state.me.role)),
      button("Sign out", signOut, "text-button"),
    ),
  );
  const switcher = select(
    state.stores.map((store) => [store.id, store.name]),
    storeId,
    {
      id: "store-switch",
      onChange: (event) => act(() => changeStore(event.target.value)),
    },
  );
  const notifications = iconButton("Notifications", "bell", () =>
    setView("notifications"),
  );
  if (unread())
    append(notifications, el("span", { class: "badge-count" }, unread()));
  const cart = iconButton("Open current order", "cart", () => setView("build"));
  if (draft?.lines.length)
    append(cart, el("span", { class: "badge-count" }, draft.lines.length));
  const protection = workspaceProtection();
  const pending = ws.pending().length;
  const bar = el(
    "header",
    { class: "topbar" },
    el(
      "div",
      { class: "store-switch" },
      el("label", { for: "store-switch" }, "Ordering for"),
      switcher,
    ),
    el(
      "div",
      { class: "top-actions" },
      el(
        "div",
        { class: "sync-bar" },
        el("span", {
          id: "workspace-sync-dot",
          class: `sync-dot ${protection.tone}`,
        }),
        el("span", { id: "workspace-sync-label" }, protection.label),
      ),
      iconButton("Refresh workspace", "refresh", () => refresh()),
      notifications,
      cart,
      iconButton("Toggle light or dark theme", "sun", () => {
        ws.rememberPreferences({
          theme: preferences().theme === "light" ? "dark" : "light",
        });
        render();
      }),
    ),
  );
  const main = el("main", { id: "main", class: "content" });
  const storageNotice = deviceStorageNotice();
  if (storageNotice) append(main, storageNotice);
  if (!navigator.onLine)
    append(
      main,
      notice(
        "You’re offline. Check each draft’s save status and keep this tab open if it is not yet protected. Saving online resumes when connected.",
      ),
    );
  if (pending)
    append(
      main,
      notice(
        el(
          "div",
          { class: "split" },
          el(
            "span",
            {},
            `${pending} action${pending === 1 ? " is" : "s are"} waiting for server confirmation.`,
          ),
          button("Sync center", showSyncCenter, "text-button"),
        ),
      ),
    );
  const pages = {
    home: renderHome,
    catalog: renderCatalog,
    build: renderBuilder,
    orders: renderOrders,
    stores: renderStores,
    more: renderMore,
    inventory: renderInventory,
    payments: renderPayments,
    returns: renderReturns,
    notifications: renderNotifications,
  };
  append(main, (pages[view] || renderHome)());
  const mobile = el(
    "nav",
    { class: "mobile-nav", "aria-label": "Mobile navigation" },
    nav.map(([key, label, symbol]) =>
      navLink(
        key,
        key === "more" ? "More" : key === "build" ? "Build" : label,
        symbol,
      ),
    ),
  );
  $("app").replaceChildren(
    aside,
    el("div", { class: "workspace" }, bar, main),
    mobile,
  );
  if (activeId && $(activeId)) {
    const node = $(activeId);
    node.focus({ preventScroll: true });
    try {
      if (start != null) node.setSelectionRange(start, end);
    } catch {}
  }
}
function brand() {
  return el(
    "div",
    { class: "brand" },
    el("img", {
      class: "brand-logo",
      src: "/assets/logo.png",
      alt: "Alabama Wholesale",
      width: 44,
      height: 44,
    }),
    el("div", { class: "brand-name" }, "ALABAMA", el("small", {}, "Wholesale")),
  );
}
async function signOut() {
  const scope = operationScope();
  let timeout;
  await Promise.race([
    flushWorkingDrafts(),
    new Promise((resolve) => {
      timeout = setTimeout(resolve, 6000);
    }),
  ]);
  clearTimeout(timeout);
  if (!scopeCurrent(scope)) throw new SessionChanged();
  draftProtectionCache.clear();
  let needsWarning = hasUnsavedDraftNotes(),
    unreadable = false;
  try {
    needsWarning ||= unconfirmedDrafts().length > 0 || ws?.pending().length > 0;
  } catch {
    needsWarning = true;
    unreadable = true;
  }
  if (needsWarning) {
    const leave = await new Promise((resolve) => {
      const m = modal(
        "Some work is not saved online",
        "Export a copy or keep this tab open to finish saving.",
      );
      let approved = false;
      append(
        m.content,
        notice(
          "Drafts saved only in this tab will be lost when you sign out. Drafts saved on this device remain here, but will not be available on another device until saved online.",
          true,
        ),
      );
      append(
        m.footer,
        button(
          "Export drafts",
          () =>
            unreadable
              ? exportDeviceWorkspace(scope.identity)
              : download(
                  "alabama-draft-recovery.json",
                  JSON.stringify(workspaceRecoverySnapshot(), null, 2),
                ),
          "",
          "download",
        ),
        button("Keep saving", m.close, "primary"),
        button(
          "Sign out anyway",
          () => {
            approved = true;
            m.close();
          },
          "danger",
        ),
      );
      m.dialog.addEventListener("close", () => resolve(approved), {
        once: true,
      });
    });
    if (!leave) return;
  }
  if (!scopeCurrent(scope)) throw new SessionChanged();
  await firebase.logout();
}

function renderHome() {
  const store = currentStore(),
    orders = state.orders.filter(
      (order) => order.storeId === storeId && order.status !== "draft",
    );
  const drafts = availableDrafts().filter((item) => item.storeId === storeId);
  const open = orders.filter(
    (order) => !["delivered", "cancelled", "legacy"].includes(order.status),
  );
  const pendingPayments = state.payments.filter(
    (payment) => payment.storeId === storeId && payment.status === "pending",
  );
  const low = state.inventory.filter(
    (item) =>
      Number.isFinite(item.onHand) &&
      item.onHand - (item.reserved || 0) <= (item.reorderPoint || 0),
  );
  const root = el(
    "div",
    { class: "stack" },
    heading(
      "Your wholesale workspace",
      store
        ? `${store.name} · ${date(Date.now())}`
        : "Orders, inventory and customer accounts.",
    ),
  );
  if (!store)
    return el(
      "div",
      {},
      heading(
        "Welcome to Alabama Wholesale",
        "Set up your catalog and customer stores to start ordering.",
      ),
      empty(
        "Your workspace is ready",
        "Add a store, or migrate your existing catalog and accounts.",
        [
          master()
            ? button("Set up workspace", () => setView("more"), "primary")
            : button("Refresh access", () => refresh()),
        ],
      ),
    );
  append(
    root,
    el(
      "section",
      { class: "welcome" },
      el("div", { class: "eyebrow" }, "Ready for the next delivery"),
      el(
        "h2",
        {},
        draft?.lines.length
          ? "Pick up where you left off."
          : "Keep your shelves moving.",
      ),
      el(
        "p",
        {},
        draft?.lines.length
          ? `${draft.lines.length} lines are saved in your current draft. Review quantities and pricing before submitting.`
          : "Start a fresh order, reorder your regulars, and follow every delivery from one place.",
      ),
      el(
        "div",
        { class: "actions" },
        button(
          draft?.lines.length ? "Continue current order" : "Start an order",
          () => (draft ? setView("build") : beginDraft()),
          "primary",
          "arrow",
        ),
        button("Browse catalog", () => setView("catalog"), "", "catalog"),
      ),
    ),
  );
  const metrics = [
    [
      "Account balance",
      store.migrationBlocked
        ? "Review required"
        : cash(store.balanceCents ?? balance(storeId)),
      "Verified charges, credits and payments",
      "payments",
    ],
    ["Orders in progress", open.length, "Submitted through picking", "orders"],
    ["Saved drafts", drafts.length, "Available on this device", "build"],
    staff()
      ? [
          "Stock to review",
          low.length,
          "At or below reorder point",
          "inventory",
        ]
      : [
          "Pending payments",
          pendingPayments.length,
          "Awaiting staff verification",
          "payments",
        ],
  ];
  append(
    root,
    el(
      "section",
      { class: "grid", "aria-label": "Account overview" },
      metrics.map(([label, value, note, target]) =>
        el(
          "div",
          { class: "panel" },
          el("div", { class: "metric-label" }, label),
          el("div", { class: "metric" }, value),
          el("p", { class: "metric-note" }, note),
          button("View details", () => setView(target), "text-button"),
        ),
      ),
    ),
  );
  if (store.migrationBlocked || store.reconciliationRequired)
    append(
      root,
      notice(
        el(
          "div",
          {},
          "This account’s imported balance needs owner review before new charges.",
          master()
            ? button(
                "Review opening balance",
                () => showReconcile(store),
                "text-button",
              )
            : null,
        ),
      ),
    );
  append(
    root,
    el(
      "div",
      { class: "two-column" },
      el(
        "section",
        { class: "panel" },
        el(
          "div",
          { class: "split" },
          el("h2", {}, "Recent orders"),
          button("View all", () => setView("orders"), "text-button"),
        ),
        orders.length
          ? orderList(orders.slice(0, 5))
          : empty(
              "Your first order starts here",
              "Submitted orders will appear with saved dates, invoice totals and delivery progress.",
              [button("Browse catalog", () => setView("catalog"), "primary")],
            ),
      ),
      el(
        "aside",
        { class: "panel" },
        el("h2", {}, "Your account"),
        el(
          "div",
          { class: "detail-list" },
          el(
            "div",
            {},
            el("span", {}, "Payment terms"),
            el("span", {}, store.terms || "Not set"),
          ),
          el(
            "div",
            {},
            el("span", {}, "Credit limit"),
            el(
              "span",
              {},
              store.creditLimitCents == null
                ? "Not set"
                : cash(store.creditLimitCents),
            ),
          ),
          el(
            "div",
            {},
            el("span", {}, "Phone"),
            el("span", {}, store.phone || "Not set"),
          ),
        ),
        el(
          "div",
          { class: "actions" },
          button("Report a payment", () => showPaymentReport(), "", "wallet"),
          button("Draft from a note", showAssistant, "", "spark"),
        ),
      ),
    ),
  );
  return root;
}
function orderList(orders) {
  return el(
    "div",
    { class: "activity-list" },
    orders.map((order) =>
      el(
        "div",
        { class: "activity-item" },
        el("div", { class: "activity-icon" }, icon("orders")),
        el(
          "div",
          {},
          el(
            "strong",
            {},
            order.invoiceNumber || `Order ${order.id.slice(0, 8)}`,
          ),
          el(
            "p",
            {},
            `${date(order.date || order.legacy?.date || order.createdAt)} · ${storeById(order.storeId)?.name || order.storeName || "Store"}`,
          ),
          status(order.status),
          order.paymentStatus ? status(order.paymentStatus) : null,
        ),
        el(
          "div",
          { class: "money" },
          order.totalCents != null
            ? cash(order.totalCents)
            : order.total != null
              ? cash(Math.round(order.total * 100))
              : "Draft",
        ),
        button("Open", () => showOrder(order), "subtle"),
      ),
    ),
  );
}
function renderCatalog() {
  const scope = operationScope();
  const fav =
    preferences().favorites?.[storeId] ??
    currentStore()?.favoriteProductIds ??
    [];
  const cardCache = new Map();
  const candidates = indexCatalogProducts(
    state.products.filter((product) => product.active !== false),
  );
  let layout = normalizeCatalogLayout(
    ws.preferences().catalogLayout,
    matchMedia("(max-width: 600px)").matches ? 2 : 4,
  );
  const searchField = input("search", search, {
    id: "catalog-search",
    placeholder: "Search name, flavor, SKU or barcode…",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: false,
    onInput: (event) => {
      search = event.target.value;
      drawResults();
    },
    "aria-label": "Search catalog",
  });
  const categoryField = select(
    [
      ["", "All categories"],
      ...state.categories.map((item) => [item.id, item.name]),
    ],
    category,
    {
      "aria-label": "Filter category",
      onChange: (event) => {
        category = event.target.value;
        drawResults();
      },
    },
  );
  const favoritesButton = button(
    "",
    () => {
      favoritesOnly = !favoritesOnly;
      drawResults();
    },
    "pill",
  );
  const count = el("p", { class: "small muted mb", role: "status" });
  const scanButton = button("Scan", showScanner, "", "scan");
  scanButton.setAttribute("aria-label", "Scan barcode");
  const columns = select(
    [1, 2, 3, 4, 5].map((value) => [String(value), String(value)]),
    String(layout.columns),
    {
      id: "catalog-columns",
      onChange: () => act(updateLayout),
    },
  );
  const compact = input("checkbox", "", {
    id: "catalog-compact",
    checked: layout.compact,
    onChange: () => act(updateLayout),
  });
  const results = el("div", { class: "catalog-results" });
  const root = el(
    "div",
    {
      class: "catalog-page",
      "data-compact": String(layout.compact),
      "data-columns": layout.columns,
    },
    heading("Catalog", `${candidates.length} products`, [
      master()
        ? button("Add product", () => showProductEditor(), "", "plus")
        : null,
      scanButton,
      button("Ask AI", showAssistant, "primary", "spark"),
    ]),
    el(
      "div",
      { class: "filters catalog-filters" },
      el("div", { class: "search" }, searchField),
      categoryField,
      favoritesButton,
    ),
    el(
      "div",
      { class: "catalog-view-controls" },
      count,
      el(
        "div",
        { class: "catalog-layout-controls" },
        el("label", { for: "catalog-columns" }, "Columns"),
        columns,
        el("label", { class: "check-field" }, compact, "Compact"),
      ),
    ),
    el(
      "p",
      { class: "catalog-tile-hint small" },
      "Tap a tile for the full name, options and price.",
    ),
    results,
  );
  root.style.setProperty("--catalog-columns", layout.columns);
  function updateLayout() {
    if (!scopeCurrent(scope)) throw new SessionChanged();
    layout = normalizeCatalogLayout({
      columns: columns.value,
      compact: compact.checked,
    });
    root.dataset.compact = String(layout.compact);
    root.dataset.columns = String(layout.columns);
    root.style.setProperty("--catalog-columns", layout.columns);
    scope.workspace.rememberPreferences({ catalogLayout: layout });
  }
  function drawResults() {
    const products = rankCatalogProducts(candidates, search).filter(
      (product) =>
        (!category || product.categoryIds?.includes(category)) &&
        (!favoritesOnly || fav.includes(product.id)),
    );
    favoritesButton.textContent = favoritesOnly ? "★ Favorites" : "☆ Favorites";
    favoritesButton.className = favoritesOnly ? "pill active" : "pill";
    favoritesButton.setAttribute("aria-pressed", favoritesOnly);
    count.textContent = `${products.length} matching product${products.length === 1 ? "" : "s"}`;
    if (!products.length) {
      results.replaceChildren(
        empty(
          "No matching products",
          "Try another spelling, category, or barcode.",
          [
            button("Clear filters", () => {
              search = "";
              category = "";
              favoritesOnly = false;
              searchField.value = "";
              categoryField.value = "";
              drawResults();
              searchField.focus();
            }),
          ],
          "search",
        ),
      );
      return;
    }
    const cards = products.slice(0, 120).map((product) => {
      if (!cardCache.has(product.id))
        cardCache.set(product.id, renderProductCard(product, fav));
      return cardCache.get(product.id);
    });
    results.replaceChildren(el("div", { class: "catalog-grid" }, cards));
    if (products.length > 120)
      append(
        results,
        notice(
          "Showing the first 120 matches. Narrow your search to find a specific product.",
        ),
      );
  }
  drawResults();
  return root;
}
function renderProductCard(product, fav) {
  const image = safeImage(product.image || product.imageUrl);
  const thumbnail = image
    ? el("img", {
        src: image,
        width: 180,
        height: 145,
        alt: product.name,
        loading: "lazy",
        decoding: "async",
        onError: (event) =>
          event.target.replaceWith(
            el(
              "span",
              { class: "no-image", "aria-label": "Image unavailable" },
              "AW",
            ),
          ),
      })
    : el("span", { class: "no-image", "aria-label": "No product image" }, "AW");
  const favorite = iconButton(`Favorite ${product.name}`, "star", () =>
    toggleFavorite(product.id),
  );
  favorite.className = "favorite";
  favorite.setAttribute("aria-pressed", fav.includes(product.id));
  const base = linePrice({
    productId: product.id,
    variant: "",
    unit: "each",
  });
  return el(
    "article",
    { class: "product-card", "data-product-id": product.id },
    favorite,
    el("div", { class: "product-image" }, thumbnail),
    el(
      "div",
      { class: "product-content" },
      el("h3", { class: "product-name", title: product.name }, product.name),
      el(
        "p",
        { class: "product-meta" },
        product.variants?.length
          ? `${product.variants.length} variants`
          : "Single product",
        product.packSize ? ` · ${product.packSize} per case` : "",
      ),
      el(
        "div",
        { class: "product-bottom" },
        el(
          "strong",
          { class: `product-price${base == null ? " muted" : ""}` },
          base == null ? "Choose variant / price" : `${cash(base)} / each`,
        ),
        button("Add to order", () => showAddProduct(product), "primary"),
      ),
      master()
        ? button(
            "Edit details",
            () => showProductEditor(product),
            "text-button product-edit",
          )
        : null,
    ),
    el(
      "button",
      {
        type: "button",
        class: "product-tile-open",
        "aria-label": `View ${product.name}`,
        title: product.name,
        onClick: () => act(() => showAddProduct(product)),
      },
      el("span", { class: "sr-only" }, `View ${product.name}`),
    ),
  );
}

async function toggleFavorite(id) {
  const fav = { ...preferences().favorites };
  const set = new Set(fav[storeId] ?? currentStore()?.favoriteProductIds ?? []);
  set.has(id) ? set.delete(id) : set.add(id);
  fav[storeId] = [...set];
  await persistPreferences({ favorites: fav });
}
function showAddProduct(product, initialVariant) {
  if (!storeId) throw new Error("Select a store before adding products.");
  const m = modal(
    product.name,
    "Choose a variant and quantity. Case sizes use the product’s configured pack size.",
  );
  const variants = product.variants?.length ? product.variants : [""];
  const variant = select(
    variants.map((v) => [v, v || "Standard"]),
    variants.includes(initialVariant) ? initialVariant : variants[0],
  );
  const quantity = input("number", "1", {
    min: 1,
    step: 1,
    inputmode: "numeric",
    required: true,
  });
  const unit = select(
    [
      ["each", "Each"],
      ...(Number.isSafeInteger(product.packSize) && product.packSize > 0
        ? [["case", `Case (${product.packSize} each)`]]
        : []),
    ],
    "each",
  );
  const note = el("textarea", {
    placeholder: "Packing or flavor instructions (optional)",
    maxlength: 1000,
  });
  const price = el("p", { class: "mt" });
  function updatePrice() {
    const value = linePrice({
      productId: product.id,
      variant: variant.value,
      unit: unit.value,
    });
    price.textContent =
      value == null
        ? "Price is missing. You can draft this item, but it must be priced before submission."
        : `${cash(value)} per ${unit.value} · ${cash(value * Number(quantity.value || 0))} line total`;
    const inventory = state.inventory.find(
      (item) =>
        item.productId === product.id && (item.variant || "") === variant.value,
    );
    if (inventory?.onHand != null)
      price.textContent += ` · ${inventory.onHand - (inventory.reserved || 0)} each available`;
    else price.textContent += " · Stock count not yet set";
  }
  variant.addEventListener("change", updatePrice);
  unit.addEventListener("change", updatePrice);
  quantity.addEventListener("input", updatePrice);
  updatePrice();
  append(
    m.content,
    el(
      "div",
      { class: "form-grid" },
      field("Variant", variant),
      field("Quantity", quantity),
      field("Order unit", unit),
      field("Line note", note),
    ),
    price,
    el(
      "div",
      { class: "actions" },
      button("Favorite product", () => toggleFavorite(product.id), "", "star"),
      master()
        ? button(
            "Edit product",
            () => {
              m.close();
              showProductEditor(product);
            },
            "text-button",
            "edit",
          )
        : null,
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Add to draft",
      () => {
        const count = Number(quantity.value);
        if (!Number.isSafeInteger(count) || count <= 0)
          throw new Error("Quantity must be a positive whole number.");
        editDraft((d) =>
          d.lines.push({
            id: uuid(),
            productId: product.id,
            variant: variant.value,
            quantity: count,
            unit: unit.value,
            note: note.value.trim(),
          }),
        );
        m.close();
        toast(`${product.name} added to your draft.`);
      },
      "primary",
      "plus",
    ),
  );
}
function renderBuilder() {
  const root = el(
    "div",
    {},
    heading(
      "Build an order",
      currentStore()?.name || "Select a store to begin.",
      [
        button(
          "New draft",
          async () => {
            if (
              draft?.lines.length &&
              !(await confirmAction(
                "Start a new draft?",
                "Your current draft stays in this workspace. Check its save status before closing the app.",
                "Start new",
              ))
            )
              return;
            beginDraft();
          },
          "",
          "plus",
        ),
        button(
          "Browse catalog",
          () => setView("catalog"),
          "primary",
          "catalog",
        ),
      ],
    ),
  );
  const saved = availableDrafts().filter((item) => item.storeId === storeId);
  if (!draft) {
    append(
      root,
      empty(
        "A fresh order, ready when you are",
        "Build a cart from the catalog, repeat a previous order, or turn a note into a proposed cart.",
        [
          button("Start an order", beginDraft, "primary"),
          button("Ask AI", showAssistant, "", "spark"),
        ],
        "cart",
      ),
    );
    if (saved.length) append(root, renderDraftList(saved));
    return root;
  }
  if (draft.legacy?.requiresReview || draft.migrationBlocked)
    append(
      root,
      notice(
        "Recovered draft: verify all products, variants and quantities against the original before syncing.",
      ),
    );
  const totals = draftTotals();
  const lines = el(
    "div",
    { class: "builder-lines" },
    draft.lines.map((line) => {
      const product = productById(line.productId);
      const quantity = input("number", line.quantity, {
        id: `qty-${line.id}`,
        min: 1,
        step: 1,
        "aria-label": `Quantity for ${product?.name || "product"}`,
        onInput: (event) => {
          const number = Number(event.target.value);
          if (!Number.isSafeInteger(number) || number <= 0) return;
          act(() => {
            try {
              editDraft(
                (d) => {
                  const target = d.lines.find((item) => item.id === line.id);
                  if (!target)
                    throw new Error(
                      "This item changed elsewhere. Refresh the draft before editing it.",
                    );
                  target.quantity = number;
                },
                { renderPage: false },
              );
              updateDraftProtection(draft.id);
            } catch (error) {
              event.target.value =
                draft?.lines.find((item) => item.id === line.id)?.quantity ??
                line.quantity;
              throw error;
            }
          });
        },
        onChange: (event) => {
          const number = Number(event.target.value);
          if (!Number.isSafeInteger(number) || number <= 0)
            toast(
              "Use a positive whole number. Your last valid quantity is saved.",
              true,
            );
          if (!hasUnsavedDraftNotes()) render();
        },
      });
      const units = select(
        [["each", "Each"], ...(product?.packSize ? [["case", "Case"]] : [])],
        line.unit,
        {
          "aria-label": `Unit for ${product?.name || "product"}`,
          onChange: (event) =>
            act(() => {
              try {
                editDraft((d) => {
                  d.lines.find((item) => item.id === line.id).unit =
                    event.target.value;
                });
              } catch (error) {
                event.target.value = line.unit;
                throw error;
              }
            }),
        },
      );
      const price = linePrice(line);
      return el(
        "div",
        { class: "line-card" },
        el(
          "div",
          { class: "line-title" },
          el("strong", {}, product?.name || "Product unavailable"),
          el(
            "small",
            {},
            line.variant || "Standard",
            price == null
              ? " · Price needed"
              : ` · ${cash(price)} / ${line.unit}`,
          ),
        ),
        quantity,
        units,
        iconButton(`Remove ${product?.name || "item"}`, "close", () =>
          editDraft((d) => {
            d.lines = d.lines.filter((item) => item.id !== line.id);
          }),
        ),
        line.note ? el("p", { class: "line-note small" }, line.note) : null,
      );
    }),
  );
  const note = el("textarea", {
    id: "draft-notes",
    "data-draft-id": draft.id,
    value: draft.notes || "",
    placeholder: "Delivery instructions, packing notes or substitutions…",
    maxlength: 5000,
    onInput: (event) =>
      act(() => {
        editDraft(
          (d) => {
            d.notes = event.target.value;
          },
          { renderPage: false },
        );
        updateDraftProtection(draft.id);
        draftStatus.querySelectorAll(
          "[data-draft-history] button",
        )[0].disabled = !undo.length;
        draftStatus.querySelectorAll(
          "[data-draft-history] button",
        )[1].disabled = !redo.length;
      }),
  });
  note.value = draft.notes || "";
  const draftSyncDot = el("span", {
    id: "draft-sync-dot",
    class: `sync-dot ${draftProtection(draft.id).tone}`,
  });
  const draftSyncMessage = el(
    "span",
    { id: "draft-sync-message" },
    draftProtection(draft.id).label,
  );
  const draftStatus = el(
    "div",
    { class: "split mb" },
    el(
      "div",
      { class: "sync-bar" },
      draftSyncDot,
      draftSyncMessage,
      button(
        "Save details",
        () => showDraftProtection(draft.id),
        "text-button",
      ),
    ),
    el(
      "div",
      { class: "actions", "data-draft-history": "true" },
      button("Undo", () => undoDraft(), "", null),
      button("Redo", () => undoDraft(true), "", null),
    ),
  );
  draftStatus.querySelectorAll("[data-draft-history] button")[0].disabled =
    !undo.length;
  draftStatus.querySelectorAll("[data-draft-history] button")[1].disabled =
    !redo.length;
  const summary = el(
    "aside",
    { class: "panel summary-box" },
    el("h2", {}, "Order review"),
    el(
      "p",
      { class: "small" },
      `${draft.lines.length} lines · ${currentStore()?.name || ""}`,
    ),
    totals.missing.length
      ? notice(
          `Price or case size needed for: ${[...new Set(totals.missing)].join(", ")}`,
        )
      : null,
    totalRows(totals),
    el(
      "p",
      { class: "small" },
      "Prices and availability are checked again when submitted. Submission creates the invoice charge and reserves available stock.",
    ),
    el(
      "div",
      { class: "stack mt" },
      button("Review & submit", showSubmit, "primary", "check"),
      button("Save online now", async () => {
        await syncDraft();
        toast("Draft saved online.");
      }),
      button("Copy order text", () => copyText(draftText(draft)), "subtle"),
      button(
        "Download draft",
        () =>
          download(`draft-${draft.id}.json`, JSON.stringify(draft, null, 2)),
        "subtle",
      ),
    ),
  );
  summary.querySelector("button").disabled =
    !draft.lines.length || totals.missing.length > 0;
  append(
    root,
    draftStatus,
    el(
      "div",
      { class: "two-column" },
      el(
        "section",
        { class: "stack" },
        draft.lines.length
          ? lines
          : empty(
              "Add your first product",
              "Choose products from the catalog or start with a note. Changes save online automatically when connected.",
              [
                button("Browse catalog", () => setView("catalog"), "primary"),
                button("Ask AI", showAssistant),
              ],
            ),
        el(
          "div",
          { class: "panel" },
          field("Order notes", note),
          el(
            "p",
            {
              class: "small",
              "data-draft-protection": draft.id,
              "aria-live": "polite",
            },
            draftProtection(draft.id).label,
          ),
        ),
      ),
      summary,
    ),
    saved.length > 1
      ? renderDraftList(saved.filter((item) => item.id !== draft.id))
      : null,
  );
  return root;
}
function renderDraftList(drafts) {
  return el(
    "section",
    { class: "panel mt" },
    el("h2", {}, "Your drafts"),
    el(
      "div",
      { class: "activity-list" },
      drafts.map((item) =>
        el(
          "div",
          { class: "activity-item" },
          el(
            "div",
            {},
            el(
              "strong",
              {},
              `${item.lines.length} line${item.lines.length === 1 ? "" : "s"}`,
            ),
            el(
              "p",
              { "data-draft-protection": item.id },
              draftProtection(item.id).label,
            ),
          ),
          button("Resume", () => {
            draft = ws.getDraft(item.id);
            ws.rememberPreferences({
              activeDraftIds: {
                ...preferences().activeDraftIds,
                [storeId]: draft.id,
              },
            });
            undo = [];
            redo = [];
            setView("build");
          }),
        ),
      ),
    ),
  );
}
function totalRows(totals) {
  return el(
    "div",
    { class: "totals" },
    el(
      "div",
      {},
      el("span", {}, "Subtotal"),
      el("span", {}, cash(totals.subtotal)),
    ),
    el("div", {}, el("span", {}, "Tax"), el("span", {}, cash(totals.tax))),
    el(
      "div",
      { class: "grand" },
      el("span", {}, totals.missing?.length ? "Known subtotal" : "Total"),
      el("span", {}, cash(totals.total)),
    ),
  );
}
async function showSubmit() {
  if (!draft?.lines.length) return;
  if (hasUnsavedDraftNotes())
    throw new Error(
      "Your visible notes have not been saved. Copy or retry them before reviewing this order.",
    );
  const reviewed = clone(draft);
  const totals = draftTotals(reviewed);
  if (totals.missing.length)
    throw new Error(
      "Every line needs a valid price and case size before submission.",
    );
  const m = modal(
    "Review your order",
    `${currentStore()?.name} · ${draft.lines.length} lines`,
    true,
  );
  const deviceCopy = deviceCopySettings();
  append(
    m.content,
    notice(
      "Submitting charges this account once and reserves available inventory. Review the order before continuing.",
    ),
    lineTable(draft.lines, true),
    totalRows(totals),
    draft.notes ? el("p", {}, draft.notes) : null,
    deviceCopy.element,
  );
  append(
    m.footer,
    button("Keep editing", m.close),
    button(
      "Submit order",
      async () => {
        const copyOptions = deviceCopy.value();
        if (ws.getDraft(reviewed.id)?.localRevision !== reviewed.localRevision)
          throw new Error(
            "This draft changed after the review opened. Close and review the latest version.",
          );
        const submitted = await syncDraft(reviewed);
        const id = submitted.id,
          version = submitted.version;
        const controller = draftSync;
        controller.pause(id);
        let result,
          confirmed = false;
        try {
          result = await command(
            "order.submit",
            { id, expectedVersion: version, expectedTotalCents: totals.total },
            { deviceCopy: copyOptions },
          );
          confirmed = true;
          controller.forget(id);
        } finally {
          if (!confirmed) controller.unpause(id);
        }
        m.close();
        setView("orders");
        toast("Order submitted and confirmed.");
        const order = result.order || result;
        if (order?.id) showOrder(order);
      },
      "primary",
      "check",
    ),
  );
}
function lineTable(lines, isDraft = false) {
  return table(
    ["Product / variant", "Quantity", "Unit price", "Line total"],
    lines.map((line) => {
      const p = productById(line.productId);
      const unitPrice = isDraft ? linePrice(line) : line.unitPriceCents;
      const total = isDraft
        ? unitPrice == null
          ? null
          : unitPrice * line.quantity
        : line.lineTotalCents;
      return el(
        "tr",
        {},
        td(
          el(
            "strong",
            {},
            line.name || line.productName || p?.name || line.productId,
          ),
          el("p", { class: "small" }, line.variant || "Standard"),
          line.note ? el("p", { class: "small" }, line.note) : null,
        ),
        td(`${line.quantity} ${line.unit || "each"}`),
        td(cash(unitPrice)),
        td(cash(total)),
      );
    }),
  );
}
function draftText(order) {
  return [
    `${storeById(order.storeId)?.name || "Alabama Wholesale"} — DRAFT`,
    ...order.lines.map(
      (line) =>
        `${line.quantity} ${line.unit} · ${productById(line.productId)?.name || line.productId}${line.variant ? ` / ${line.variant}` : ""}${line.note ? ` (${line.note})` : ""}`,
    ),
    order.notes || "",
  ]
    .filter(Boolean)
    .join("\n");
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard.");
  } catch {
    const m = modal("Copy order text", "Select and copy the text below.");
    const textarea = el("textarea", { readonly: true });
    textarea.value = text;
    append(m.content, textarea);
    textarea.focus();
    textarea.select();
  }
}
function renderOrders() {
  const orders = state.orders.filter(
    (order) =>
      (!storeId || order.storeId === storeId) &&
      (!orderFilter || order.status === orderFilter),
  );
  const root = el(
    "div",
    {},
    heading(
      "Orders & deliveries",
      "Track progress and keep every invoice tied to its original prices.",
      [button("New order", beginDraft, "primary", "plus")],
    ),
    el(
      "div",
      { class: "filters" },
      select(
        [
          ["", "All statuses"],
          "draft",
          "submitted",
          "approved",
          "picking",
          "delivered",
          "cancelled",
          "legacy",
        ],
        orderFilter,
        {
          "aria-label": "Filter order status",
          onChange: (event) => {
            orderFilter = event.target.value;
            resetOrderHistory();
            render();
          },
        },
      ),
    ),
  );
  if (!orders.length)
    append(
      root,
      empty(
        "No orders in this view",
        "Try another status or start your next order.",
        [button("Build an order", beginDraft, "primary")],
        "orders",
      ),
    );
  else append(root, el("section", { class: "panel" }, orderList(orders)));
  append(
    root,
    el(
      "div",
      { class: "actions mt" },
      button("Load older orders", async () => {
        const queryStoreId = storeId;
        const queryStatus = orderFilter;
        const params = new URLSearchParams();
        if (queryStoreId) params.set("storeId", queryStoreId);
        if (queryStatus) params.set("status", queryStatus);
        if (orderCursor === null) {
          toast("You’ve reached the end of this order history.");
          return;
        }
        const cursor = orderCursor;
        if (cursor) params.set("cursor", cursor);
        await orderHistoryRequests.run(
          () => api(`/api/orders?${params}`),
          (result) => {
            if (queryStoreId !== storeId || queryStatus !== orderFilter) return;
            const map = new Map(state.orders.map((order) => [order.id, order]));
            for (const order of result.orders || []) map.set(order.id, order);
            state.orders = [...map.values()];
            orderCursor = result.nextCursor || null;
            render();
            if (!result.nextCursor)
              toast("You’ve reached the end of order history.");
          },
        );
      }),
    ),
  );
  return root;
}
async function showOrder(order) {
  if (order.summary) {
    const loading = modal(
      order.invoiceNumber || "Open order",
      "Loading the saved order details…",
    );
    const read = async () => {
      loading.content.replaceChildren(
        el(
          "p",
          { role: "status" },
          "Loading saved items, prices and order history…",
        ),
      );
      loading.footer.replaceChildren(button("Cancel", loading.close));
      try {
        const complete = await loadOrderDetails(order, (id) =>
          api(`/api/orders/${encodeURIComponent(id)}`),
        );
        if (!loading.dialog.open) return;
        loading.close();
        await showOrder(complete);
      } catch (error) {
        if (!loading.dialog.open) return;
        loading.content.replaceChildren(notice(friendlyError(error), true));
        loading.footer.replaceChildren(
          button("Close", loading.close),
          button("Retry loading order", read, "primary"),
        );
      }
    };
    await read();
    return;
  }
  const store = storeById(order.storeId);
  const legacy = isHistoricalOrder(order);
  const m = modal(
    order.invoiceNumber || `Order ${order.id.slice(0, 8)}`,
    `${store?.name || order.storeName || "Store"} · ${date(order.date || order.legacy?.date || order.createdAt)}`,
    true,
  );
  const statuses = ["submitted", "approved", "picking", "delivered"];
  const index = statuses.indexOf(order.status);
  append(
    m.content,
    el(
      "div",
      { class: "split" },
      status(order.status),
      order.status !== "draft"
        ? el("span", { class: "small" }, "Saved online")
        : null,
      el(
        "strong",
        { class: "money" },
        order.totalCents != null
          ? cash(order.totalCents)
          : order.total != null
            ? cash(Math.round(order.total * 100))
            : "Draft",
      ),
    ),
  );
  if (
    !legacy &&
    orderDocumentOptions(order).some(([kind]) => kind === "invoice")
  )
    append(
      m.content,
      orderCopyPanel(order),
      button("Send / schedule email", () => showOrderEmail(order), "", "bell"),
    );
  if (!legacy && order.status !== "draft" && order.status !== "cancelled")
    append(
      m.content,
      el(
        "div",
        { class: "progress-steps" },
        statuses.map((s, i) =>
          el(
            "div",
            {
              class: `progress-step${i < index ? " done" : i === index ? " current" : ""}`,
            },
            titleCase(s),
          ),
        ),
      ),
    );
  if (legacy)
    append(
      m.content,
      notice(
        "Imported historical order. Original dates, totals and text are preserved. Missing price snapshots are not rebuilt using today’s prices.",
      ),
    );
  if (order.lines?.length)
    append(m.content, lineTable(order.lines, order.status === "draft"));
  if (order.totalCents != null)
    append(
      m.content,
      totalRows({
        subtotal: order.subtotalCents ?? order.totalCents,
        tax: order.taxCents ?? 0,
        total: order.totalCents,
      }),
    );
  if (order.notes)
    append(
      m.content,
      el("h3", { class: "mt" }, "Order notes"),
      el("p", { class: "mb" }, order.notes),
    );
  if (order.orderText || order.billText)
    append(
      m.content,
      el(
        "details",
        { class: "mt" },
        el("summary", {}, "Original saved order text"),
        el("pre", { class: "history-note" }, order.billText || order.orderText),
      ),
    );
  if (order.inventoryWarnings?.length || order.stockWarnings?.length)
    append(
      m.content,
      notice(
        "Some products had unknown stock counts when this order was submitted. Staff must confirm availability before delivery.",
      ),
    );
  if (!legacy && order.paymentStatus)
    append(
      m.content,
      el(
        "div",
        { class: "panel mt" },
        el(
          "div",
          { class: "split" },
          el("h3", {}, "Payment status"),
          status(order.paymentStatus),
        ),
        el(
          "div",
          { class: "detail-list" },
          el(
            "div",
            {},
            el("span", {}, "Allocated payments"),
            el("span", {}, cash(order.paidCents || 0)),
          ),
          el(
            "div",
            {},
            el("span", {}, "Return credits"),
            el("span", {}, cash(order.creditedCents || 0)),
          ),
          el(
            "div",
            {},
            el("span", {}, "Amount due"),
            el("span", {}, cash(order.amountDueCents || 0)),
          ),
        ),
      ),
    );
  const history = order.statusHistory || order.history || [];
  if (history.length)
    append(
      m.content,
      el("h3", { class: "mt" }, "Status history"),
      el(
        "div",
        { class: "activity-list" },
        history.map((item) =>
          el(
            "div",
            { class: "activity-item" },
            el(
              "div",
              {},
              el("strong", {}, titleCase(item.status || item.type)),
              el(
                "p",
                {},
                date(item.at || item.createdAt),
                item.note ? ` · ${item.note}` : "",
              ),
            ),
          ),
        ),
      ),
    );
  const docs = el("div", { class: "actions mt" });
  for (const [kind, label] of orderDocumentOptions(order))
    append(
      docs,
      button(
        label,
        async () => {
          const scope = operationScope();
          const blob = await orderPdfBlob(order, kind, scope);
          if (!scopeCurrent(scope)) throw new SessionChanged();
          download(`${order.invoiceNumber || order.id}-${kind}.pdf`, blob);
        },
        "",
        "download",
      ),
    );
  if (order.status !== "draft") append(m.content, docs);
  append(
    m.footer,
    button(
      "Reorder",
      () => {
        newDraftFromOrder(order);
        m.close();
      },
      "",
      "cart",
    ),
  );
  if (order.status === "draft")
    append(
      m.footer,
      button(
        "Edit draft",
        () => {
          draft = ws.getDraft(order.id);
          changeStore(order.storeId);
          draft = ws.getDraft(order.id);
          ws.rememberPreferences({
            activeDraftIds: {
              ...preferences().activeDraftIds,
              [storeId]: order.id,
            },
          });
          m.close();
          setView("build");
        },
        "primary",
      ),
    );
  if (staff() && ["submitted", "approved", "picking"].includes(order.status)) {
    const next = {
      submitted: "approved",
      approved: "picking",
      picking: "delivered",
    }[order.status];
    append(
      m.footer,
      button(
        `Mark ${next}`,
        async () => {
          if (
            next === "delivered" &&
            !(await confirmAction(
              "Confirm delivery",
              "This confirms delivery and consumes the reserved inventory.",
              "Confirm delivered",
            ))
          )
            return;
          await command("order.transition", {
            id: order.id,
            status: next,
            expectedVersion: order.version,
          });
          m.close();
          toast(`Order marked ${next}.`);
        },
        "primary",
      ),
    );
  }
  if (order.status === "delivered")
    append(
      m.footer,
      button(
        "Request return",
        () => {
          m.close();
          showReturn(order);
        },
        "",
        "return",
      ),
    );
  if (["submitted", "approved", "picking"].includes(order.status) && staff())
    append(
      m.footer,
      button(
        "Cancel order",
        async () => {
          if (
            !(await confirmAction(
              "Cancel this order?",
              "The invoice charge will be reversed and reserved stock released.",
              "Cancel order",
            ))
          )
            return;
          await command("order.transition", {
            id: order.id,
            status: "cancelled",
            expectedVersion: order.version,
          });
          m.close();
          toast("Order cancelled and charge reversed.");
        },
        "danger",
      ),
    );
}

function renderStores() {
  const root = el(
    "div",
    {},
    heading(
      "Customer stores",
      "Keep contacts, pricing and account terms connected to the right store.",
      [
        master()
          ? button("Add store", () => showStoreEditor(), "primary", "plus")
          : null,
      ],
    ),
  );
  if (!state.stores.length)
    return el(
      "div",
      {},
      root,
      empty(
        "No stores assigned",
        "Your workspace owner can add a store or grant access to an existing account.",
        master()
          ? [button("Add store", () => showStoreEditor(), "primary")]
          : [],
        "stores",
      ),
    );
  append(
    root,
    el(
      "div",
      { class: "grid store-grid" },
      state.stores.map((store) =>
        el(
          "article",
          { class: "panel" },
          el(
            "div",
            { class: "split" },
            el("h2", {}, store.name),
            store.id === storeId ? status("active") : null,
          ),
          el("p", {}, store.address || "Address not set"),
          el(
            "p",
            { class: "small" },
            [store.county, store.phone].filter(Boolean).join(" · "),
          ),
          el(
            "div",
            { class: "metric" },
            store.migrationBlocked
              ? "Review required"
              : cash(store.balanceCents ?? balance(store.id)),
          ),
          el("p", { class: "metric-note" }, "Account balance"),
          el(
            "div",
            { class: "actions" },
            button(
              "Select store",
              () => {
                changeStore(store.id);
                setView("home");
              },
              store.id === storeId ? "subtle" : "primary",
            ),
            button("Details", () => showStore(store)),
            master()
              ? button("Edit", () => showStoreEditor(store), "subtle")
              : null,
          ),
        ),
      ),
    ),
  );
  return root;
}
function showStore(store) {
  const m = modal(store.name, "Customer account details");
  const salesman =
    state.users.find(
      (user) => user.uid === store.salesmanId || user.id === store.salesmanId,
    ) || state.legacyProfiles?.find((user) => user.id === store.salesmanId);
  append(
    m.content,
    el(
      "div",
      { class: "detail-list" },
      [
        ["Contact", store.contact],
        ["Phone", store.phone],
        ["Email", store.email],
        ["Address", store.address],
        ["County", store.county],
        [
          "Assigned salesperson",
          store.assignedSalesman?.name ||
            salesman?.displayName ||
            salesman?.name ||
            salesman?.username ||
            store.salesmanInfo?.name,
        ],
        [
          "Salesperson phone",
          store.assignedSalesman?.phone ||
            salesman?.phone ||
            salesman?.salesmanInfo?.phone,
        ],
        ["Salesperson email", store.assignedSalesman?.email || salesman?.email],
        ["Payment terms", store.terms],
        ["Tax rate", `${(store.taxRateBps || 0) / 100}%`],
        [
          "Credit limit",
          store.creditLimitCents == null
            ? "Not set"
            : cash(store.creditLimitCents),
        ],
        [
          "Account balance",
          store.migrationBlocked
            ? "Review required"
            : cash(store.balanceCents ?? balance(store.id)),
        ],
      ].map(([label, value]) =>
        el(
          "div",
          {},
          el("span", {}, label),
          el("span", {}, value || "Not set"),
        ),
      ),
    ),
  );
  if (store.notes) append(m.content, el("p", { class: "mt" }, store.notes));
  append(
    m.footer,
    button(
      "View account",
      () => {
        changeStore(store.id);
        m.close();
        setView("payments");
      },
      "primary",
    ),
    master()
      ? button("Customer pricing", () => {
          m.close();
          showPricing(store);
        })
      : null,
    master()
      ? button("Edit store", () => {
          m.close();
          showStoreEditor(store);
        })
      : null,
  );
}
function numberCents(value, label, { nullable = false } = {}) {
  if (value.trim() === "" && nullable) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim()))
    throw new Error(
      `${label} must be a nonnegative amount with at most two decimal places.`,
    );
  const amount = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} is too large.`);
  return amount;
}
function showStoreEditor(store = {}) {
  const m = modal(
    store.id ? "Edit store" : "Add store",
    "Use this store’s own contact details and account terms.",
    true,
  );
  const fields = {
    name: input("text", store.name || "", { required: true, maxlength: 180 }),
    contact: input("text", store.contact || "", { maxlength: 180 }),
    phone: input("tel", store.phone || "", {
      autocomplete: "tel",
      maxlength: 80,
    }),
    email: input("email", store.email || "", {
      autocomplete: "email",
      maxlength: 254,
    }),
    address: el("textarea", { maxlength: 1500 }),
    county: input("text", store.county || "", { maxlength: 100 }),
    terms: input("text", store.terms || "", {
      placeholder: "e.g. Net 15, Due on delivery",
      maxlength: 120,
    }),
    credit: input(
      "number",
      store.creditLimitCents == null ? "" : store.creditLimitCents / 100,
      { min: 0, step: ".01", placeholder: "Not set" },
    ),
    tax: input("number", (store.taxRateBps || 0) / 100, {
      min: 0,
      max: 100,
      step: ".01",
    }),
    salesman: select(
      [
        ["", "Unassigned"],
        ...state.users
          .filter((user) => ["master", "salesman"].includes(user.role))
          .map((user) => [
            user.uid || user.id,
            user.name || user.displayName || user.email,
          ]),
      ],
      store.salesmanId || "",
    ),
  };
  if (
    store.salesmanId &&
    !state.users.some((user) => (user.uid || user.id) === store.salesmanId)
  ) {
    append(
      fields.salesman,
      el(
        "option",
        { value: store.salesmanId },
        store.assignedSalesman?.name ||
          state.legacyProfiles?.find(
            (profile) => profile.id === store.salesmanId,
          )?.username ||
          "Current assigned salesperson",
      ),
    );
    fields.salesman.value = store.salesmanId;
  }
  fields.address.value = store.address || "";
  append(
    m.content,
    el(
      "div",
      { class: "form-grid" },
      field("Store name", fields.name),
      field("Contact name", fields.contact),
      field("Phone", fields.phone),
      field("Email", fields.email),
      field("Delivery address", fields.address),
      field("County", fields.county),
      field("Payment terms", fields.terms),
      field(
        "Credit limit ($)",
        fields.credit,
        "Leave blank if no limit has been set. Zero is a real zero limit.",
      ),
      field("Sales tax (%)", fields.tax),
      field("Assigned salesperson", fields.salesman),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save store",
      async () => {
        if (!fields.name.value.trim())
          throw new Error("Store name is required.");
        if (fields.email.value && !fields.email.checkValidity())
          throw new Error("Enter a valid store email address.");
        const tax = Number(fields.tax.value);
        if (!Number.isFinite(tax) || tax < 0 || tax > 100)
          throw new Error("Tax rate must be between 0 and 100.");
        await command("store.save", {
          ...store,
          id: store.id || uuid(),
          name: fields.name.value.trim(),
          contact: fields.contact.value.trim(),
          phone: fields.phone.value.trim(),
          email: fields.email.value.trim(),
          address: fields.address.value.trim(),
          county: fields.county.value.trim(),
          terms: fields.terms.value.trim(),
          creditLimitCents: numberCents(fields.credit.value, "Credit limit", {
            nullable: true,
          }),
          taxRateBps: Math.round(tax * 100),
          salesmanId: fields.salesman.value || null,
          expectedVersion: store.version || 0,
        });
        m.close();
        toast("Store saved.");
      },
      "primary",
    ),
  );
}
function showPricing(store) {
  const m = modal("Customer pricing", store.name, true);
  let selected = state.products[0]?.id || "";
  const product = select(
    state.products.map((p) => [p.id, p.name]),
    selected,
  );
  const content = el("div", { class: "mt" });
  let base, variants;
  function renderPrices() {
    const p = productById(product.value);
    content.replaceChildren();
    if (!p) return;
    const current = store.priceOverrides?.[p.id];
    base = input(
      "number",
      typeof current === "number"
        ? current / 100
        : current?.priceCents == null
          ? ""
          : current.priceCents / 100,
      { min: 0, step: ".01", placeholder: "Catalog price" },
    );
    variants = new Map(
      (p.variants || []).map((v) => [
        v,
        input(
          "number",
          current?.variantPricesCents?.[v] == null
            ? ""
            : current.variantPricesCents[v] / 100,
          { min: 0, step: ".01", placeholder: "Standard price" },
        ),
      ]),
    );
    append(
      content,
      field(
        "Customer base price per each ($)",
        base,
        "Blank uses the catalog price. Variant overrides take priority.",
      ),
      el(
        "div",
        { class: "editor-rows mt" },
        [...variants].map(([name, node]) => field(`${name} ($ / each)`, node)),
      ),
    );
  }
  product.addEventListener("change", renderPrices);
  renderPrices();
  append(m.content, field("Product", product), content);
  append(
    m.footer,
    button("Close", m.close),
    button(
      "Save customer price",
      async () => {
        if (!product.value) throw new Error("Add a product first.");
        const priceOverrides = clone(store.priceOverrides || {});
        const priceCents = numberCents(base.value, "Base price", {
          nullable: true,
        });
        const variantPricesCents = {};
        for (const [name, node] of variants) {
          const cents = numberCents(node.value, `${name} price`, {
            nullable: true,
          });
          if (cents != null) variantPricesCents[name] = cents;
        }
        if (priceCents == null && !Object.keys(variantPricesCents).length)
          delete priceOverrides[product.value];
        else
          priceOverrides[product.value] = {
            ...(priceCents == null ? {} : { priceCents }),
            variantPricesCents,
          };
        await command("store.save", {
          ...store,
          priceOverrides,
          expectedVersion: store.version,
        });
        m.close();
        toast("Customer pricing saved.");
      },
      "primary",
    ),
  );
}
function showProductEditor(product = {}) {
  const fileScope = operationScope();
  const m = modal(
    product.id ? "Edit product" : "Add product",
    "Prices are per individual unit. Case prices use the configured units per case.",
    true,
  );
  const name = input("text", product.name || "", {
    required: true,
    maxlength: 180,
  });
  const sku = input("text", product.sku || product.id || "", {
    maxlength: 100,
  });
  const price = input(
    "number",
    product.priceCents == null ? "" : product.priceCents / 100,
    { min: 0, step: ".01", placeholder: "Unknown" },
  );
  const pack = input("number", product.packSize || "", {
    min: 1,
    step: 1,
    placeholder: "Not set",
  });
  const barcode = input("text", product.barcode || "", {
    inputmode: "numeric",
    maxlength: 100,
  });
  const variants = el("textarea", {
    placeholder: "One variant per line",
    maxlength: 10000,
  });
  variants.value = (product.variants || []).join("\n");
  const taxable = input("checkbox", "", { checked: !!product.taxable });
  const statusField = select(
    ["active", "low", "out", "discontinued"],
    product.stockStatus || "active",
  );
  const image = input(
    "url",
    safeImage(product.image || product.imageUrl) || "",
    { placeholder: "https://… or /assets/…", maxlength: 2048 },
  );
  const upload = input("file", "", {
    accept: "image/jpeg,image/png,image/webp",
    class: "file-input",
  });
  const categories = el(
    "div",
    { class: "pill-group" },
    state.categories.map((cat) => {
      const checkbox = input("checkbox", cat.id, {
        checked: product.categoryIds?.includes(cat.id),
      });
      return el("label", { class: "check-field" }, checkbox, cat.name);
    }),
  );
  const variantPricing = el("div", { class: "editor-rows" });
  const variantInputs = new Map();
  for (const variant of product.variants || []) {
    const priceNode = input(
      "number",
      product.variantPricesCents?.[variant] == null
        ? ""
        : product.variantPricesCents[variant] / 100,
      { min: 0, step: ".01", placeholder: "Base price" },
    );
    const code = input("text", product.variantBarcodes?.[variant] || "", {
      maxlength: 100,
      placeholder: "Variant barcode",
    });
    variantInputs.set(variant, { price: priceNode, barcode: code });
    append(
      variantPricing,
      el(
        "div",
        { class: "form-grid" },
        field(`${variant} price ($ / each)`, priceNode),
        field(`${variant} barcode`, code),
      ),
    );
  }
  append(
    m.content,
    el(
      "div",
      { class: "form-grid" },
      field("Product name", name),
      field("SKU", sku),
      field("Base price ($ / each)", price),
      field("Units per case", pack),
      field("Barcode", barcode),
      field("Availability label", statusField),
      field(
        "Variants",
        variants,
        "New variants can be priced individually after saving.",
      ),
      field("Product image URL", image),
      field(
        "Upload product photo",
        upload,
        "JPEG, PNG or WebP, up to 5 MB. The photo is uploaded when you save.",
      ),
    ),
    el("div", { class: "mt" }, el("label", {}, "Categories"), categories),
    el("label", { class: "check-field mt" }, taxable, "Taxable product"),
    variantInputs.size
      ? el(
          "details",
          { class: "mt" },
          el("summary", {}, "Variant prices and barcodes"),
          el("div", { class: "mt" }, variantPricing),
        )
      : null,
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save product",
      async () => {
        if (!name.value.trim()) throw new Error("Product name is required.");
        const packSize = pack.value === "" ? null : Number(pack.value);
        if (
          packSize != null &&
          (!Number.isSafeInteger(packSize) || packSize < 1)
        )
          throw new Error("Units per case must be a positive whole number.");
        const variantNames = [
          ...new Set(
            variants.value
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ];
        const variantPricesCents = {},
          variantBarcodes = {};
        for (const variant of variantNames) {
          const existing = variantInputs.get(variant);
          if (existing) {
            const cents = numberCents(
              existing.price.value,
              `${variant} price`,
              { nullable: true },
            );
            if (cents != null) variantPricesCents[variant] = cents;
            if (existing.barcode.value.trim())
              variantBarcodes[variant] = existing.barcode.value.trim();
          }
        }
        if (image.value && !safeImage(image.value))
          throw new Error(
            "Use an HTTPS image URL or an existing product image path.",
          );
        let imageUrl = image.value.trim() || null;
        if (upload.files[0]) {
          const imageData = await readImageFile(upload.files[0]);
          if (!scopeCurrent(fileScope)) throw new SessionChanged();
          const uploaded = await api("/api/assets/upload", {
            method: "POST",
            body: { image: imageData },
          });
          imageUrl = uploaded.url;
        }
        await command("product.save", {
          ...product,
          id: product.id || uuid(),
          name: name.value.trim(),
          sku: sku.value.trim(),
          priceCents: numberCents(price.value, "Product price", {
            nullable: true,
          }),
          packSize,
          barcode: barcode.value.trim(),
          variants: variantNames,
          variantPricesCents,
          variantBarcodes,
          categoryIds: [...categories.querySelectorAll("input:checked")].map(
            (node) => node.value,
          ),
          taxable: taxable.checked,
          stockStatus: statusField.value,
          image: imageUrl,
          expectedVersion: product.version || 0,
        });
        m.close();
        toast("Product saved.");
      },
      "primary",
    ),
  );
}
function renderInventory() {
  if (!staff())
    return empty(
      "Staff access required",
      "Inventory adjustments are available to authorized staff.",
    );
  const inventoryByVariant = new Map(
    state.inventory.map((item) => [
      JSON.stringify([item.productId, item.variant || ""]),
      item,
    ]),
  );
  const candidates = state.products.flatMap((product) =>
    (product.variants?.length ? product.variants : [""]).map((variant) => ({
      product,
      variant,
      key: JSON.stringify([product.id, variant]),
      inventory: inventoryByVariant.get(JSON.stringify([product.id, variant])),
      terms: [
        product.name,
        product.sku,
        product.barcode,
        product.variantBarcodes?.[variant],
        variant,
      ].map((value) => String(value || "").toLowerCase()),
    })),
  );
  const rowCache = new Map();
  const searchNode = input("search", search, {
    id: "inventory-search",
    placeholder: "Search name, variant, SKU or barcode",
    "aria-label": "Search inventory",
    onInput: (event) => {
      search = event.target.value;
      drawResults();
    },
  });
  const resultTable = table(
    ["Product / variant", "On hand", "Reserved", "Available", "Reorder at", ""],
    [],
  );
  const count = el("p", { class: "small muted mb", role: "status" });
  const root = el(
    "div",
    {},
    heading(
      "Inventory",
      "Track individual units, reservations and reorder levels. Unknown counts stay unknown.",
      [button("Scan barcode", showScanner, "", "scan")],
    ),
    el("div", { class: "filters" }, el("div", { class: "search" }, searchNode)),
    count,
    resultTable,
  );
  function drawResults() {
    const query = search.trim().toLowerCase();
    const records = candidates.filter(
      ({ terms }) => !query || terms.some((value) => value.includes(query)),
    );
    const rows = records
      .slice(0, 150)
      .map(({ key, product, variant, inventory }) => {
        if (!rowCache.has(key))
          rowCache.set(key, renderInventoryRow(product, variant, inventory));
        return rowCache.get(key);
      });
    resultTable.querySelector("tbody").replaceChildren(...rows);
    count.textContent =
      records.length > 150
        ? `Showing 150 of ${records.length} matches. Use search to narrow the inventory list.`
        : `${records.length} matching inventory records`;
  }
  drawResults();
  return root;
}
function renderInventoryRow(product, variant, inventory) {
  return el(
    "tr",
    {},
    td(
      el("strong", {}, product.name),
      el("p", { class: "small" }, variant || "Standard"),
      el(
        "p",
        { class: "small" },
        product.variantBarcodes?.[variant] ||
          product.barcode ||
          product.sku ||
          "",
      ),
    ),
    td(inventory?.onHand ?? "Unknown"),
    td(inventory?.reserved ?? 0),
    td(
      inventory?.onHand == null
        ? "Unknown"
        : inventory.onHand - (inventory.reserved || 0),
    ),
    td(inventory?.reorderPoint ?? "Not set"),
    td(
      button("Adjust", () =>
        showInventoryAdjustment(product, variant, inventory),
      ),
    ),
  );
}

function showInventoryAdjustment(product, variant, inventory = {}) {
  const m = modal(
    "Adjust inventory",
    `${product.name}${variant ? ` / ${variant}` : ""} · Counts are individual units.`,
  );
  const onHand = input("number", inventory.onHand ?? "", {
    min: inventory.reserved || 0,
    step: 1,
    placeholder: "Count required",
  });
  const threshold = input("number", inventory.reorderPoint ?? "", {
    min: 0,
    step: 1,
    placeholder: "Not set",
  });
  const reason = el("textarea", {
    placeholder: "e.g. Receiving shipment, physical stock count",
    maxlength: 1000,
    required: true,
  });
  append(
    m.content,
    notice(
      `${inventory.reserved || 0} units are reserved for open orders. On-hand stock cannot go below reserved stock.`,
    ),
    el(
      "div",
      { class: "form-grid" },
      field("Physical units on hand", onHand),
      field("Reorder threshold", threshold),
    ),
    el("div", { class: "mt" }, field("Reason for adjustment", reason)),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save stock count",
      async () => {
        const count = Number(onHand.value),
          reorderPoint =
            threshold.value === "" ? null : Number(threshold.value);
        if (onHand.value === "" || !Number.isSafeInteger(count) || count < 0)
          throw new Error("Enter a nonnegative whole-number stock count.");
        if (
          reorderPoint != null &&
          (!Number.isSafeInteger(reorderPoint) || reorderPoint < 0)
        )
          throw new Error(
            "Reorder threshold must be a nonnegative whole number.",
          );
        if (!reason.value.trim())
          throw new Error("Add a reason so this adjustment can be audited.");
        await command("inventory.adjust", {
          productId: product.id,
          variant,
          onHand: count,
          reorderPoint,
          reason: reason.value.trim(),
          expectedVersion: inventory.version || 0,
        });
        m.close();
        toast("Inventory adjustment confirmed.");
      },
      "primary",
    ),
  );
}

function renderPayments() {
  const store = currentStore();
  const payments = state.payments.filter(
    (payment) => payment.storeId === storeId,
  );
  const ledger = state.ledger
    .filter((entry) => entry.storeId === storeId)
    .sort(
      (a, b) => (b.createdAt || b.date || 0) - (a.createdAt || a.date || 0),
    );
  const root = el(
    "div",
    { class: "stack" },
    heading(
      "Account & payments",
      "Reported payments are credited only after a staff member verifies receipt.",
      [button("Report payment", () => showPaymentReport(), "primary", "plus")],
    ),
  );
  append(
    root,
    el(
      "section",
      { class: "grid" },
      el(
        "div",
        { class: "panel" },
        el("p", { class: "metric-label" }, "Current balance"),
        el(
          "div",
          { class: "metric" },
          store?.migrationBlocked
            ? "Review required"
            : cash(store?.balanceCents ?? balance(storeId)),
        ),
        el(
          "p",
          { class: "metric-note" },
          store?.migrationBlocked
            ? "Imported entries need owner reconciliation"
            : "A payment reduces the amount owed",
        ),
      ),
      el(
        "div",
        { class: "panel" },
        el("p", { class: "metric-label" }, "Awaiting verification"),
        el(
          "div",
          { class: "metric" },
          cash(
            payments
              .filter((payment) => payment.status === "pending")
              .reduce((sum, payment) => sum + payment.amountCents, 0),
          ),
        ),
        el(
          "p",
          { class: "metric-note" },
          "These reports do not change the balance yet",
        ),
      ),
    ),
  );
  if (store?.migrationBlocked)
    append(
      root,
      notice(
        el(
          "div",
          {},
          "This imported account needs a verified opening balance.",
          master()
            ? button(
                "Reconcile opening balance",
                () => showReconcile(store),
                "text-button",
              )
            : null,
        ),
      ),
    );
  append(
    root,
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Payment reports"),
      payments.length
        ? table(
            ["Reported", "Amount", "Method / reference", "Status", ""],
            payments.map((payment) =>
              el(
                "tr",
                {},
                td(date(payment.reportedAt || payment.createdAt)),
                td(cash(payment.amountCents)),
                td(
                  titleCase(payment.method),
                  el(
                    "p",
                    { class: "small" },
                    payment.reference || payment.note || "",
                  ),
                ),
                td(status(payment.status)),
                td(
                  staff() && payment.status === "pending"
                    ? button(
                        "Verify received",
                        async () => {
                          if (
                            !(await confirmAction(
                              "Verify this payment?",
                              `${cash(payment.amountCents)} will be credited to ${store?.name}. Confirm that the money was received.`,
                              "Confirm received",
                            ))
                          )
                            return;
                          await command("payment.verify", {
                            paymentId: payment.id,
                            expectedVersion: payment.version,
                          });
                          toast("Payment verified and credited.");
                        },
                        "primary",
                      )
                    : staff() && payment.status === "verified"
                      ? button("Allocate to invoices", () =>
                          showAllocation(payment),
                        )
                      : null,
                ),
              ),
            ),
          )
        : el("p", {}, "No payments have been reported."),
    ),
    el(
      "section",
      { class: "panel" },
      el("h2", {}, "Account activity"),
      ledger.length
        ? table(
            ["Date", "Activity", "Reference", "Change"],
            ledger.map((entry) =>
              el(
                "tr",
                {},
                td(date(entry.createdAt || entry.date)),
                td(titleCase(entry.type)),
                td(entry.note || entry.referenceId || entry.id),
                td(
                  el(
                    "span",
                    { class: `money ${entry.deltaCents < 0 ? "success" : ""}` },
                    entry.deltaCents > 0
                      ? `+${cash(entry.deltaCents)}`
                      : cash(entry.deltaCents),
                  ),
                ),
              ),
            ),
          )
        : el(
            "p",
            {},
            "Confirmed invoice charges, payments and credits will appear here.",
          ),
    ),
  );
  return root;
}
function showPaymentReport() {
  if (!storeId) throw new Error("Select a store first.");
  const m = modal("Report a payment", currentStore()?.name || "");
  const amount = input("number", "", {
    min: ".01",
    step: ".01",
    inputmode: "decimal",
    required: true,
  });
  const method = select(
    ["cash", "check", "bank transfer", "card", "other"],
    "cash",
  );
  const invoice = select(
    [
      ["", "Account payment — no invoice selected"],
      ...state.orders
        .filter(
          (order) =>
            order.storeId === storeId &&
            order.invoiceNumber &&
            order.status !== "cancelled" &&
            !order.legacy?.needsPriceReview,
        )
        .map((order) => [
          order.id,
          `${order.invoiceNumber} · ${order.amountDueCents == null ? "Due not yet calculated" : cash(order.amountDueCents) + " due"}`,
        ]),
    ],
    "",
  );
  const reference = input("text", "", {
    maxlength: 500,
    placeholder: "Check number or transfer reference",
  });
  const note = el("textarea", {
    maxlength: 2000,
    placeholder: "Optional payment details",
  });
  append(
    m.content,
    notice(
      "This is a payment report, not an online payment. Staff will verify receipt before the account is credited.",
    ),
    el(
      "div",
      { class: "form-grid" },
      field("Amount received / sent ($)", amount),
      field("Payment method", method),
      field("Apply toward invoice", invoice),
      field("Reference", reference),
      field("Note", note),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Submit payment report",
      async () => {
        const amountCents = numberCents(amount.value, "Payment amount");
        if (amountCents <= 0)
          throw new Error("Payment amount must be greater than zero.");
        await command("payment.report", {
          storeId,
          amountCents,
          method: method.value,
          ...(invoice.value ? { orderId: invoice.value } : {}),
          reference: reference.value.trim(),
          note: note.value.trim(),
        });
        m.close();
        toast("Payment report saved. It is awaiting verification.");
      },
      "primary",
    ),
  );
}
function renderReturns() {
  const returns = state.returns.filter((item) => item.storeId === storeId);
  const root = el(
    "div",
    {},
    heading(
      "Returns & credits",
      "Request returns against delivered quantities. Staff approval creates the credit memo.",
      [
        button(
          "Choose delivered order",
          () => {
            orderFilter = "delivered";
            resetOrderHistory();
            setView("orders");
          },
          "primary",
          "orders",
        ),
      ],
    ),
  );
  if (!returns.length)
    return el(
      "div",
      {},
      root,
      empty(
        "No returns for this store",
        "Open a delivered order to select items and request a return.",
        [
          button("View delivered orders", () => {
            orderFilter = "delivered";
            resetOrderHistory();
            setView("orders");
          }),
        ],
        "return",
      ),
    );
  append(
    root,
    el(
      "div",
      { class: "stack" },
      returns.map((item) =>
        el(
          "section",
          { class: "panel" },
          el(
            "div",
            { class: "split" },
            el(
              "h2",
              {},
              item.creditMemoNumber ||
                item.invoiceNumber ||
                `Return ${item.id.slice(0, 8)}`,
            ),
            status(item.status),
          ),
          el("p", {}, `${date(item.createdAt)} · ${item.reason}`),
          el("div", { class: "metric" }, cash(item.totalCents)),
          el(
            "div",
            { class: "actions" },
            button("View return", () => showReturnDetails(item)),
            staff() && item.status === "pending"
              ? button(
                  "Review & approve",
                  () => showReturnDetails(item),
                  "primary",
                )
              : null,
          ),
        ),
      ),
    ),
  );
  return root;
}
function showReturn(order) {
  const m = modal(
    "Request a return",
    `${order.invoiceNumber} · Return quantities use the same units as the delivered order.`,
    true,
  );
  const rows = [];
  for (const line of order.lines) {
    const returned = state.returns
      .filter(
        (r) =>
          r.orderId === order.id && ["pending", "approved"].includes(r.status),
      )
      .reduce(
        (sum, r) =>
          sum +
          (r.lines || [])
            .filter((l) => l.lineId === line.id)
            .reduce((s, l) => s + l.quantity, 0),
        0,
      );
    const remaining = Math.max(0, line.quantity - returned);
    const quantity = input("number", "0", {
      min: 0,
      max: remaining,
      step: 1,
      "aria-label": `Return quantity for ${line.name}`,
      disabled: !remaining,
    });
    rows.push({ line, quantity, remaining });
  }
  const reason = el("textarea", {
    required: true,
    maxlength: 2000,
    placeholder: "Describe the issue and which products were returned.",
  });
  append(
    m.content,
    table(
      ["Product", "Available to return", "Return quantity"],
      rows.map(({ line, quantity, remaining }) =>
        el(
          "tr",
          {},
          td(
            el("strong", {}, line.name),
            el("p", { class: "small" }, line.variant || "Standard"),
          ),
          td(`${remaining} ${line.unit}`),
          td(quantity),
        ),
      ),
    ),
    el("div", { class: "mt" }, field("Reason for return", reason)),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Request return",
      async () => {
        const lines = [];
        for (const row of rows) {
          const count = Number(row.quantity.value);
          if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            count > row.remaining
          )
            throw new Error(
              `Return quantity for ${row.line.name} must be between 0 and ${row.remaining}.`,
            );
          if (count) lines.push({ lineId: row.line.id, quantity: count });
        }
        if (!lines.length)
          throw new Error("Select at least one item to return.");
        if (!reason.value.trim())
          throw new Error("Describe the reason for the return.");
        await command("return.create", {
          orderId: order.id,
          lines,
          reason: reason.value.trim(),
        });
        m.close();
        setView("returns");
        toast("Return requested. A staff member will review it.");
      },
      "primary",
    ),
  );
}
function showReturnDetails(item) {
  const m = modal(
    item.creditMemoNumber || "Review return",
    `${item.invoiceNumber} · ${currentStore()?.name}`,
    true,
  );
  append(
    m.content,
    status(item.status),
    el("p", { class: "mt mb" }, item.reason),
    table(
      ["Product", "Quantity", "Credit"],
      item.lines.map((line) =>
        el(
          "tr",
          {},
          td(
            el("strong", {}, line.name),
            el("p", { class: "small" }, line.variant),
          ),
          td(`${line.quantity} ${line.unit}`),
          td(cash(line.totalCents)),
        ),
      ),
    ),
    totalRows({
      subtotal: item.subtotalCents,
      tax: item.taxCents,
      total: item.totalCents,
    }),
  );
  if (item.restockWarnings?.length)
    append(
      m.content,
      notice(
        "Some returned products have unknown stock counts. Staff must perform a stock count before their quantities can be updated.",
      ),
    );
  if (staff() && item.status === "pending") {
    const restock = input("checkbox", "", { checked: false });
    append(
      m.content,
      el(
        "label",
        { class: "check-field mt" },
        restock,
        "Returned goods were received and can be restocked",
      ),
      el(
        "p",
        { class: "small mt" },
        "Leave unchecked for damaged, missing or nonresalable goods. Approval credits the account once.",
      ),
    );
    append(
      m.footer,
      button("Cancel", m.close),
      button(
        "Approve & issue credit",
        async () => {
          await command("return.approve", {
            returnId: item.id,
            restock: restock.checked,
            expectedVersion: item.version,
          });
          m.close();
          toast("Return approved and account credited.");
        },
        "primary",
      ),
    );
  } else
    append(
      m.footer,
      button("Close", m.close),
      button("Print credit memo", () => window.print(), "", "download"),
    );
}
function renderNotifications() {
  const notifications = state.notifications;
  const root = el(
    "div",
    {},
    heading(
      "Notifications",
      "Order progress, payment confirmations and account updates.",
    ),
  );
  if (!notifications.length)
    return el(
      "div",
      {},
      root,
      empty(
        "You’re up to date",
        "New order and account updates will appear here.",
        [],
        "bell",
      ),
    );
  append(
    root,
    el(
      "div",
      {},
      notifications.map((item) => {
        const read = (item.readBy || []).includes(state.me.uid);
        return el(
          "article",
          { class: `notification${read ? "" : " unread"}` },
          el("div", { class: "activity-icon" }, icon("bell")),
          el(
            "div",
            {},
            el("strong", {}, titleCase(item.type)),
            el("p", {}, item.message || item.title || "Workspace update"),
            el("small", { class: "muted" }, date(item.createdAt)),
          ),
          read
            ? null
            : button(
                "Mark read",
                () => command("notification.read", { id: item.id }),
                "text-button",
              ),
        );
      }),
    ),
  );
  return root;
}

function renderMore() {
  const me = state.me;
  const options = [
    [
      "Account & payments",
      "Report payments and view confirmed account activity.",
      "wallet",
      () => setView("payments"),
    ],
    [
      "Returns & credits",
      "Request returns and track credit memos.",
      "return",
      () => setView("returns"),
    ],
    [
      "Notifications",
      "View order, delivery and account updates.",
      "bell",
      () => setView("notifications"),
    ],
    ...(staff()
      ? [
          [
            "Inventory",
            "Count stock, manage reservations and reorder levels.",
            "box",
            () => setView("inventory"),
          ],
        ]
      : []),
    [
      "Order templates",
      "Keep reusable notes and packing instructions.",
      "orders",
      showTemplates,
    ],
    [
      "Notification preferences",
      "Choose the updates you want to receive.",
      "user",
      showNotificationPreferences,
    ],
    [
      "Sync center",
      "Review pending actions and retry failed saves.",
      "refresh",
      showSyncCenter,
    ],
    [
      "Workspace backup",
      "Export or restore your working drafts.",
      "download",
      showWorkspaceBackup,
    ],
  ];
  const root = el(
    "div",
    { class: "stack" },
    heading("Workspace", "Your account, ordering tools and administration."),
    el(
      "div",
      { class: "panel split" },
      el(
        "div",
        {},
        el("h2", {}, me.name || me.displayName || me.email),
        el("p", {}, me.email),
        status(me.role),
      ),
      el(
        "div",
        { class: "actions" },
        button(
          "Toggle theme",
          () => {
            ws.rememberPreferences({
              theme: preferences().theme === "light" ? "dark" : "light",
            });
            render();
          },
          "",
          "sun",
        ),
        button("Sign out", signOut),
      ),
    ),
  );
  append(
    root,
    el(
      "div",
      { class: "grid tool-grid" },
      options.map(([title, description, symbol, action]) =>
        el(
          "section",
          { class: "panel" },
          el("div", { class: "activity-icon mb" }, icon(symbol)),
          el("h2", {}, title),
          el("p", { class: "small" }, description),
          el("div", { class: "actions" }, button("Open", action, "", "arrow")),
        ),
      ),
    ),
  );
  if (master()) {
    append(
      root,
      el(
        "section",
        { class: "panel" },
        el("div", { class: "eyebrow" }, "Administration"),
        el("h2", {}, "Manage your wholesale operation"),
        el(
          "div",
          { class: "actions" },
          button("Invite staff or customer", showInvite, "primary", "user"),
          button("Manage categories", showCategories),
          button("Migration & reconciliation", showMigration),
          button("Verify business backup", showBusinessBackup),
          button("Audit activity", showAudit),
          button("Order email settings", showOrderEmailSettings),
          button("Email delivery status", showEmailDelivery),
        ),
      ),
      el(
        "section",
        { class: "panel" },
        el("h2", {}, "Team access"),
        state.users.length
          ? table(
              ["Name / email", "Role", "Store access", ""],
              state.users.map((user) =>
                el(
                  "tr",
                  {},
                  td(
                    el(
                      "strong",
                      {},
                      user.name || user.name || user.displayName || user.email,
                    ),
                    el("p", { class: "small" }, user.email),
                  ),
                  td(titleCase(user.role)),
                  td(
                    user.role === "master"
                      ? "All stores"
                      : (user.storeIds || [])
                          .map((id) => storeById(id)?.name || id)
                          .join(", ") || "No stores assigned",
                  ),
                  td(
                    status(user.active ? "active" : "inactive"),
                    button(
                      "Manage access",
                      () => showManageAccess(user),
                      "text-button",
                    ),
                  ),
                ),
              ),
            )
          : el("p", {}, "No enrolled users."),
      ),
    );
  }
  return root;
}
function showSyncCenter() {
  const m = modal(
    "Sync center",
    "Drafts save online automatically. Actions below still need confirmation from the server.",
    true,
  );
  const pending = ws.pending();
  if (!pending.length)
    append(
      m.content,
      empty(
        "Everything is confirmed",
        "There are no pending server actions on this device.",
        [],
        "check",
      ),
    );
  else
    append(
      m.content,
      el(
        "div",
        { class: "stack" },
        pending.map((entry) => {
          const rejected =
            Number.isInteger(entry.status) &&
            entry.status >= 400 &&
            entry.status < 500 &&
            entry.status !== 408;
          return el(
            "div",
            { class: "panel" },
            el(
              "div",
              { class: "split" },
              el("h3", {}, titleCase(entry.command.type.replace(".", " "))),
              status(entry.error ? "failed" : "pending"),
            ),
            el(
              "p",
              { class: "small" },
              `${date(entry.createdAt)} · Request ${entry.command.id.slice(0, 8)}`,
            ),
            entry.error
              ? notice(entry.error, true)
              : notice("The server has not confirmed this action."),
            el(
              "div",
              { class: "actions" },
              button(
                "Retry same request",
                async () => {
                  await flushQueue(true);
                  m.close();
                  toast("Pending actions confirmed.");
                },
                "primary",
              ),
              rejected
                ? button(
                    "Remove rejected action",
                    async () => {
                      if (
                        !(await confirmAction(
                          "Remove this rejected action?",
                          "The server rejected it. Your locally saved draft remains available for correction.",
                          "Remove action",
                        ))
                      )
                        return;
                      ws.acknowledge(entry.command.id);
                      await refresh();
                      m.close();
                      showSyncCenter();
                    },
                    "danger",
                  )
                : null,
              entry.code?.includes("CONFLICT") &&
                entry.command.type === "order.save"
                ? button("Keep edits as a new draft", () => {
                    const old = ws.getDraft(entry.command.payload.id);
                    if (!old)
                      throw new Error("This local draft could not be found.");
                    const copy = {
                      ...old,
                      id: uuid(),
                      version: 0,
                      localRevision: 0,
                      syncState: "local",
                    };
                    ws.acknowledge(entry.command.id);
                    draft = saveWorkingDraft(copy);
                    storeId = copy.storeId;
                    ws.rememberPreferences({
                      activeDraftIds: {
                        ...preferences().activeDraftIds,
                        [storeId]: draft.id,
                      },
                    });
                    m.close();
                    setView("build");
                    toast("Your edits are preserved in a new draft.");
                  })
                : null,
            ),
          );
        }),
      ),
    );
  append(
    m.footer,
    button("Export local drafts", () =>
      download(
        `alabama-workspace-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(ws.exportBackup(), null, 2),
      ),
    ),
    button("Close", m.close),
  );
}
function showWorkspaceBackup() {
  const fileScope = operationScope();
  const m = modal(
    "Workspace backup",
    "Save a copy of this account’s drafts, preferences and pending action records.",
  );
  append(
    m.content,
    deviceCopySettings().element,
    button("Recover older device draft", showLegacyDeviceDraft, "", "refresh"),
  );
  const file = input("file", "", {
    accept: ".json,application/json",
    class: "file-input",
  });
  append(
    m.content,
    notice(
      "This backup contains drafts, preferences and pending action records. Import restores drafts only; pending actions are not replayed. Financial records stay on the server.",
    ),
    field("Import workspace JSON", file),
  );
  append(
    m.footer,
    button(
      "Export workspace",
      () =>
        download(
          `alabama-workspace-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify(ws.exportBackup(), null, 2),
        ),
      "",
      "download",
    ),
    button(
      "Import drafts",
      async () => {
        if (!file.files[0]) throw new Error("Choose a workspace backup file.");
        if (file.files[0].size > 10 * 1024 * 1024)
          throw new Error("This workspace file is too large (10 MB maximum).");
        let data;
        try {
          data = JSON.parse(await file.files[0].text());
        } catch {
          throw new Error("This file is not valid JSON.");
        }
        if (!scopeCurrent(fileScope)) throw new SessionChanged();
        const result = fileScope.workspace.importBackup(data);
        draftProtectionCache.clear();
        draftSync?.seed(
          state?.orders?.filter((order) => order.status === "draft") || [],
        );
        m.close();
        render();
        toast(
          `Imported ${result.imported} drafts; ${result.skipped} existing drafts preserved.`,
        );
      },
      "primary",
    ),
  );
}
function showTemplates() {
  const templates = preferences().templates || [];
  const m = modal(
    "Order templates",
    "Reusable notes and instructions for your next order.",
  );
  const listing = el(
    "div",
    { class: "stack" },
    templates.map((template) =>
      el(
        "section",
        { class: "panel" },
        el("h3", {}, template.name),
        el("p", { class: "small" }, template.text),
        el(
          "div",
          { class: "actions" },
          button("Use in current draft", () => {
            editDraft((d) => {
              d.notes = [d.notes, template.text].filter(Boolean).join("\n");
            });
            m.close();
            setView("build");
          }),
          button(
            "Remove",
            async () => {
              await persistPreferences({
                templates: templates.filter((item) => item.id !== template.id),
              });
              m.close();
              showTemplates();
            },
            "text-button danger",
          ),
        ),
      ),
    ),
  );
  const name = input("text", "", {
    maxlength: 200,
    placeholder: "e.g. Friday delivery",
  });
  const text = el("textarea", {
    maxlength: 10000,
    placeholder: "Reusable delivery or packing instructions",
  });
  append(
    m.content,
    templates.length ? listing : el("p", {}, "No templates yet."),
    el("hr"),
    el(
      "div",
      { class: "stack" },
      field("Template name", name),
      field("Instructions", text),
    ),
  );
  append(
    m.footer,
    button("Close", m.close),
    button(
      "Save template",
      async () => {
        if (!name.value.trim() || !text.value.trim())
          throw new Error("Give the template a name and some instructions.");
        await persistPreferences({
          templates: [
            ...templates,
            { id: uuid(), name: name.value.trim(), text: text.value.trim() },
          ],
        });
        m.close();
        showTemplates();
      },
      "primary",
    ),
  );
}
function showNotificationPreferences() {
  const prefs = preferences().notificationPreferences || {};
  const m = modal(
    "Notification preferences",
    "Choose how to receive order and account updates.",
  );
  const inApp = input("checkbox", "", { checked: prefs.inApp !== false });
  const email = input("checkbox", "", { checked: !!prefs.email });
  append(
    m.content,
    el(
      "div",
      { class: "stack" },
      el(
        "label",
        { class: "check-field" },
        inApp,
        "Show updates in this workspace",
      ),
      el(
        "label",
        { class: "check-field" },
        email,
        "Email order and account updates",
      ),
      notice(
        "Email delivery also requires the workspace owner to connect a sending service. Your preference is saved even while delivery is being configured.",
      ),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save preferences",
      async () => {
        await persistPreferences({
          notificationPreferences: {
            inApp: inApp.checked,
            email: email.checked,
          },
        });
        m.close();
        toast("Notification preferences saved.");
      },
      "primary",
    ),
  );
}
function showCategories() {
  const m = modal(
    "Catalog categories",
    "Group products so customers can find them quickly.",
  );
  const name = input("text", "", {
    maxlength: 150,
    placeholder: "New category name",
  });
  append(
    m.content,
    el(
      "div",
      { class: "activity-list" },
      state.categories.map((category) =>
        el(
          "div",
          { class: "activity-item" },
          el("strong", {}, category.name),
          button("Rename", () => {
            const edit = modal("Rename category");
            const renamed = input("text", category.name, { maxlength: 150 });
            append(edit.content, field("Category name", renamed));
            append(
              edit.footer,
              button(
                "Save",
                async () => {
                  if (!renamed.value.trim())
                    throw new Error("Enter a category name.");
                  await command("category.save", {
                    ...category,
                    name: renamed.value.trim(),
                    expectedVersion: category.version,
                  });
                  edit.close();
                  m.close();
                  showCategories();
                },
                "primary",
              ),
            );
          }),
        ),
      ),
    ),
    el("hr"),
    field("New category", name),
  );
  append(
    m.footer,
    button("Close", m.close),
    button(
      "Add category",
      async () => {
        if (!name.value.trim()) throw new Error("Enter a category name.");
        await command("category.save", {
          id: uuid(),
          name: name.value.trim(),
          sortOrder: state.categories.length,
          expectedVersion: 0,
        });
        m.close();
        showCategories();
      },
      "primary",
      "plus",
    ),
  );
}
function showInvite() {
  const m = modal(
    "Invite a team member or customer",
    "Each person signs in with an individual, verified email address.",
    true,
  );
  const email = input("email", "", {
    required: true,
    autocomplete: "off",
    maxlength: 254,
  });
  const role = select(
    [
      ["customer", "Customer"],
      ["salesman", "Salesperson"],
      ["master", "Administrator"],
    ],
    "customer",
  );
  const profiles = state.legacyProfiles || [];
  const legacy = select(
    [
      ["", "New account"],
      ...profiles
        .filter((profile) => profile.status !== "enrolled")
        .map((profile) => [
          profile.id,
          profile.name || profile.username || profile.id,
        ]),
    ],
    "",
  );
  const stores = el(
    "div",
    { class: "stack" },
    state.stores.map((store) =>
      el(
        "label",
        { class: "check-field" },
        input("checkbox", store.id),
        store.name,
      ),
    ),
  );
  append(
    m.content,
    el(
      "div",
      { class: "form-grid" },
      field("Email address", email),
      field("Role", role),
      field("Link an existing profile", legacy),
    ),
    el("h3", { class: "mt mb" }, "Store access"),
    stores,
    notice(
      "Administrators have access to all stores and financial settings. Salespeople and customers are restricted to the selected stores.",
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Create invitation",
      async () => {
        if (!email.checkValidity() || !email.value)
          throw new Error("Enter a valid email address.");
        const storeIds = [...stores.querySelectorAll("input:checked")].map(
          (node) => node.value,
        );
        if (role.value !== "master" && !storeIds.length)
          throw new Error("Select at least one store for this account.");
        const result = await api("/api/invites", {
          method: "POST",
          body: {
            email: email.value.trim(),
            role: role.value,
            storeIds,
            legacyProfileId: legacy.value || null,
          },
        });
        m.content.replaceChildren(
          notice(
            `Invitation created for ${result.email || email.value}. It expires ${date(result.expiresAt)}.`,
          ),
          field(
            "Invitation link",
            input("text", result.link, { readonly: true }),
          ),
          el(
            "p",
            { class: "small mt" },
            "Share this link directly with the invited person. They must sign in with the matching verified email.",
          ),
        );
        m.footer.replaceChildren(
          button("Close", m.close),
          button(
            "Copy invitation link",
            () => copyText(result.link),
            "primary",
          ),
        );
      },
      "primary",
    ),
  );
}
function reportBlock(report) {
  const block = el("div", { class: "stack" });
  if (report?.counts)
    append(
      block,
      table(
        ["Record type", "Count"],
        Object.entries(report.counts).map(([key, value]) =>
          el(
            "tr",
            {},
            td(titleCase(key)),
            td(typeof value === "object" ? JSON.stringify(value) : value),
          ),
        ),
      ),
    );
  if (Array.isArray(report?.exceptions) && report.exceptions.length)
    append(
      block,
      notice(
        `${report.exceptions.length} entries need review. Original records are preserved.`,
      ),
      el(
        "div",
        { class: "table-wrap" },
        el(
          "table",
          {},
          el(
            "thead",
            {},
            el("tr", {}, el("th", {}, "Review item"), el("th", {}, "Details")),
          ),
          el(
            "tbody",
            {},
            report.exceptions
              .slice(0, 100)
              .map((item) =>
                el(
                  "tr",
                  {},
                  td(item.code || item.type || item.collection || "Review"),
                  td(item.message || item.reason || JSON.stringify(item)),
                ),
              ),
          ),
        ),
      ),
    );
  append(
    block,
    el(
      "details",
      {},
      el("summary", {}, "Full verification report"),
      el("pre", { class: "history-note" }, JSON.stringify(report, null, 2)),
    ),
  );
  return block;
}
function showMigration() {
  const m = modal(
    "Migration & reconciliation",
    "Preview the preserved source and review accounts that need an opening balance.",
    true,
  );
  const blocked = state.stores.filter((store) => store.migrationBlocked);
  append(
    m.content,
    blocked.length
      ? el(
          "section",
          { class: "panel" },
          el(
            "h3",
            {},
            `${blocked.length} account${blocked.length === 1 ? "" : "s"} need reconciliation`,
          ),
          el(
            "div",
            { class: "activity-list" },
            blocked.map((store) =>
              el(
                "div",
                { class: "activity-item" },
                el("strong", {}, store.name),
                button("Review balance", () => showReconcile(store)),
              ),
            ),
          ),
        )
      : notice(
          "No migrated accounts currently require balance reconciliation.",
        ),
    el(
      "p",
      { class: "mt" },
      "Previewing reads the legacy data and identifies what will be preserved. Applying migration requires frozen legacy writes and a matching source checksum.",
    ),
  );
  const reports = el("div", { class: "mt" });
  append(m.content, reports);
  append(
    m.footer,
    button("Close", m.close),
    button(
      "Preview legacy migration",
      async () => {
        const result = await api("/api/admin/migrate", {
          method: "POST",
          body: { dryRun: true },
        });
        reports.replaceChildren(reportBlock(result.report));
        m.footer.replaceChildren(
          button("Close", m.close),
          button("Download report", () =>
            download(
              `migration-${result.migrationId}.json`,
              JSON.stringify(result, null, 2),
            ),
          ),
          button(
            "Apply verified migration",
            async () => {
              if (
                !(await confirmAction(
                  "Apply this migration?",
                  "The server will archive the legacy source and import its records using this exact preview checksum. Existing migrated records are preserved.",
                  "Apply migration",
                ))
              )
                return;
              const applied = await api("/api/admin/migrate", {
                method: "POST",
                body: { dryRun: false, sourceChecksum: result.sourceChecksum },
              });
              reports.replaceChildren(
                notice(
                  "Migration finished. Review the verification report and reconcile flagged accounts.",
                ),
                reportBlock(applied.report),
              );
              await refresh();
              m.footer.replaceChildren(
                button("Close", m.close),
                button("Download migration report", () =>
                  download(
                    `migration-${applied.migrationId}.json`,
                    JSON.stringify(applied, null, 2),
                  ),
                ),
              );
            },
            "primary",
          ),
        );
      },
      "primary",
    ),
  );
}
function showReconcile(store) {
  const m = modal("Reconcile imported account", store.name, true);
  const amount = input("number", "", {
    step: ".01",
    placeholder: "Verified current balance",
  });
  const reason = el("textarea", {
    required: true,
    maxlength: 4000,
    placeholder:
      "Record how the balance was verified, including any imported payment corrections.",
  });
  append(
    m.content,
    notice(
      "Use the original records and real payment receipts to verify the amount owed. This creates an auditable adjustment; it does not rewrite historical payments.",
    ),
    table(
      ["Date", "Imported activity", "Recognized change"],
      state.ledger
        .filter((entry) => entry.storeId === store.id)
        .map((entry) =>
          el(
            "tr",
            {},
            td(date(entry.createdAt || entry.date)),
            td(entry.note || titleCase(entry.type)),
            td(cash(entry.deltaCents)),
          ),
        ),
    ),
    el(
      "div",
      { class: "form-grid mt" },
      field(
        "Verified account balance ($)",
        amount,
        "A negative balance means the customer has a credit.",
      ),
      field("Verification notes", reason),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Confirm reconciled balance",
      async () => {
        if (!/^-?\d+(\.\d{1,2})?$/.test(amount.value))
          throw new Error(
            "Enter a verified balance with at most two decimal places.",
          );
        const cents = Math.round(Number(amount.value) * 100);
        if (!Number.isSafeInteger(cents) || !reason.value.trim())
          throw new Error("Add verification notes and a valid balance.");
        if (
          !(await confirmAction(
            "Confirm this account balance?",
            `${store.name} will have a verified balance of ${cash(cents)}. This creates an audit entry and enables normal account activity.`,
            "Confirm balance",
          ))
        )
          return;
        await command("migration.reconcile", {
          storeId: store.id,
          openingBalanceCents: cents,
          reason: reason.value.trim(),
          expectedVersion: store.version,
        });
        m.close();
        toast("Account balance reconciled.");
      },
      "primary",
    ),
  );
}
function showBusinessBackup() {
  const fileScope = operationScope();
  const m = modal(
    "Business backup & recovery",
    "Export a server snapshot and verify restoration into an isolated recovery copy.",
    true,
  );
  const file = input("file", "", {
    accept: ".json,application/json",
    class: "file-input",
  });
  const resultArea = el("div", { class: "mt" });
  append(
    m.content,
    notice(
      "Recovery verification creates a separate copy of the backup. It does not replace current orders, balances or inventory.",
    ),
    field("Business backup JSON", file),
    resultArea,
  );
  append(
    m.footer,
    button(
      "Export business backup",
      async () => {
        const result = await api("/api/admin/backup");
        download(
          `alabama-business-${new Date().toISOString().slice(0, 10)}.json`,
          JSON.stringify(result, null, 2),
        );
        toast("Business backup downloaded.");
      },
      "",
      "download",
    ),
    button(
      "Verify backup restore",
      async () => {
        if (!file.files[0])
          throw new Error("Choose a business backup JSON file.");
        if (file.files[0].size > 25 * 1024 * 1024)
          throw new Error(
            "For backups over 25 MB, use the managed recovery procedure.",
          );
        let backup;
        try {
          backup = JSON.parse(await file.files[0].text());
        } catch {
          throw new Error("This file is not valid JSON.");
        }
        if (!scopeCurrent(fileScope)) throw new SessionChanged();
        const preview = await api("/api/admin/restore", {
          method: "POST",
          body: { dryRun: true, backup },
        });
        if (preview.mode !== "isolated-recovery")
          throw new Error(
            "The server does not yet support isolated recovery verification. Current business data was not changed.",
          );
        resultArea.replaceChildren(reportBlock(preview));
        m.footer.replaceChildren(
          button("Close", m.close),
          button(
            "Create recovery copy",
            async () => {
              const result = await api("/api/admin/restore", {
                method: "POST",
                body: { dryRun: false, backupId: preview.backupId, backup },
              });
              resultArea.replaceChildren(
                notice(
                  "Recovery verification completed. The report shows the copy’s record counts and checksum.",
                ),
                reportBlock(result),
              );
              m.footer.replaceChildren(
                button("Close", m.close),
                button("Download recovery report", () =>
                  download(
                    `recovery-${preview.backupId.slice(0, 12)}.json`,
                    JSON.stringify(result, null, 2),
                  ),
                ),
              );
            },
            "primary",
          ),
        );
      },
      "primary",
    ),
  );
}
function showAudit() {
  const m = modal(
    "Audit activity",
    "Recent server-confirmed changes and the account that made them.",
    true,
  );
  append(
    m.content,
    table(
      ["When", "Action", "Actor", "Record"],
      (state.audit || []).map((item) =>
        el(
          "tr",
          {},
          td(date(item.createdAt || item.at)),
          td(titleCase(item.type?.replace(".", " "))),
          td(
            state.users.find(
              (user) => user.uid === (item.actorUid || item.actorId),
            )?.email ||
              item.actorUid ||
              item.actorId ||
              "System",
          ),
          td(item.recordId || item.storeId || "—"),
        ),
      ),
    ),
  );
  append(m.footer, button("Close", m.close));
}

function showAssistant() {
  const fileScope = operationScope();
  if (!storeId) throw new Error("Select a store to create a proposed order.");
  const m = modal(
    "Ask AI to build an order",
    "Type your order, use your keyboard’s microphone to dictate it, or attach a photo. Gemini suggests matching products for you to review.",
    true,
  );
  const text = el("textarea", {
    id: "assistant-note",
    placeholder:
      "For example: Add 2 cases of SS Original and 6 each of Raw cones. Ask me if a product or flavor is unclear.",
    maxlength: 12000,
    rows: 5,
  });
  const photo = input("file", "", {
    accept: "image/jpeg,image/png,image/webp",
    class: "file-input",
  });
  const results = el("div", { class: "mt" });
  append(
    m.content,
    el(
      "div",
      { class: "stack" },
      field(
        "Tell the AI what you need",
        text,
        "This assistant prepares order suggestions. It does not send or submit an order until you review and confirm it.",
      ),
      field(
        "Photo of an order or product list",
        photo,
        "JPEG, PNG or WebP, up to 5 MB. Photos are sent to Gemini to identify the requested products.",
      ),
    ),
    results,
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Create proposed cart",
      async () => {
        let image;
        if (photo.files[0]) {
          const file = photo.files[0];
          if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
            throw new Error("Choose a JPEG, PNG or WebP image.");
          if (file.size > 5 * 1024 * 1024)
            throw new Error("Choose an image smaller than 5 MB.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          image = { mimeType: file.type, data: btoa(binary) };
        }
        if (!text.value.trim() && !image)
          throw new Error("Enter an order note or choose a photo.");
        results.replaceChildren(notice("Gemini is reading your request…"));
        if (!scopeCurrent(fileScope)) throw new SessionChanged();
        const proposal = await api("/api/assistant/propose", {
          method: "POST",
          body: { text: text.value.trim(), ...(image ? { image } : {}) },
        });
        const review = [];
        const lines = el(
          "div",
          {},
          (proposal.lines || []).map((line) => {
            const product = productById(line.productId);
            if (!product) return null;
            const checked = input("checkbox", "", {
              checked: true,
              "aria-label": `Include ${product.name}`,
            });
            const quantity = input("number", line.quantity, {
              min: 1,
              step: 1,
              "aria-label": `Proposed quantity for ${product.name}`,
            });
            review.push({ line, checked, quantity });
            return el(
              "div",
              { class: "proposal-line" },
              checked,
              el(
                "div",
                {},
                el("strong", {}, product.name),
                el(
                  "p",
                  { class: "small" },
                  `${line.variant || "Standard"} · ${line.unit || "each"}`,
                ),
                line.note ? el("p", { class: "small" }, line.note) : null,
              ),
              quantity,
            );
          }),
        );
        results.replaceChildren(
          el("h3", {}, "Review proposed items"),
          ...(proposal.summary
            ? [el("p", { class: "mt mb" }, proposal.summary)]
            : []),
          ...(proposal.ambiguities || []).map((item) =>
            notice(typeof item === "string" ? item : JSON.stringify(item)),
          ),
          review.length
            ? lines
            : empty(
                "No confident matches",
                "Try including product names, flavors and exact quantities. You can also use the catalog.",
                [
                  button("Browse catalog", () => {
                    m.close();
                    setView("catalog");
                  }),
                ],
              ),
        );
        const reviewed = input("checkbox", "", { checked: false });
        append(
          results,
          el(
            "label",
            { class: "check-field mt" },
            reviewed,
            "I reviewed the products, variants and quantities, including any warnings.",
          ),
        );
        m.footer.replaceChildren(
          button("Keep editing note", () => {
            m.close();
            showAssistant();
          }),
          button(
            "Add reviewed items to draft",
            () => {
              if (!reviewed.checked)
                throw new Error(
                  "Review and acknowledge the proposed cart first.",
                );
              const chosen = review
                .filter((item) => item.checked.checked)
                .map((item) => {
                  const quantity = Number(item.quantity.value);
                  if (!Number.isSafeInteger(quantity) || quantity <= 0)
                    throw new Error(
                      "Every selected quantity must be a positive whole number.",
                    );
                  return { ...item.line, id: uuid(), quantity };
                });
              if (!chosen.length)
                throw new Error("Select at least one proposed item.");
              editDraft((d) => d.lines.push(...chosen));
              m.close();
              setView("build");
              toast(
                "Reviewed items added to your draft. Nothing has been submitted.",
              );
            },
            "primary",
          ),
        );
      },
      "primary",
      "spark",
    ),
  );
}
function showScanner() {
  const cameraScope = operationScope();
  const m = modal(
    "Scan a product barcode",
    "Use a handheld scanner or enter a barcode. Camera scanning is available in supported browsers.",
  );
  const code = input("text", "", {
    inputmode: "numeric",
    autocomplete: "off",
    placeholder: "Scan or enter barcode",
    id: "barcode-input",
  });
  const result = el("div", { class: "mt" });
  const camera = el("div", { class: "mt" });
  function findBarcode(value) {
    const exact = String(value || "").trim();
    if (!exact) throw new Error("Scan or enter a barcode.");
    const matches = [];
    for (const product of state.products) {
      if (product.barcode === exact || product.sku === exact)
        matches.push({ product, variant: "" });
      for (const [variant, barcode] of Object.entries(
        product.variantBarcodes || {},
      ))
        if (barcode === exact) matches.push({ product, variant });
    }
    if (matches.length === 1) {
      cameraCleanup?.();
      m.close();
      showAddProduct(matches[0].product, matches[0].variant);
      return;
    }
    search = exact;
    if (!matches.length)
      result.replaceChildren(
        notice(
          "No exact barcode match. Try catalog search or have staff add this barcode to the product.",
        ),
      );
    else
      result.replaceChildren(
        notice(
          "More than one product has this barcode. Choose the correct product below.",
        ),
        el(
          "div",
          { class: "stack" },
          matches.map(({ product, variant }) =>
            button(`${product.name}${variant ? ` / ${variant}` : ""}`, () => {
              cameraCleanup?.();
              m.close();
              showAddProduct(product, variant);
            }),
          ),
        ),
      );
  }
  code.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      act(() => findBarcode(code.value));
    }
  });
  append(m.content, field("Barcode", code), result, camera);
  append(
    m.footer,
    button(
      "Search barcode",
      () => findBarcode(code.value),
      "primary",
      "search",
    ),
  );
  if ("BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia)
    append(
      m.footer,
      button(
        "Use camera",
        async () => {
          cameraCleanup?.();
          const formats = await BarcodeDetector.getSupportedFormats();
          const detector = new BarcodeDetector({
            formats: formats.filter((format) =>
              [
                "ean_13",
                "ean_8",
                "upc_a",
                "upc_e",
                "code_128",
                "code_39",
                "qr_code",
              ].includes(format),
            ),
          });
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment" },
            audio: false,
          });
          if (!scopeCurrent(cameraScope)) {
            stream.getTracks().forEach((track) => track.stop());
            throw new SessionChanged();
          }
          const video = el("video", {
            autoplay: true,
            playsinline: true,
            muted: true,
            class: "camera-preview",
          });
          video.srcObject = stream;
          camera.replaceChildren(
            video,
            el("p", { class: "small mt" }, "Point the camera at the barcode."),
          );
          let stopped = false,
            timer;
          cameraCleanup = () => {
            stopped = true;
            clearTimeout(timer);
            stream.getTracks().forEach((track) => track.stop());
            video.remove();
            cameraCleanup = null;
          };
          await video.play();
          const scan = async () => {
            if (stopped) return;
            try {
              const codes = await detector.detect(video);
              if (codes[0]?.rawValue) {
                code.value = codes[0].rawValue;
                cameraCleanup?.();
                findBarcode(code.value);
                return;
              }
            } catch {}
            if (!stopped) timer = setTimeout(scan, 350);
          };
          scan();
        },
        "",
        "scan",
      ),
    );
  else
    append(
      m.content,
      el(
        "p",
        { class: "small mt" },
        "This browser does not support camera barcode detection. A handheld scanner or manual barcode entry works here.",
      ),
    );
  m.dialog.addEventListener("close", () => cameraCleanup?.());
  code.focus();
}

function renderAuth(error = "") {
  state = null;
  session = null;
  const invite = new URL(location.href).searchParams.has("invite");
  const name = el(
    "div",
    { class: "auth-story" },
    brand(),
    el(
      "div",
      {},
      el("div", { class: "eyebrow" }, "Built for your business"),
      el(
        "h1",
        {},
        "From your order",
        el("br"),
        "to your ",
        el("em", {}, "shelves."),
      ),
      el(
        "p",
        {},
        "A clearer way to order, manage inventory and keep customer accounts moving.",
      ),
    ),
    el(
      "footer",
      { class: "small" },
      "Alabama Wholesale · Your everyday ordering workspace",
    ),
  );
  const email = input("email", "", {
    id: "sign-in-email",
    autocomplete: "username",
    required: true,
    placeholder: "you@example.com",
  });
  const password = input("password", "", {
    id: "sign-in-password",
    autocomplete: "current-password",
    required: true,
    minlength: 6,
  });
  const card = el(
    "div",
    { class: "auth-card" },
    el("div", { class: "eyebrow" }, invite ? "You’re invited" : "Welcome back"),
    el("h2", {}, "Sign in to your workspace"),
    el(
      "p",
      {},
      invite
        ? "Use the email address your invitation was created for."
        : "Use your individual account to access your stores and orders.",
    ),
    error ? notice(error, true) : null,
    button("Continue with Google", () => firebase.signInGoogle(), "primary"),
    el("div", { class: "auth-divider" }, "or continue with email"),
  );
  const form = el(
    "form",
    {},
    field("Email address", email),
    field("Password", password),
  );
  const submit = el(
    "button",
    { type: "submit", class: "full-width" },
    "Sign in",
  );
  append(
    form,
    submit,
    button(
      "Forgot password?",
      async () => {
        if (!email.value || !email.checkValidity())
          throw new Error("Enter your email address first.");
        await firebase.resetPassword(email.value.trim());
        toast(
          "If this email has an account, password reset instructions will be sent.",
        );
      },
      "text-button",
    ),
  );
  let submitting = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    await act(
      () => firebase.signInEmail(email.value.trim(), password.value),
      submit,
    );
    submitting = false;
  });
  append(
    card,
    form,
    el("hr"),
    el(
      "p",
      { class: "small" },
      invite
        ? "New to the workspace? Create your individual account first."
        : "New staff and customers need an invitation from the workspace owner.",
    ),
    button("Create an invited account", showRegistration, "text-button"),
  );
  $("app").replaceChildren(
    el(
      "div",
      { class: "auth-shell" },
      name,
      el("main", { id: "main", class: "auth-form" }, card),
    ),
  );
}
function showRegistration() {
  const m = modal(
    "Create your individual account",
    "Use the email address on your invitation. You will verify it before entering the workspace.",
  );
  const email = input("email", "", {
    autocomplete: "username",
    required: true,
  });
  const password = input("password", "", {
    autocomplete: "new-password",
    minlength: 12,
    required: true,
  });
  append(
    m.content,
    el(
      "div",
      { class: "stack" },
      field("Email address", email),
      field("Password", password, "Use at least 12 characters."),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Create account",
      async () => {
        if (!email.checkValidity() || !email.value)
          throw new Error("Enter a valid email address.");
        if (password.value.length < 12)
          throw new Error("Use a password with at least 12 characters.");
        await firebase.registerEmail(email.value.trim(), password.value);
        m.close();
        toast("Account created. Check your email for the verification link.");
      },
      "primary",
    ),
  );
}
function exportDeviceWorkspace(user = firebase.identity()) {
  if (!user || user.uid !== firebase.identity()?.uid)
    throw new SessionChanged();
  // Export raw account data, including unreadable JSON and pending commands.
  // Never export Firebase credentials or remove existing browser records.
  const key = `aw:v2:${user.uid}`;
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw new StorageFailure(
      "This browser is blocking access to saved data. Allow website storage, then retry the export. Nothing has been cleared.",
    );
  }
  download(
    `alabama-device-recovery-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(
      {
        format: "aw-device-recovery",
        version: 1,
        exportedAt: Date.now(),
        workspace: { key, raw },
      },
      null,
      2,
    ),
  );
}
function deviceStorageNotice() {
  const storage = ws?.storageStatus();
  if (!storage?.warning) return null;
  const unprotected =
    storage.unprotectedDraftCount > 0 || hasUnsavedDraftNotes();
  const content = el(
    "div",
    { class: "notice small", role: unprotected ? "alert" : "status" },
    el(
      "div",
      { class: "stack" },
      el(
        "strong",
        {},
        unprotected
          ? "Device backup unavailable · check draft save status"
          : "Device backup unavailable",
      ),
      el(
        "span",
        {},
        unprotected
          ? "Keep this tab open until your draft says Saved online. Check its status if the connection is unavailable."
          : "Confirmed online drafts remain saved. Local storage is full or blocked; offline edits and queued submissions need a working device backup.",
      ),
      el(
        "details",
        {},
        el("summary", {}, "Device backup options"),
        el(
          "div",
          { class: "actions mt" },
          button("Export saved drafts", () =>
            download(
              `alabama-workspace-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(workspaceRecoverySnapshot(), null, 2),
            ),
          ),
          button("Retry device storage", async () => {
            const enteredNotes = $("draft-notes")?.value;
            const retryNotes =
              draft &&
              enteredNotes !== undefined &&
              enteredNotes !== (draft.notes || "");
            if (retryNotes) {
              const latest = ws.getDraft(draft.id);
              if (
                !latest ||
                latest.localRevision !== draft.localRevision ||
                latest.version !== draft.version
              )
                throw new Error(
                  "This draft changed elsewhere. Copy your unsaved notes, then reopen the saved draft before applying them.",
                );
            }
            ws.retryStorage();
            if (draft) draft = ws.getDraft(draft.id);
            if (retryNotes && draft)
              editDraft(
                (next) => {
                  next.notes = enteredNotes;
                },
                { renderPage: false },
              );
            await refresh();
            if (!ws.storageStatus().warning)
              toast("Device storage is working again.");
          }),
        ),
      ),
    ),
  );
  content.id = "device-storage-notice";
  return content;
}
function updateStorageNotice() {
  const previous = $("device-storage-notice");
  const next = deviceStorageNotice();
  if (previous) {
    if (next) previous.replaceWith(next);
    else previous.remove();
  } else if (next) $("main")?.prepend(next);
}
function renderWorkspaceFailure(user, error) {
  const storageError = error instanceof StorageFailure;
  draftSync?.dispose();
  draftSync = null;
  orderDownloads?.dispose();
  orderDownloads = null;
  resetDraftProtection();
  state = null;
  session = null;
  $("app").replaceChildren(
    el(
      "main",
      { id: "main", class: "boot" },
      brand(),
      el(
        "h1",
        {},
        storageError
          ? "Device storage needs attention"
          : "Couldn’t open your workspace",
      ),
      el("p", {}, user.email),
      notice(friendlyError(error), true),
      el(
        "p",
        {},
        storageError
          ? "Your sign-in is separate from this device’s saved data. Nothing has been cleared. Export a recovery copy before changing browser storage settings."
          : "Your workspace could not be loaded. Retry to check your connection and session.",
      ),
      el(
        "div",
        { class: "actions" },
        storageError
          ? button("Export device recovery copy", () =>
              exportDeviceWorkspace(user),
            )
          : null,
        button(
          "Retry opening workspace",
          () => onIdentity(firebase.identity()),
          "primary",
        ),
        button("Sign out", signOut),
      ),
    ),
  );
}
function renderEnrollment(user, error = "") {
  const invite = new URL(location.href).searchParams.get("invite");
  const needsVerification = !user.emailVerified;
  const content = el(
    "main",
    { id: "main", class: "boot" },
    brand(),
    el(
      "h1",
      {},
      needsVerification ? "Verify your email" : "Your account needs access",
    ),
    el("p", {}, user.email),
    error ? notice(error, true) : null,
    el(
      "p",
      {},
      needsVerification
        ? "Open the verification link in your email, then return here."
        : invite
          ? "Accept your invitation to connect your account to the assigned stores."
          : "Ask the workspace owner for an invitation. The owner should use Continue with Google.",
    ),
    el(
      "div",
      { class: "actions" },
      needsVerification
        ? button(
            "Send verification email",
            async () => {
              await firebase.verifyEmail();
              toast("Verification email sent.");
            },
            "primary",
          )
        : invite
          ? button(
              "Accept invitation",
              async () => {
                await api("/api/invites/accept", {
                  method: "POST",
                  body: { token: invite },
                });
                history.replaceState({}, "", location.pathname);
                await onIdentity(await firebase.reloadIdentity());
              },
              "primary",
            )
          : null,
      button("I’ve verified / refresh access", async () =>
        onIdentity(await firebase.reloadIdentity()),
      ),
      button("Sign out", signOut),
    ),
  );
  $("app").replaceChildren(content);
}
let identityGeneration = 0;
async function onIdentity(user) {
  const previousWorkspace = ws?.key === `aw:v2:${user?.uid}` ? ws : null;
  draftSync?.dispose();
  draftSync = null;
  orderDownloads?.dispose();
  orderDownloads = null;
  resetDraftProtection();
  const generation = ++identityGeneration;
  cameraCleanup?.();
  document.querySelectorAll("dialog").forEach((dialog) => dialog.close());
  $("toasts").replaceChildren();
  $("announcements").textContent = "";
  session = null;
  state = null;
  draft = null;
  lastDraftRefresh = 0;
  ws = null;
  undo = [];
  redo = [];
  if (!user || user.isAnonymous) {
    renderAuth();
    if (user?.isAnonymous) {
      try {
        await firebase.logout();
      } catch (error) {
        if (generation === identityGeneration) renderAuth(friendlyError(error));
      }
    }
    return;
  }
  try {
    try {
      ws = previousWorkspace || new Workspace(localStorage, user.uid);
    } catch (error) {
      if (error instanceof StorageFailure) throw error;
      throw new StorageFailure(
        "Browser storage is unavailable. Your changes cannot be saved on this device.",
      );
    }
    document.documentElement.dataset.theme = ws.preferences().theme || "dark";
    $("app").replaceChildren(
      el(
        "main",
        { id: "main", class: "boot" },
        brand(),
        el("h1", {}, "Opening your workspace"),
        el("p", {}, "Verifying your access…"),
      ),
    );
    const invite = new URL(location.href).searchParams.get("invite");
    if (invite && !user.emailVerified) {
      renderEnrollment(user);
      return;
    }
    if (invite) {
      renderEnrollment(user);
      return;
    }
    const result = await api("/api/session/bootstrap", {
      method: "POST",
      body: {},
    });
    if (generation !== identityGeneration) return;
    if (result.enrollmentRequired || !result.me) {
      renderEnrollment(user);
      return;
    }
    session = result.me;
    const syncScope = operationScope();
    orderDownloads = createOrderDownloads({
      fetchPdf: (order) => orderPdfBlob(order, "invoice", syncScope),
      download,
      isCurrent: () => scopeCurrent(syncScope),
      onChange: (id, copyStatus) => {
        if (!scopeCurrent(syncScope)) return;
        try {
          updateOrderCopyPanels(id, copyStatus);
        } catch {
          // Document status is optional presentation, never a financial action.
        }
      },
    });
    draftSync = createDraftSync({
      workspace: ws,
      send: (command) =>
        runSessionTask(syncScope, scopeCurrent, () =>
          api("/api/commands", { method: "POST", body: command }),
        ),
      isCurrent: () => scopeCurrent(syncScope),
      online: () => navigator.onLine,
      onChange: (id) => {
        if (scopeCurrent(syncScope)) {
          try {
            scheduleDraftProtectionUpdate(id, syncScope);
          } catch {
            // A device read failure cannot undo a confirmed online save.
            const status = draftSync?.status(id);
            if (draft?.id === id && $("draft-sync-message"))
              $("draft-sync-message").textContent = status?.cloudConfirmed
                ? "Saved online · device copy unavailable"
                : "Save status unavailable · keep this tab open";
          }
        }
      },
    });
    storeId = ws.preferences().storeId || "";
    await refresh({ renderPage: false });
    if (generation !== identityGeneration) return;
    render();
    if (ws.pending().length)
      toast(
        "This device has pending actions. Open Sync center to review and retry.",
      );
  } catch (error) {
    if (generation !== identityGeneration) return;
    if (error instanceof StorageFailure) {
      renderWorkspaceFailure(user, error);
    } else if (ws && (error.code === "NETWORK" || !navigator.onLine)) {
      try {
        renderOfflineRecovery(user);
      } catch (storageError) {
        renderWorkspaceFailure(user, storageError);
      }
    } else if (
      [
        "enrollment_required",
        "invalid_role",
        "owner_already_enrolled",
      ].includes(error.code)
    ) {
      renderEnrollment(user, friendlyError(error));
    } else {
      renderWorkspaceFailure(user, error);
    }
  }
}
function renderOfflineRecovery(user) {
  draftSync?.dispose();
  draftSync = null;
  orderDownloads?.dispose();
  orderDownloads = null;
  resetDraftProtection();
  state = null;
  session = null;
  const workspace = ws;
  const scope = operationScope();
  const drafts = workspace.listDrafts();
  const selectDraft = select(
    drafts.map((item) => [
      item.id,
      `${item.lines.length} lines · ${date(item.updatedAt)} · ${item.storeId}`,
    ]),
    drafts[0]?.id || "",
  );
  const content = el("div", { class: "stack" });
  const main = el(
    "main",
    { id: "main", class: "content offline-recovery" },
    brand(),
    heading("Offline draft recovery", user.email || "This device"),
    notice(
      "The server is unavailable. Drafts for this account are shown from this device or the current tab. Keep this tab open if a device save fails. Online saving resumes when connected.",
    ),
    field("Saved draft", selectDraft),
    content,
    el(
      "div",
      { class: "actions mt" },
      button("Export local workspace", () =>
        download(
          "alabama-offline-workspace.json",
          JSON.stringify(workspace.exportBackup(), null, 2),
        ),
      ),
      button("Reconnect", () => onIdentity(firebase.identity()), "primary"),
      button("Sign out", signOut),
    ),
  );
  function draw() {
    if (!scopeCurrent(scope)) return;
    let saved = workspace.getDraft(selectDraft.value);
    content.replaceChildren();
    if (!saved) {
      append(
        content,
        empty(
          "No drafts available",
          "Connect to the server to open your workspace.",
        ),
      );
      return;
    }
    const notes = el("textarea", {
      value: saved.notes || "",
      maxlength: 10000,
    });
    const quantities = saved.lines.map((line) => ({
      line,
      node: input("number", line.quantity, {
        min: 1,
        step: 1,
        "aria-label": `Quantity ${line.name || line.productId}`,
      }),
    }));
    const saveStatus = el(
      "p",
      { class: "small", role: "status" },
      "Valid edits save on this device automatically and sync when connected.",
    );
    function saveOffline() {
      if (!scopeCurrent(scope)) return;
      try {
        let invalidQuantity = false;
        const lines = quantities.map(({ line, node }) => {
          const quantity = Number(node.value);
          if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            invalidQuantity = true;
            return saved.lines.find((item) => item.id === line.id) || line;
          }
          return { ...line, quantity };
        });
        saved = saveWorkingDraft(
          { ...saved, lines, notes: notes.value },
          workspace,
        );
        const durable = workspace.localDraftStatus(saved.id).localPersisted;
        saveStatus.textContent = durable
          ? "Saved on this device · syncs automatically when connected" +
            (invalidQuantity
              ? ". Enter a positive whole quantity; the last valid quantity is preserved."
              : "")
          : "Not yet protected · keep this tab open and reconnect, or export your workspace.";
      } catch (error) {
        if (error.name === "DraftConflict") {
          // Another tab changed the offline base. Keep this editor as a separate draft.
          const recovery = {
            ...saved,
            ...createDraft(saved.storeId),
            localRevision: 0,
            lines: saved.lines.map((line) => {
              const value = Number(
                quantities.find((item) => item.line.id === line.id)?.node.value,
              );
              return {
                ...line,
                quantity:
                  Number.isSafeInteger(value) && value > 0
                    ? value
                    : line.quantity,
              };
            }),
            notes: notes.value,
          };
          try {
            saved = saveWorkingDraft(recovery, workspace);
            append(
              selectDraft,
              el(
                "option",
                { value: saved.id },
                "Recovered edits · another tab changed the original",
              ),
            );
            selectDraft.value = saved.id;
            saveStatus.textContent = workspace.localDraftStatus(saved.id)
              .localPersisted
              ? "Your edits were saved as a separate draft because the original changed in another tab. Both copies are preserved."
              : "Your edits are kept as a separate draft in this tab. Reconnect or export before leaving.";
            return;
          } catch (recoveryError) {
            error = recoveryError;
          }
        }
        saveStatus.textContent = friendlyError(error);
      }
    }
    notes.addEventListener("input", saveOffline);
    quantities.forEach(({ line, node }) => {
      node.addEventListener("input", saveOffline);
      node.addEventListener("change", () => {
        if (
          !Number.isSafeInteger(Number(node.value)) ||
          Number(node.value) <= 0
        )
          node.value =
            saved.lines.find((item) => item.id === line.id)?.quantity ||
            line.quantity;
      });
    });
    append(
      content,
      table(
        ["Product reference / variant", "Unit", "Quantity"],
        quantities.map(({ line, node }) =>
          el(
            "tr",
            {},
            td(
              line.name || line.productName || line.productId,
              el("p", { class: "small" }, line.variant),
            ),
            td(line.unit),
            td(node),
          ),
        ),
      ),
      field("Draft notes", notes),
      saveStatus,
    );
  }
  selectDraft.addEventListener("change", draw);
  $("app").replaceChildren(main);
  draw();
}
async function boot() {
  try {
    let response;
    try {
      response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error("Configuration unavailable");
    } catch {
      response = await fetch("/firebase-config.json");
    }
    if (!response.ok)
      throw new Error(
        "The workspace configuration could not be loaded. Open this app online once to make offline draft recovery available.",
      );
    config = await response.json();
    await firebase.initializeIdentity(config, onIdentity);
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("/service-worker.js", { scope: "/" })
        .catch(() => {});
  } catch (error) {
    $("app").replaceChildren(
      el(
        "main",
        { id: "main", class: "boot" },
        brand(),
        el("h1", {}, "Could not open the workspace"),
        notice(friendlyError(error), true),
        button("Try again", () => location.reload(), "primary"),
      ),
    );
  }
}
window.addEventListener("popstate", () => {
  const route = location.hash.slice(2);
  if (
    [
      "home",
      "catalog",
      "build",
      "orders",
      "stores",
      "more",
      "inventory",
      "payments",
      "returns",
      "notifications",
    ].includes(route)
  ) {
    view = route;
    if (state) render();
  }
});
window.addEventListener("online", () => {
  draftProtectionCache.clear();
  if (state) {
    draftSync?.resume();
    if (!hasUnsavedDraftNotes()) render();
    toast("Connection restored. Drafts are saving online automatically.");
  } else if (ws && firebase.identity()) {
    onIdentity(firebase.identity());
  }
});
window.addEventListener("offline", () => {
  draftProtectionCache.clear();
  draftSync?.resume();
  if (state && !hasUnsavedDraftNotes()) render();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushWorkingDrafts();
  else refreshInForeground();
});
setInterval(refreshInForeground, 30000);
function hasUnsavedDraftNotes() {
  const note = $("draft-notes");
  return !!(
    draft &&
    note?.dataset.draftId === draft.id &&
    note.value !== (draft.notes || "")
  );
}
window.addEventListener("storage", (event) => {
  if (ws && event.key === ws.key) {
    draftProtectionCache.clear();
    draftSync?.seed(
      state?.orders?.filter((order) => order.status === "draft") || [],
    );
    // Keep the visible base while typing so stale input cannot overwrite a newer draft.
    if (state && !editorIsActive()) {
      restoreActiveDraft();
      render();
    } else
      toast(
        "This draft changed in another tab. Finish or copy your current input, then refresh before editing it.",
        true,
      );
  }
});
window.addEventListener("beforeunload", (event) => {
  let unprotected = hasUnsavedDraftNotes();
  try {
    unprotected ||= !!(
      draftSync?.hasUnsaved() ||
      ws?.pending().length ||
      (!draftSync &&
        ws?.listDrafts().some((item) => item.syncState !== "synced"))
    );
  } catch {
    unprotected = true;
  }
  if (unprotected) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  toast(friendlyError(event.reason), true);
});
boot();

async function readImageFile(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size > 5 * 1024 * 1024)
    throw new Error("The photo must be smaller than 5 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { mimeType: file.type, data: btoa(binary) };
}
function showAllocation(payment) {
  const m = modal(
    "Allocate verified payment",
    `${cash(payment.amountCents)} · ${storeById(payment.storeId)?.name}`,
    true,
  );
  const orders = state.orders.filter(
    (order) =>
      order.storeId === payment.storeId &&
      order.invoiceNumber &&
      order.status !== "cancelled" &&
      !order.legacy?.needsPriceReview,
  );
  const rows = orders.map((order) => ({
    order,
    amount: input(
      "number",
      (payment.allocations || []).find((a) => a.orderId === order.id)
        ?.amountCents / 100 || "",
      {
        min: 0,
        step: ".01",
        placeholder: "0.00",
        "aria-label": `Amount applied to ${order.invoiceNumber}`,
      },
    ),
  }));
  const preserved = (payment.allocations || []).filter(
    (a) => !orders.some((order) => order.id === a.orderId),
  );
  append(
    m.content,
    notice(
      "Allocate this verified payment to specific invoices. The total cannot exceed the payment amount; unallocated funds remain a credit on the customer account.",
    ),
    preserved.length
      ? notice(
          `${preserved.length} allocations to older invoices will be preserved. Load older orders first to edit those allocations.`,
        )
      : null,
    table(
      ["Invoice", "Current due", "Apply ($)"],
      rows.map(({ order, amount }) =>
        el(
          "tr",
          {},
          td(order.invoiceNumber),
          td(
            order.amountDueCents == null
              ? "Unavailable"
              : cash(order.amountDueCents),
          ),
          td(amount),
        ),
      ),
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save allocations",
      async () => {
        const allocations = [...preserved];
        for (const row of rows) {
          const amountCents = numberCents(
            row.amount.value || "0",
            `${row.order.invoiceNumber} allocation`,
          );
          if (amountCents)
            allocations.push({ orderId: row.order.id, amountCents });
        }
        if (
          allocations.reduce((sum, a) => sum + a.amountCents, 0) >
          payment.amountCents
        )
          throw new Error("Allocated amounts cannot exceed this payment.");
        await command("payment.allocate", {
          paymentId: payment.id,
          allocations,
          expectedVersion: payment.version,
        });
        m.close();
        toast("Payment allocations confirmed.");
      },
      "primary",
    ),
  );
}

async function showLegacyDeviceDraft() {
  const scope = operationScope();
  let original, data;
  try {
    original = JSON.parse(
      localStorage.getItem("alwholesale_order_v1") || "null",
    );
    data = JSON.parse(localStorage.getItem("alwholesale_data_v1") || "null");
  } catch {
    throw new Error(
      "The older device draft could not be read. Its storage has not been changed.",
    );
  }
  if (!original?.lines?.length)
    throw new Error("No older device draft was found in this browser.");
  const legacyStoreId = original.storeId || data?.currentStoreId;
  if (!state.stores.some((store) => store.id === legacyStoreId))
    throw new Error(
      "The older draft belongs to a store that is not assigned to this account. Sign in with an authorized account to recover it.",
    );
  const converted = recoverLegacyLines(original, state.products);
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(original)),
  );
  const fingerprint = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!scopeCurrent(scope)) throw new SessionChanged();
  const existing = scope.workspace
    .listDrafts()
    .find((item) => item.legacyDeviceFingerprint === fingerprint);
  if (existing) {
    changeStore(existing.storeId);
    draft = existing;
    setView("build");
    toast("This older device draft has already been recovered.");
    return;
  }
  const m = modal(
    "Recover older device draft",
    storeById(legacyStoreId)?.name,
    true,
  );
  const checked = input("checkbox", "", { checked: false });
  append(
    m.content,
    notice(
      "The original device storage will be preserved. Review the converted lines, especially any quantities or units marked below.",
    ),
    ...converted.warnings.map((warning) => notice(warning)),
    lineTable(
      converted.lines.map((line) => ({ ...line, id: uuid() })),
      true,
    ),
    el(
      "details",
      { class: "mt" },
      el("summary", {}, "Original draft content"),
      el("pre", { class: "history-note" }, JSON.stringify(original, null, 2)),
    ),
    el(
      "label",
      { class: "check-field mt" },
      checked,
      "I reviewed the recovered products, quantities, variants and units.",
    ),
  );
  append(
    m.footer,
    button("Export original", () =>
      download(
        "alabama-original-device-draft.json",
        JSON.stringify(original, null, 2),
      ),
    ),
    button(
      "Recover as local draft",
      () => {
        if (!scopeCurrent(scope)) throw new SessionChanged();
        if (!checked.checked)
          throw new Error("Review and acknowledge the recovered draft first.");
        if (!converted.lines.length)
          throw new Error(
            "No valid lines could be recovered. Export the original and rebuild its products manually.",
          );
        const notes = [
          original.notes,
          original.creditsReturns,
          converted.warnings.length
            ? "Recovered draft review notes: " + converted.warnings.join(" ")
            : "",
          converted.warnings.length
            ? "Original draft preserved: " + JSON.stringify(original)
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        changeStore(legacyStoreId);
        draft = saveWorkingDraft({
          ...createDraft(legacyStoreId),
          lines: converted.lines.map((line) => ({ ...line, id: uuid() })),
          notes,
          legacyDeviceFingerprint: fingerprint,
          legacy: { requiresReview: true },
        });
        scope.workspace.rememberPreferences({
          activeDraftIds: {
            ...preferences().activeDraftIds,
            [storeId]: draft.id,
          },
        });
        m.close();
        setView("build");
        toast("Older device draft recovered. Review it before syncing.");
      },
      "primary",
    ),
  );
}

function showManageAccess(user) {
  const m = modal("Manage account access", user.email, true);
  const role = select(
    [
      ["customer", "Customer"],
      ["salesman", "Salesperson"],
      ["master", "Administrator"],
    ],
    user.role,
  );
  const active = input("checkbox", "", { checked: user.active !== false });
  const stores = el(
    "div",
    { class: "stack" },
    state.stores.map((store) =>
      el(
        "label",
        { class: "check-field" },
        input("checkbox", store.id, {
          checked: user.storeIds?.includes(store.id),
        }),
        store.name,
      ),
    ),
  );
  append(
    m.content,
    field("Account role", role),
    el("label", { class: "check-field mt" }, active, "Account is active"),
    el("h3", { class: "mt mb" }, "Assigned stores"),
    stores,
    notice(
      "Administrators can manage all stores. Disabling an account prevents its future API access. The configured owner account is protected.",
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Save access",
      async () => {
        const storeIds = [...stores.querySelectorAll("input:checked")].map(
          (input) => input.value,
        );
        if (role.value !== "master" && !storeIds.length)
          throw new Error("Assign at least one store.");
        const result = await api(
          `/api/users/${encodeURIComponent(user.uid || user.id)}/access`,
          {
            method: "POST",
            body: {
              role: role.value,
              storeIds,
              active: active.checked,
              expectedVersion: user.version,
            },
          },
        );
        await afterConfirmation(
          result,
          () => refresh(),
          () =>
            toast(
              "Access changes were confirmed. Refresh to see the latest account list.",
              true,
            ),
        );
        m.close();
        toast("Account access updated.");
      },
      "primary",
    ),
  );
}
async function showEmailDelivery() {
  const data = await api("/api/admin/notifications");
  const m = modal(
    "Email delivery status",
    data.configured
      ? `Sending from ${data.from}`
      : "A sending service has not been connected.",
    true,
  );
  append(
    m.content,
    notice(
      data.configured
        ? "Delivery attempts are tracked below. Uncertain deliveries need manual verification before retrying."
        : "In-app notifications work now. Email updates remain queued until the owner connects an email sender.",
    ),
    table(
      ["Created", "Recipient", "Status", "Details"],
      (data.outbox || []).map((item) =>
        el(
          "tr",
          {},
          td(date(item.createdAt)),
          td(item.to || item.email || item.recipient || "Recipient not set"),
          td(status(item.status)),
          td(
            item.error || item.lastError || item.subject || item.message || "",
            item.status === "uncertain" || item.status === "failed"
              ? button(
                  "Review retry",
                  () => showEmailRetry(item),
                  "text-button",
                )
              : null,
          ),
        ),
      ),
    ),
  );
  append(
    m.footer,
    button("Close", m.close),
    data.configured
      ? button(
          "Deliver queued updates",
          async () => {
            if (
              !(await confirmAction(
                "Send queued email updates?",
                "This will send pending order and account emails to the recipients shown in the delivery queue.",
                "Send pending updates",
              ))
            )
              return;
            const result = await api("/api/admin/notifications/deliver", {
              method: "POST",
              body: {},
            });
            m.content.replaceChildren(reportBlock(result));
            m.footer.replaceChildren(
              button("Close", m.close),
              button("Refresh delivery status", () => {
                m.close();
                return showEmailDelivery();
              }),
            );
          },
          "primary",
        )
      : null,
  );
}
function showEmailRetry(item) {
  const m = modal(
    "Review email retry",
    "Verify whether the recipient already received the message before retrying an uncertain delivery.",
  );
  const reason = el("textarea", {
    maxlength: 2000,
    placeholder: "Record the verification and reason for retrying.",
  });
  const acknowledgment = input("checkbox", "", { checked: false });
  append(
    m.content,
    field("Reason for retry", reason),
    el(
      "label",
      { class: "check-field mt" },
      acknowledgment,
      "I checked the delivery status and understand a retry could send a duplicate.",
    ),
  );
  append(
    m.footer,
    button("Cancel", m.close),
    button(
      "Queue retry",
      async () => {
        if (!reason.value.trim() || !acknowledgment.checked)
          throw new Error(
            "Add a reason and acknowledge the duplicate-delivery risk.",
          );
        await api(
          `/api/admin/notifications/${encodeURIComponent(item.id)}/retry`,
          {
            method: "POST",
            body: {
              reason: reason.value.trim(),
              acknowledgeDuplicateRisk: true,
            },
          },
        );
        m.close();
        toast("Email retry queued.");
      },
      "primary",
    ),
  );
}

async function showOrderEmailSettings() {
  const scope = operationScope();
  const m = modal(
    "Order email settings",
    "Invoices go directly to alwholesaleorders@gmail.com, even when the app is closed.",
  );
  async function read() {
    const settings = await api("/api/order-email/config");
    if (!scopeCurrent(scope) || !m.dialog.open) return;
    draw(settings);
  }
  function draw(settings) {
    m.content.replaceChildren(
      notice(
        settings.configured
          ? "Dedicated sender connected. New submitted orders can be emailed automatically five minutes after submission. You can change the time or cancel from the order."
          : "The dedicated Gmail sender still needs to be connected by the workspace owner. Sending becomes available once its account verification is complete.",
      ),
    );
    const automatic = input("checkbox", "", {
      checked: settings.automatic,
      disabled: !settings.configured,
    });
    append(
      m.content,
      field(
        "Automatically email new submitted orders",
        automatic,
        "Existing orders are never sent in bulk when this setting is enabled.",
      ),
    );
    automatic.addEventListener("change", () =>
      act(async () => {
        if (!scopeCurrent(scope)) throw new SessionChanged();
        try {
          const saved = await api("/api/admin/order-email/settings", {
            method: "POST",
            body: {
              automatic: automatic.checked,
              expectedVersion: settings.version,
            },
          });
          if (!scopeCurrent(scope) || !m.dialog.open) return;
          draw(saved);
          toast("Order email setting saved.");
        } catch (error) {
          automatic.checked = settings.automatic;
          // A lost response may still have saved; resolve it before showing the setting.
          await read().catch(() => {});
          if (scopeCurrent(scope) && m.dialog.open && !automatic.isConnected) {
            const message = notice(friendlyError(error), true);
            message.classList.add("action-error");
            append(m.content, message);
          }
          throw error;
        }
      }, automatic),
    );
  }
  append(
    m.footer,
    button("Close", m.close),
    button("Refresh connection", read),
  );
  await read();
}
async function showOrderEmail(order) {
  const scope = operationScope();
  const m = modal(
    "Send order email",
    `Invoice ${order.invoiceNumber} · alwholesaleorders@gmail.com`,
  );
  let current,
    selectedTime = "",
    pending = null;
  const read = async () => {
    const result = await api(
      `/api/orders/${encodeURIComponent(order.id)}/email`,
    );
    if (!scopeCurrent(scope) || !m.dialog.open) return;
    current = result;
    draw();
  };
  async function change(action, extra = {}) {
    if (!scopeCurrent(scope)) throw new SessionChanged();
    const signature = JSON.stringify([
      action,
      extra,
      current.job?.version || 0,
    ]);
    if (pending?.signature !== signature)
      pending = {
        signature,
        body: {
          requestId: uuid(),
          action,
          expectedVersion: current.job?.version || 0,
          ...extra,
        },
      };
    try {
      const result = await api(
        `/api/orders/${encodeURIComponent(order.id)}/email`,
        {
          method: "POST",
          body: pending.body,
        },
      );
      pending = null;
      if (!scopeCurrent(scope) || !m.dialog.open) return;
      current = { ...current, job: result.job };
      draw();
    } catch (error) {
      // Keep the exact request available on network failure; refresh resolves a lost response.
      await read().catch(() => {});
      throw error;
    }
  }
  function draw() {
    const { job, config: settings } = current;
    const labels = {
      queued: "Scheduled",
      preparing: "Preparing invoice",
      sending: "Sending",
      sent: "Accepted by email provider",
      failed: "Email failed",
      uncertain: "Delivery needs review",
      cancelled: "Cancelled",
    };
    m.content.replaceChildren(
      el(
        "p",
        { role: "status", class: "strong" },
        job
          ? labels[job.status] || titleCase(job.status)
          : "No email scheduled",
      ),
      el(
        "p",
        { class: "small" },
        "The invoice PDF is attached. The order remains saved online regardless of email delivery.",
      ),
    );
    if (job?.scheduledAt && ["queued", "preparing"].includes(job.status))
      append(
        m.content,
        el(
          "p",
          {},
          `Scheduled for ${new Date(job.scheduledAt).toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
        ),
      );
    if (job?.sentAt)
      append(
        m.content,
        el(
          "p",
          {},
          `Provider accepted at ${new Date(job.sentAt).toLocaleString()}. This does not confirm inbox delivery.`,
        ),
      );
    if (!settings.configured)
      append(
        m.content,
        notice(
          "The dedicated Gmail sender is not connected yet. The owner must finish its setup before emails can be sent.",
        ),
      );
    if (job?.lastError)
      append(
        m.content,
        notice(
          typeof job.lastError === "string"
            ? job.lastError
            : typeof job.lastError.message === "string"
              ? job.lastError.message
              : "The email could not be sent. Refresh its status before retrying.",
          true,
        ),
      );
    const available =
      !job || ["queued", "preparing", "cancelled"].includes(job.status);
    if (available) {
      const initial = new Date(
        job?.scheduledAt > Date.now() ? job.scheduledAt : Date.now() + 3600000,
      );
      const local = new Date(
        initial.getTime() - initial.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .slice(0, 16);
      const when = input("datetime-local", selectedTime || local, {
        "aria-label": "Email date and time",
        disabled: !settings.configured,
      });
      when.addEventListener("input", () => {
        selectedTime = when.value;
      });
      append(
        m.content,
        field("Send at your local date and time", when),
        el(
          "div",
          { class: "actions mt" },
          el(
            "button",
            {
              type: "button",
              disabled: !settings.configured,
              onClick: (event) =>
                act(() => change("send"), event.currentTarget),
            },
            "Send now",
          ),
          el(
            "button",
            {
              type: "button",
              class: "primary",
              disabled: !settings.configured,
              onClick: (event) =>
                act(async () => {
                  const scheduledAt = new Date(when.value).getTime();
                  if (
                    !Number.isSafeInteger(scheduledAt) ||
                    scheduledAt <= Date.now()
                  )
                    throw new Error("Choose a future date and time.");
                  await change("schedule", { scheduledAt });
                }, event.currentTarget),
            },
            job && job.status !== "cancelled"
              ? "Change scheduled time"
              : "Schedule email",
          ),
          job && ["queued", "preparing"].includes(job.status)
            ? button("Cancel email", () => change("cancel"))
            : null,
        ),
      );
    }
    if (job?.status === "failed" && settings.configured)
      append(
        m.content,
        button("Retry email", () => change("retry")),
      );
    if (job?.status === "uncertain") {
      append(
        m.content,
        notice(
          "The provider may already have sent this email. Check the sender’s Sent folder before retrying.",
        ),
      );
      if (master() && settings.configured)
        append(
          m.content,
          button("Review and retry", async () => {
            if (
              await confirmAction(
                "Retry an uncertain email?",
                "Check the sender’s Sent folder first. Retrying can send a duplicate invoice email.",
                "I checked · retry email",
              )
            )
              await change("retry", { acknowledgeDuplicateRisk: true });
          }),
        );
    }
  }
  append(
    m.footer,
    button("Close", m.close),
    button("Refresh email status", read),
  );
  m.content.replaceChildren(
    el("p", { role: "status" }, "Loading email status…"),
  );
  await read();
}
