import { indexCatalogProducts, rankCatalogProducts } from "./view-helpers.js";

const MAX_VISIBLE_JOBS = 100;
const LABELS = {
  queued: "Queued",
  processing: "Finding a photo",
  applied: "Photo added",
  needs_review: "Needs review",
  failed: "Check failed",
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export function createProductPhotos({
  request,
  getScope,
  isCurrent,
  onApplied,
}) {
  let elements = null;
  let scope = null;
  let state = null;
  let timer = null;
  let readController = null;
  let mutationController = null;
  let generation = 0;
  let readSequence = 0;
  let working = false;
  let observedApplied = null;
  let disposed = false;
  let fieldSequence = 0;
  let page = 0;
  const rows = new Map();
  const sourceDrafts = new Map();

  function current(captured = scope) {
    return (
      !disposed && !!elements?.dialog.open && !!captured && isCurrent(captured)
    );
  }

  function reset() {
    generation++;
    readSequence++;
    readController?.abort();
    mutationController?.abort();
    readController = mutationController = null;
    clearInterval(timer);
    timer = null;
    working = false;
    state = null;
    scope = null;
    observedApplied = null;
    page = 0;
    rows.clear();
    sourceDrafts.clear();
    const dialog = elements?.dialog;
    elements = null;
    if (dialog?.open) dialog.close();
    dialog?.remove();
  }

  function showError(message) {
    if (!elements) return;
    elements.error.textContent = String(
      message || "Could not load product photos.",
    ).slice(0, 400);
    elements.error.hidden = false;
  }

  function count(name) {
    const value = Number(state?.counts?.[name]);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function setWorking(value) {
    working = value;
    if (!elements) return;
    elements.dialog
      .querySelectorAll("button[data-photo-action]")
      .forEach((button) => {
        button.disabled = value || !state?.configured;
      });
    elements.dialog.querySelectorAll("input").forEach((input) => {
      input.disabled = value;
    });
    elements.queue.disabled =
      value || !state?.configured || count("missing") === 0;
    elements.refresh.disabled = value || !!readController;
    elements.status.textContent = value ? "Saving photo request…" : "";
  }

  async function refresh() {
    if (!elements || document.hidden || working || readController) return;
    if (!current()) {
      reset();
      return;
    }
    const captured = scope;
    const attempt = ++readSequence;
    const viewGeneration = generation;
    const controller = new AbortController();
    readController = controller;
    elements.refresh.disabled = true;
    try {
      const result = await request("/api/admin/product-photos", {
        signal: controller.signal,
      });
      if (attempt !== readSequence || viewGeneration !== generation) return;
      if (!current(captured)) {
        reset();
        return;
      }
      if (!result || !result.counts || !Array.isArray(result.jobs))
        throw new Error(
          "Product photo status was incomplete. Please refresh it.",
        );
      state = result;
      elements.error.hidden = true;
      render();
      const applied = count("applied");
      if (applied !== observedApplied) {
        observedApplied = applied;
        if (applied > 0)
          Promise.resolve()
            .then(() => {
              if (current(captured)) return onApplied?.();
            })
            .catch(() => {});
      }
    } catch (error) {
      if (attempt !== readSequence || viewGeneration !== generation) return;
      if (!current(captured)) {
        reset();
        return;
      }
      showError(
        error?.code === "NETWORK"
          ? "Could not refresh photo status. Check your connection and try again."
          : error?.message,
      );
    } finally {
      if (attempt === readSequence && viewGeneration === generation) {
        readController = null;
        if (elements) elements.refresh.disabled = working;
      }
    }
  }

  async function submit(body) {
    if (working || !state?.configured) return;
    if (!current()) {
      reset();
      return;
    }
    readSequence++;
    readController?.abort();
    readController = null;
    const captured = scope;
    const viewGeneration = generation;
    const controller = new AbortController();
    mutationController = controller;
    elements.error.hidden = true;
    setWorking(true);
    try {
      await request("/api/admin/product-photos", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (viewGeneration !== generation) return;
      if (!current(captured)) {
        reset();
        return;
      }
      setWorking(false);
      elements.status.textContent =
        "Request saved. Checking the latest photo status…";
      await refresh();
      if (current(captured) && viewGeneration === generation)
        elements.status.textContent = "Photo request saved.";
    } catch (error) {
      if (viewGeneration !== generation) return;
      if (!current(captured)) {
        reset();
        return;
      }
      setWorking(false);
      showError(
        error?.message || "Could not save the photo request. Please try again.",
      );
    } finally {
      if (viewGeneration === generation) mutationController = null;
    }
  }

  function createRow(job) {
    const row = node("article", "photo-job");
    const heading = node("div", "photo-job-heading");
    const name = node("h3");
    const status = node("span", "photo-job-status");
    heading.append(name, status);
    const message = node("p", "photo-job-message");
    const link = node("a", "photo-job-source", "View source page");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const controls = node("div", "photo-job-controls");
    const retry = node("button", "", "Try again");
    retry.type = "button";
    retry.dataset.photoAction = "retry";
    retry.addEventListener("click", () =>
      submit({ action: "retry", productId: job.productId }),
    );
    const form = node("form", "photo-job-source-form");
    const label = node("label", "", "Manufacturer or supplier product page");
    const input = node("input");
    input.id = `photo-source-${++fieldSequence}`;
    input.type = "url";
    input.inputMode = "url";
    input.maxLength = 2048;
    input.placeholder = "https://…";
    input.value = sourceDrafts.get(job.productId) || "";
    input.required = true;
    input.autocomplete = "off";
    input.setAttribute("autocapitalize", "none");
    input.setAttribute("spellcheck", "false");
    label.htmlFor = input.id;
    const find = node("button", "primary", "Find photo");
    find.type = "submit";
    find.dataset.photoAction = "source";
    const entry = node("div", "photo-job-source-entry");
    entry.append(input, find);
    form.append(label, entry);
    input.addEventListener("input", () => {
      input.setCustomValidity("");
      sourceDrafts.set(job.productId, input.value);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const sourcePage = sourceUrl(input.value.trim());
      if (!sourcePage) {
        input.setCustomValidity("Enter a product page starting with https://.");
        input.reportValidity();
        return;
      }
      input.setCustomValidity("");
      submit({ action: "source", productId: job.productId, sourcePage });
    });
    controls.append(retry, form);
    row.append(heading, message, link, controls);
    return { row, name, status, message, link, controls, input };
  }

  function render() {
    if (!elements || !state) return;
    elements.summary.textContent = state.configured
      ? state.automatic
        ? "New products are checked automatically. Gemini matches real product photos, and uncertain matches stay here for review."
        : "Gemini matches real product photos. Uncertain matches stay here for review."
      : "Automatic photo matching is not connected yet.";
    elements.countPhoto.textContent = count("withPhoto").toLocaleString();
    elements.countMissing.textContent = count("missing").toLocaleString();
    elements.countProgress.textContent = (
      count("queued") + count("processing")
    ).toLocaleString();
    let jobs = state.jobs.filter(
      (job) => job && typeof job.productId === "string",
    );
    const order = {
      needs_review: 0,
      failed: 1,
      processing: 2,
      queued: 3,
      applied: 4,
    };
    jobs.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
    const query = elements.search.value.trim();
    if (query)
      jobs = rankCatalogProducts(
        indexCatalogProducts(
          jobs.map((job) => ({ ...job, id: job.productId })),
        ),
        query,
      );
    const pages = Math.max(1, Math.ceil(jobs.length / MAX_VISIBLE_JOBS));
    page = Math.min(page, pages - 1);
    const first = page * MAX_VISIBLE_JOBS;
    const visible = jobs.slice(first, first + MAX_VISIBLE_JOBS);
    const ids = new Set(visible.map((job) => job.productId));
    for (const [id, item] of rows) {
      if (!ids.has(id)) {
        item.row.remove();
        rows.delete(id);
      }
    }
    for (const job of visible) {
      let item = rows.get(job.productId);
      if (!item) {
        item = createRow(job);
        rows.set(job.productId, item);
      }
      item.name.textContent = job.name || "Unnamed product";
      item.status.textContent = LABELS[job.status] || "Pending review";
      item.status.dataset.status = Object.hasOwn(LABELS, job.status)
        ? job.status
        : "needs_review";
      item.message.textContent =
        job.message ||
        {
          queued: "Waiting for the next photo check.",
          processing: "Checking the product and its source image.",
          applied: "The matched photo is available in the catalog.",
          needs_review:
            "Add a manufacturer or supplier product page to help confirm the right photo.",
          failed:
            "This photo check could not finish. Try again or add a product page.",
        }[job.status] ||
        "This product needs another look.";
      const url = sourceUrl(job.sourcePage);
      item.link.hidden = !url;
      if (url) item.link.href = url;
      else item.link.removeAttribute("href");
      item.controls.hidden = !["needs_review", "failed"].includes(job.status);
      if (!item.row.isConnected) elements.jobs.append(item.row);
    }
    // Existing rows stay mounted while the owner edits a source URL.
    elements.empty.hidden = !!visible.length;
    elements.empty.textContent = query
      ? "No photo checks match this search."
      : count("missing")
        ? "Start a photo check for products that still need a picture."
        : "Your active products have photos. New checks will appear here.";
    elements.listNote.textContent =
      jobs.length > visible.length
        ? `Showing ${first + 1}–${first + visible.length} of ${jobs.length} photo checks.`
        : `${visible.length} photo check${visible.length === 1 ? "" : "s"}. Status updates automatically.`;
    elements.pagination.hidden = pages === 1;
    elements.previous.disabled = page === 0;
    elements.next.disabled = page === pages - 1;
    elements.pageLabel.textContent = `${page + 1} / ${pages}`;
    elements.pageLabel.setAttribute(
      "aria-label",
      `Page ${page + 1} of ${pages}`,
    );
    setWorking(working);
  }

  function open() {
    if (disposed) return;
    if (elements && current()) return;
    reset();
    const captured = getScope();
    if (!captured || !isCurrent(captured)) return;
    scope = captured;
    const previousFocus = document.activeElement;
    const dialog = node("dialog", "photo-manager");
    dialog.setAttribute("aria-labelledby", "photo-manager-title");
    const shell = node("div", "photo-manager-shell");
    const header = node("header", "photo-manager-header");
    const heading = node("div", "photo-manager-heading");
    const title = node("h2", "", "Product photos");
    title.id = "photo-manager-title";
    const summary = node("p", "", "Loading photo status…");
    heading.append(title, summary);
    const close = node("button", "photo-manager-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close product photos");
    close.addEventListener("click", reset);
    header.append(heading, close);
    const stats = node("div", "photo-manager-stats");
    const values = [];
    for (const label of ["With a photo", "Without a photo", "In progress"]) {
      const value = node("strong", "", "—");
      const stat = node("div");
      stat.append(value, node("span", "", label));
      stats.append(stat);
      values.push(value);
    }
    const toolbar = node("div", "photo-manager-toolbar");
    const queue = node("button", "primary", "Find missing photos");
    queue.type = "button";
    queue.dataset.photoAction = "queue";
    queue.disabled = true;
    queue.addEventListener("click", () => submit({ action: "queue_missing" }));
    const refreshButton = node("button", "", "Refresh status");
    refreshButton.type = "button";
    refreshButton.addEventListener("click", refresh);
    toolbar.append(queue, refreshButton);
    const searchRow = node("div", "photo-manager-search");
    const search = node("input");
    search.type = "search";
    search.placeholder = "Search photo checks…";
    search.setAttribute("aria-label", "Search photo checks");
    search.addEventListener("input", () => {
      page = 0;
      render();
      elements.jobs.scrollTop = 0;
    });
    searchRow.append(search);
    const error = node("p", "photo-manager-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = node("p", "photo-manager-status");
    status.setAttribute("role", "status");
    const jobs = node("div", "photo-manager-jobs");
    jobs.setAttribute("aria-label", "Product photo checks");
    const empty = node("p", "photo-manager-empty", "Loading photo checks…");
    jobs.append(empty);
    const footer = node("footer", "photo-manager-footer");
    const listNote = node("p", "", "");
    const pagination = node("div", "photo-manager-pagination");
    pagination.hidden = true;
    const previous = node("button", "", "Previous");
    previous.type = "button";
    previous.setAttribute("aria-label", "Previous page");
    const next = node("button", "", "Next");
    next.type = "button";
    next.setAttribute("aria-label", "Next page");
    const pageLabel = node("span");
    previous.addEventListener("click", () => {
      page = Math.max(0, page - 1);
      render();
      elements.jobs.scrollTop = 0;
    });
    next.addEventListener("click", () => {
      page++;
      render();
      elements.jobs.scrollTop = 0;
    });
    pagination.append(previous, pageLabel, next);
    footer.append(listNote, pagination);
    shell.append(
      header,
      stats,
      toolbar,
      searchRow,
      error,
      status,
      jobs,
      footer,
    );
    dialog.append(shell);
    elements = {
      dialog,
      summary,
      countPhoto: values[0],
      countMissing: values[1],
      countProgress: values[2],
      refresh: refreshButton,
      queue,
      status,
      error,
      jobs,
      empty,
      listNote,
      search,
      pagination,
      previous,
      next,
      pageLabel,
    };
    const viewport = window.visualViewport;
    function updateViewport() {
      if (!viewport || !matchMedia("(max-width: 600px)").matches) {
        dialog.style.removeProperty("--photo-viewport-height");
        dialog.style.removeProperty("--photo-viewport-top");
        return;
      }
      dialog.style.setProperty(
        "--photo-viewport-height",
        `${viewport.height}px`,
      );
      dialog.style.setProperty(
        "--photo-viewport-top",
        `${viewport.offsetTop}px`,
      );
    }
    function onVisibility() {
      if (!document.hidden) refresh();
    }
    document.addEventListener("visibilitychange", onVisibility);
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    dialog.addEventListener("close", () => {
      document.removeEventListener("visibilitychange", onVisibility);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      if (elements?.dialog === dialog) reset();
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        reset();
    });
    document.body.append(dialog);
    updateViewport();
    dialog.showModal();
    close.focus();
    refresh();
    timer = setInterval(refresh, 15000);
  }

  function dispose() {
    reset();
    disposed = true;
  }

  return { open, close: reset, reset, dispose };
}
