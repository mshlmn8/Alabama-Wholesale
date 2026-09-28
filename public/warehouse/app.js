import * as firebase from "../firebase.js";
import { createWarehouseDeviceState, WAREHOUSE_VIEWS } from "./helpers.js";
import { createWarehouseScreens } from "./screens.js";
let data = null,
  device = null,
  generation = 0,
  view = "overview",
  busy = false,
  lastUpdated = null;
const app = document.getElementById("app");
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on"))
      node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (["value", "checked", "disabled"].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false)
      node.append(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
  }
  return node;
}
const scope = () => ({ generation, uid: firebase.identity()?.uid });
const isCurrent = (saved) =>
  saved.generation === generation && saved.uid === firebase.identity()?.uid;
function ensure(saved) {
  if (!isCurrent(saved))
    throw new Error("The signed-in account changed. Reopen this action.");
}
function notice(text, error = false) {
  return el(
    "div",
    { class: `notice${error ? " error" : ""}`, role: error ? "alert" : "note" },
    text,
  );
}
function toast(message, error = false) {
  const node = notice(message, error);
  document.getElementById("toasts").append(node);
  setTimeout(() => node.remove(), error ? 14000 : 6500);
}
function button(label, action, kind = "") {
  return el(
    "button",
    {
      type: "button",
      class: kind,
      onClick: async (event) => {
        const node = event.currentTarget;
        if (node.disabled) return;
        node.disabled = true;
        node.setAttribute("aria-busy", "true");
        try {
          await action();
        } catch (error) {
          const modalBody = node
            .closest("dialog")
            ?.querySelector(".dialog-content");
          if (modalBody) {
            modalBody.querySelector(".action-error")?.remove();
            const errorNode = notice(error.message, true);
            errorNode.classList.add("action-error");
            modalBody.append(errorNode);
          }
          toast(error.message || "The action could not be completed.", true);
        } finally {
          if (node.isConnected) {
            node.disabled = false;
            node.removeAttribute("aria-busy");
          }
        }
      },
    },
    label,
  );
}
function input(type = "text", value = "", attrs = {}) {
  return el("input", { type, value, autocomplete: "off", ...attrs });
}
function field(label, node, help) {
  node.id ||= `field-${crypto.randomUUID()}`;
  const hint = help
    ? el("p", { id: node.id + "-hint", class: "small muted" }, help)
    : null;
  if (hint) node.setAttribute("aria-describedby", hint.id);
  return el(
    "div",
    { class: "field" },
    el("label", { for: node.id }, label),
    node,
    hint,
  );
}
function select(choices, value = "", attrs = {}) {
  const node = el(
    "select",
    attrs,
    choices.map(([id, label]) => el("option", { value: id }, label)),
  );
  node.value = value;
  return node;
}
function modal(title, description = "") {
  const captured = scope(),
    previous = document.activeElement;
  const dialog = el("dialog", {
    "aria-labelledby": `modal-${crypto.randomUUID()}`,
  });
  const heading = el(
    "h2",
    { id: dialog.getAttribute("aria-labelledby") },
    title,
  );
  const content = el("div", { class: "dialog-content" }),
    footer = el("div", { class: "dialog-footer" });
  const close = () => dialog.close();
  dialog.append(
    el(
      "header",
      { class: "dialog-header" },
      el("div", {}, heading, el("p", {}, description)),
      button("Close", close, "subtle"),
    ),
    content,
    footer,
  );
  document.body.append(dialog);
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (previous?.isConnected) previous.focus();
    },
    { once: true },
  );
  dialog.showModal();
  return {
    dialog,
    content,
    footer,
    close,
    guard: () => {
      ensure(captured);
      if (!dialog.open) throw new Error("Reopen this action.");
    },
  };
}
async function api(path, { method = "GET", body, blob = false } = {}) {
  const captured = scope();
  if (!navigator.onLine)
    throw Object.assign(
      new Error(
        "You are offline. Reconnect before changing warehouse records.",
      ),
      { code: "NETWORK" },
    );
  const headers = await firebase.credentials(false, firebase.identity());
  ensure(captured);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      throw Object.assign(
        new Error(
          "The server did not confirm this action. Check your connection and retry the same action.",
        ),
        { code: "NETWORK" },
      );
    }
    ensure(captured);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw Object.assign(
        new Error(
          result.error?.message || "The request could not be completed.",
        ),
        { status: response.status, code: result.error?.code },
      );
    }
    const result = blob ? await response.blob() : await response.json();
    ensure(captured);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
async function refresh() {
  const captured = scope();
  const result = await api("/api/warehouse/state");
  ensure(captured);
  if (
    result.me?.uid !== captured.uid ||
    !["master", "salesman"].includes(result.me?.role)
  )
    throw new Error("Staff access could not be verified.");
  data = result;
  lastUpdated = Date.now();
  render();
  return result;
}
async function sendPending(pending) {
  const captured = scope(),
    capturedDevice = device;
  if (busy) throw new Error("Wait for the current action to finish.");
  if (!navigator.onLine)
    throw new Error("Reconnect before sending this action.");
  busy = true;
  try {
    const result = await api("/api/commands", {
      method: "POST",
      body: pending,
    });
    ensure(captured);
    capturedDevice.clearPending(pending);
    try {
      await refresh();
    } catch (error) {
      if (isCurrent(captured)) {
        render();
        toast(
          "Action confirmed online. Refresh the workspace before making another change.",
          true,
        );
      } else throw error;
    }
    return result.result;
  } catch (error) {
    if (
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 429].includes(error.status)
    )
      capturedDevice.clearPending(pending);
    if (isCurrent(captured)) render();
    throw error;
  } finally {
    if (isCurrent(captured)) busy = false;
  }
}
async function command(type, payload) {
  if (!device || !data) throw new Error("Sign in to the warehouse first.");
  if (!navigator.onLine) throw new Error("Reconnect before saving changes.");
  const pending = { id: crypto.randomUUID(), type, payload };
  device.savePending(pending);
  return sendPending(pending);
}
function navigate(next) {
  if (!WAREHOUSE_VIEWS.includes(next)) return;
  view = next;
  try {
    device?.setView(next);
  } catch {
    toast("The selected tab could not be remembered on this device.", true);
  }
  history.replaceState({}, "", `/warehouse/#/${next}`);
  render();
  document.getElementById("page-title")?.focus();
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob),
    link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const screens = createWarehouseScreens({
  el,
  input,
  field,
  select,
  button,
  modal,
  notice,
  toast,
  api,
  command,
  refresh,
  navigate,
  getData: () => data,
  scope,
  isCurrent,
  download,
});
function render() {
  if (!data) return;
  const owner = data.me.role === "master";
  const tabs = [
    ["overview", "Overview"],
    ["stock", "Stock"],
    ["purchasing", "Purchasing"],
    ["receive", "Receive"],
    ...(owner ? [["suppliers", "Suppliers"]] : []),
  ];
  if (!tabs.some(([id]) => id === view)) view = "overview";
  const nav = el(
    "nav",
    { "aria-label": "Operations navigation" },
    tabs.map(([id, label]) =>
      button(label, () => navigate(id), view === id ? "active" : ""),
    ),
  );
  for (const [id] of tabs) {
    const btn = [...nav.children][tabs.findIndex(([value]) => value === id)];
    if (id === view) btn.setAttribute("aria-current", "page");
  }
  const sidebar = el(
    "aside",
    { class: "sidebar" },
    el(
      "a",
      { href: "/warehouse/", class: "brand" },
      el("span", { class: "brand-mark" }, "AW"),
      el("span", {}, "Alabama Wholesale", el("small", {}, "OPERATIONS")),
    ),
    nav,
    el(
      "div",
      { class: "sidebar-bottom" },
      el("p", {}, data.me.name || data.me.uid),
      el("small", {}, owner ? "Owner workspace" : "Staff workspace"),
      button("Sign out", () => firebase.logout(), "subtle"),
    ),
  );
  const main = el(
    "main",
    { id: "main" },
    el(
      "header",
      { class: "workspace-top" },
      el("p", { class: "eyebrow" }, "WAREHOUSE / OPERATIONS"),
      el(
        "div",
        { class: "top-actions" },
        el(
          "span",
          { class: "connection" },
          navigator.onLine ? "Online" : "Offline",
        ),
        button("Refresh", refresh, "subtle"),
      ),
    ),
  );
  if (!navigator.onLine)
    main.append(
      notice(
        "Offline · Showing the last confirmed view. All changes require an online confirmation.",
      ),
    );
  if (data.history?.complete === false)
    main.append(
      notice(
        "History is incomplete. Check the source purchase order before relying on totals or suggestions.",
      ),
    );
  try {
    const pending = device.pending();
    if (pending)
      main.append(
        el(
          "div",
          { class: "notice pending", role: "status" },
          el(
            "div",
            {},
            el("strong", {}, "One action needs confirmation"),
            el("p", {}, `${pending.type} · Retry uses the same request ID.`),
          ),
          button("Retry pending action", () => sendPending(pending)),
        ),
      );
  } catch (error) {
    main.append(notice(error.message, true));
  }
  main.append(screens.render(view));
  main.append(
    el(
      "footer",
      { class: "workspace-footer" },
      lastUpdated
        ? `Confirmed view updated ${new Date(lastUpdated).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "",
      el("a", { href: "/" }, "Open ordering app"),
    ),
  );
  app.replaceChildren(el("div", { class: "workspace" }, sidebar, main));
}
function authScreen(message = "") {
  const email = input("email", "", {
      required: true,
      autocomplete: "username",
    }),
    password = input("password", "", {
      required: true,
      autocomplete: "current-password",
    });
  const form = el(
    "form",
    {
      onSubmit: (event) => {
        event.preventDefault();
        signIn.click();
      },
    },
    el("span", { class: "eyebrow" }, "ALABAMA WHOLESALE"),
    el("h1", {}, "Operations, in order."),
    el("p", {}, "Inventory, suppliers and receiving in one staff workspace."),
    message ? notice(message, true) : null,
    field("Email address", email),
    field("Password", password),
  );
  const signIn = button(
    "Sign in",
    () => firebase.signInEmail(email.value.trim(), password.value),
    "primary",
  );
  form.append(
    signIn,
    button("Continue with Google", () => firebase.signInGoogle(), "secondary"),
  );
  app.replaceChildren(
    el(
      "main",
      { id: "main", class: "auth-screen" },
      el(
        "div",
        { class: "auth-intro" },
        el(
          "div",
          { class: "warehouse-illustration", "aria-hidden": "true" },
          el("span", {}, "AW"),
        ),
        el("p", { class: "eyebrow" }, "RECEIVE WITH CONFIDENCE"),
        el("h2", {}, "Know what is here.\nKnow what is coming."),
        el(
          "p",
          {},
          "Shared stock, confirmed receipts and clear supplier commitments.",
        ),
      ),
      form,
    ),
  );
}
async function onIdentity(user) {
  const currentGeneration = ++generation;
  data = null;
  device = null;
  busy = false;
  document.querySelectorAll("dialog").forEach((dialog) => dialog.close());
  app.replaceChildren(
    el(
      "main",
      { id: "main", class: "loading" },
      el("h1", {}, "Opening operations"),
      el("p", {}, "Verifying staff access…"),
    ),
  );
  if (!user) {
    authScreen();
    return;
  }
  try {
    device = createWarehouseDeviceState(localStorage, user.uid);
    view = location.hash.startsWith("#/")
      ? location.hash.slice(2)
      : device.getView();
    await refresh();
  } catch (error) {
    if (currentGeneration !== generation) return;
    data = null;
    app.replaceChildren(
      el(
        "main",
        { id: "main", class: "loading" },
        el("h1", {}, "Operations unavailable"),
        notice(error.message, true),
        button("Try again", () => onIdentity(firebase.identity()), "primary"),
        button("Sign out", () => firebase.logout(), "secondary"),
      ),
    );
  }
}
window.addEventListener("online", () => {
  if (data) render();
});
window.addEventListener("offline", () => {
  if (data) render();
});
window.addEventListener("hashchange", () => {
  if (data) navigate(location.hash.slice(2));
});
async function start() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok)
      throw new Error("Workspace configuration is unavailable.");
    await firebase.initializeIdentity(await response.json(), onIdentity);
    if ("serviceWorker" in navigator)
      await navigator.serviceWorker
        .register("/warehouse/sw.js", { scope: "/warehouse/" })
        .catch(() => {});
  } catch (error) {
    authScreen(error.message);
  }
}
void start();
