function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function symbol(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "store-picker-icon");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

/** A controlled store choice: only an explicit selection calls onSelect. */
export function createStorePicker({
  stores = [],
  value,
  id = "store-switch",
  onSelect = () => {},
}) {
  const seen = new Set();
  const choices = stores
    .filter((store) => {
      if (
        !store ||
        typeof store.id !== "string" ||
        !store.id ||
        typeof store.name !== "string" ||
        !store.name.trim() ||
        seen.has(store.id)
      )
        return false;
      seen.add(store.id);
      return true;
    })
    .map((store, index) => ({
      id: store.id,
      name: store.name.trim(),
      search: normalized(store.name),
      optionId: `${id}-option-${index}`,
    }));
  const selected = choices.find((store) => store.id === value);
  const element = document.createElement("div");
  element.className = "store-picker";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = id;
  trigger.className = "store-picker-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", `${id}-popup`);
  trigger.title = selected?.name || "Choose store";
  trigger.setAttribute(
    "aria-label",
    `Store: ${selected?.name || "choose a store"}`,
  );
  trigger.disabled = !choices.length;
  const currentName = document.createElement("span");
  currentName.className = "store-picker-value";
  currentName.textContent = selected?.name || "Choose store";
  trigger.append(currentName, symbol("m7 10 5 5 5-5"));

  const popup = document.createElement("div");
  popup.id = `${id}-popup`;
  popup.className = "store-picker-popup";
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Choose store");
  const searchLabel = document.createElement("label");
  searchLabel.className = "store-picker-label";
  searchLabel.htmlFor = `${id}-search`;
  searchLabel.textContent = "Search stores";
  const search = document.createElement("input");
  search.id = `${id}-search`;
  search.type = "search";
  search.className = "store-picker-search";
  search.placeholder = "Type a store name…";
  search.autocomplete = "off";
  search.setAttribute("autocapitalize", "none");
  search.spellcheck = false;
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-expanded", "false");
  search.setAttribute("aria-controls", `${id}-listbox`);
  const resultCount = document.createElement("p");
  resultCount.className = "store-picker-count";
  resultCount.setAttribute("role", "status");
  resultCount.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.id = `${id}-listbox`;
  list.className = "store-picker-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Stores");
  // The combobox owns keyboard focus; scroll containers can otherwise become
  // an extra Tab stop in Chromium even without an explicit tab index.
  list.tabIndex = -1;
  const empty = document.createElement("p");
  empty.className = "store-picker-empty";
  empty.textContent = "No stores match that search.";
  empty.hidden = true;
  popup.append(searchLabel, search, resultCount, list, empty);
  element.append(trigger, popup);

  let opened = false,
    disposed = false,
    active = -1,
    matches = [];
  const listeners = [];
  function listen(target, name, handler, options) {
    target?.addEventListener(name, handler, options);
    listeners.push(() => target?.removeEventListener(name, handler, options));
  }
  function updateActive({ scroll = false } = {}) {
    for (let index = 0; index < list.children.length; index++)
      list.children[index].classList.toggle("is-active", index === active);
    const option = list.children[active];
    if (!option) {
      search.removeAttribute("aria-activedescendant");
      return;
    }
    search.setAttribute("aria-activedescendant", option.id);
    if (scroll) {
      if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
      else if (
        option.offsetTop + option.offsetHeight >
        list.scrollTop + list.clientHeight
      )
        list.scrollTop =
          option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }
  function draw() {
    const terms = normalized(search.value).split(/\s+/).filter(Boolean);
    matches = choices.filter((store) =>
      terms.every((term) => store.search.includes(term)),
    );
    active = Math.max(
      0,
      matches.findIndex((store) => store.id === value),
    );
    if (!matches.length) active = -1;
    list.replaceChildren(
      ...matches.map((store) => {
        const option = document.createElement("div");
        option.className = "store-picker-option";
        option.id = store.optionId;
        option.dataset.storeId = store.id;
        option.setAttribute("role", "option");
        option.setAttribute("aria-label", store.name);
        option.setAttribute("aria-selected", String(store.id === value));
        const name = document.createElement("span");
        name.textContent = store.name;
        option.append(name);
        if (store.id === value) option.append(symbol("m5 12 4 4L19 6"));
        return option;
      }),
    );
    resultCount.textContent = `${matches.length} ${matches.length === 1 ? "store" : "stores"}`;
    empty.hidden = matches.length > 0;
    list.hidden = !matches.length;
    updateActive();
  }
  function position() {
    if (!opened || disposed) return;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0;
    const height = viewport?.height || window.innerHeight;
    const width = viewport?.width || window.innerWidth;
    const rect = trigger.getBoundingClientRect();
    const available = top + height - rect.bottom - 20;
    const compact = available < 210;
    popup.classList.toggle("is-viewport", compact);
    popup.style.setProperty(
      "--store-picker-height",
      `${Math.max(100, compact ? height - 24 : Math.min(440, available))}px`,
    );
    popup.style.setProperty(
      "--store-picker-width",
      `${Math.max(120, width - 24)}px`,
    );
    popup.style.setProperty("--store-picker-top", `${top + 12}px`);
    popup.style.setProperty(
      "--store-picker-left",
      `${(viewport?.offsetLeft || 0) + 12}px`,
    );
  }
  function close({ restoreFocus = false } = {}) {
    if (!opened) return;
    opened = false;
    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (restoreFocus && !disposed && trigger.isConnected)
      trigger.focus({ preventScroll: true });
  }
  function open(direction) {
    if (disposed || !choices.length) return;
    opened = true;
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-expanded", "true");
    search.value = "";
    draw();
    if (direction === "last" && !selected) active = matches.length - 1;
    position();
    search.focus({ preventScroll: true });
    updateActive({ scroll: true });
  }
  function commit(store) {
    if (!store || disposed || !opened) return;
    close({ restoreFocus: true });
    if (store.id !== value) onSelect(store.id);
  }
  function optionFromEvent(event) {
    const option = event.target.closest?.(".store-picker-option");
    return option?.parentElement === list ? option : null;
  }
  listen(trigger, "click", () => (opened ? close() : open()));
  listen(trigger, "keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(event.key === "ArrowUp" ? "last" : "first");
    }
  });
  listen(search, "input", draw);
  listen(search, "keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!matches.length) return;
      active =
        (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
        matches.length;
      updateActive({ scroll: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(matches[active]);
    }
  });
  listen(element, "keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && opened) {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    }
  });
  listen(list, "mousedown", (event) => {
    if (optionFromEvent(event)) event.preventDefault();
  });
  listen(list, "click", (event) => {
    const option = optionFromEvent(event);
    if (option)
      commit(matches.find((store) => store.id === option.dataset.storeId));
  });
  listen(list, "pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const option = optionFromEvent(event);
    if (!option) return;
    active = [...list.children].indexOf(option);
    updateActive();
  });
  listen(document, "pointerdown", (event) => {
    if (opened && !element.contains(event.target)) close();
  });
  listen(document, "focusin", (event) => {
    if (opened && !element.contains(event.target)) close();
  });
  listen(window, "resize", position);
  listen(window.visualViewport, "resize", position);
  listen(window.visualViewport, "scroll", position);

  return {
    element,
    isOpen: () => opened && !disposed,
    dispose() {
      if (disposed) return;
      disposed = true;
      close();
      for (const remove of listeners.splice(0)) remove();
    },
  };
}
