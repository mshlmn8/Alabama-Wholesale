// Phone catalog: set quantities in place instead of through a dialog.
// Presentation only. Draft changes go through the injected changeLines, which
// owns session checks and saving. No imports, so helpers stay unit-testable.
const OPTIONS_CHANGED =
  "This product's options changed. Reopen it and review the available flavors.";

export function orderBarLabel(totals, units, cash) {
  return {
    units: `${units} ${units === 1 ? "item" : "items"} in this order`,
    total: totals.missing?.length ? "Check items" : cash(totals.total),
  };
}

export function assertOrderable(product, variant, variantsOf) {
  if (
    !product ||
    product.active === false ||
    product.deleted ||
    !variantsOf(product).includes(variant || "")
  )
    throw new Error(OPTIONS_CHANGED);
}

export function productSummary(product, variantsOf) {
  const count = variantsOf(product).filter(Boolean).length;
  return `${
    count ? `${count} ${count === 1 ? "option" : "options"}` : "Single product"
  }${product.packSize ? ` · ${product.packSize} per case` : ""}`;
}

export function createPhoneCatalog(deps) {
  const {
    el,
    icon,
    button,
    input,
    act,
    cash,
    makeId,
    quantities,
    getLines,
    changeLines,
    priceFor,
    availableFor,
    totals,
    variantsOf,
    currentProduct,
    imageOf,
    isFavorite,
    onFavorite,
    onEdit,
    onMoreOptions,
    onReview,
    expanded,
  } = deps;
  const entries = new Map();

  const barUnits = el("small", {});
  const barTotal = el("strong", {});
  const orderBar = el(
    "div",
    {
      class: "catalog-order-dock phone-order-bar",
      "aria-label": "Current order summary",
      hidden: true,
    },
    el("div", { class: "phone-order-bar-text" }, barUnits, barTotal),
    button("Review order", onReview, "primary", "arrow"),
  );

  function updateBar() {
    const units = quantities.draftUnits(getLines());
    const label = orderBarLabel(totals(), units, cash);
    orderBar.hidden = !units;
    barUnits.textContent = label.units;
    barTotal.textContent = label.total;
  }

  function stepper(product, variant, label, entry) {
    const value = input("number", "0", {
      min: 0,
      max: 1_000_000,
      step: 1,
      inputmode: "numeric",
      class: "phone-step-value",
      "aria-label": `${label} quantity`,
    });
    const apply = (change) => {
      try {
        assertOrderable(currentProduct(product.id), variant, variantsOf);
        changeLines(change);
      } finally {
        refresh(product.id);
      }
    };
    const less = button(
      "",
      () =>
        apply((lines) =>
          quantities.stepVariantQuantity(lines, product.id, variant, -1, makeId),
        ),
      "phone-step phone-step-less",
      "minus",
    );
    const more = button(
      "",
      () =>
        apply((lines) =>
          quantities.stepVariantQuantity(lines, product.id, variant, 1, makeId),
        ),
      "phone-step phone-step-more",
      "plus",
    );
    less.setAttribute("aria-label", `Decrease ${label} quantity`);
    more.setAttribute("aria-label", `Increase ${label} quantity`);
    value.addEventListener("focus", () => value.select());
    value.addEventListener("change", () =>
      act(() =>
        apply((lines) =>
          quantities.setVariantQuantity(
            lines,
            product.id,
            variant,
            value.value.trim() === "" ? 0 : Number(value.value),
            makeId,
          ),
        ),
      ),
    );
    const root = el(
      "div",
      { class: "phone-stepper", role: "group", "aria-label": `${label} quantity` },
      less,
      value,
      more,
    );
    entry.steppers.push({ variant, value, root, less });
    return root;
  }

  function photo(product) {
    const missing = (label) =>
      el("span", { class: "no-image", "aria-label": label }, icon("box"));
    const source = imageOf(product);
    return el(
      "span",
      { class: "phone-product-photo" },
      source
        ? el("img", {
            src: source,
            alt: "",
            width: 180,
            height: 145,
            loading: "lazy",
            decoding: "async",
            onError: (event) =>
              event.target.replaceWith(missing("Image unavailable")),
          })
        : missing("No product image"),
    );
  }

  function entryFor(product) {
    const known = entries.get(product.id);
    if (known) return known;
    const variants = variantsOf(product);
    const single = variants.length === 1;
    const entry = { product, variants, single, steppers: [], panel: null };
    const base = priceFor(product.id, single ? variants[0] : "");
    entry.pill = el("span", { class: "phone-product-count", hidden: true });
    entry.open = el(
      "button",
      {
        type: "button",
        class: "phone-product-open",
        "aria-expanded": "false",
        onClick: () => act(() => toggle(product)),
      },
      photo(product),
      el(
        "span",
        { class: "phone-product-text" },
        el("strong", { class: "phone-product-name" }, product.name),
        el(
          "span",
          { class: "phone-product-meta" },
          `${productSummary(product, variantsOf)} · ${
            base == null ? "Choose option" : cash(base)
          }`,
        ),
      ),
      entry.pill,
      el("span", { class: "phone-product-chevron" }, icon("down")),
    );
    entry.open.setAttribute(
      "aria-label",
      `${product.name}, ${single ? "product options" : "choose quantities"}`,
    );
    entry.card = el(
      "article",
      {
        class: "phone-product",
        "data-product-id": product.id,
        "data-single": String(single),
      },
      entry.open,
      single
        ? stepper(product, variants[0], variants[0] || product.name, entry)
        : null,
    );
    entries.set(product.id, entry);
    syncOpen(entry);
    refresh(product.id);
    return entry;
  }

  function panelFor(entry) {
    if (entry.panel) return entry.panel;
    const { product, variants, single } = entry;
    const rows = single
      ? []
      : variants.map((variant) => {
          const price = priceFor(product.id, variant);
          const available = availableFor(product.id, variant);
          const row = el(
            "div",
            { class: "phone-flavor-row" },
            el(
              "div",
              { class: "phone-flavor-info" },
              el("span", { class: "phone-flavor-name" }, variant || "Standard"),
              el(
                "small",
                {},
                `${price == null ? "Check item" : cash(price)}${
                  available == null ? "" : ` · ${available} available`
                }`,
              ),
            ),
            stepper(product, variant, variant || product.name, entry),
          );
          return { variant, row };
        });
    const search =
      rows.length > 6
        ? input("search", "", {
            placeholder: "Search flavors",
            "aria-label": `Search ${product.name} flavors`,
            class: "phone-flavor-search",
          })
        : null;
    const none = el(
      "p",
      { class: "phone-flavor-none", hidden: true },
      "No matching flavors. Your quantities are kept.",
    );
    search?.addEventListener("input", () => {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const { variant, row } of rows) {
        row.hidden = !(variant || "Standard").toLocaleLowerCase().includes(query);
        if (!row.hidden) visible++;
      }
      none.hidden = visible > 0;
    });
    const favorite = button(
      isFavorite(product.id) ? "Favorited" : "Favorite",
      () => onFavorite(product.id),
      "phone-flavor-action",
      "star",
    );
    favorite.setAttribute("aria-pressed", String(isFavorite(product.id)));
    entry.panel = el(
      "section",
      {
        class: "phone-flavors",
        "data-product-id": product.id,
        "aria-label": `${product.name} quantities and options`,
      },
      search,
      rows.map(({ row }) => row),
      none,
      el(
        "div",
        { class: "phone-flavor-actions" },
        favorite,
        onEdit
          ? button(
              "Edit product",
              () => onEdit(currentProduct(product.id) || product),
              "phone-flavor-action",
              "edit",
            )
          : null,
        button(
          "More options",
          () => onMoreOptions(currentProduct(product.id) || product),
          "phone-flavor-action",
          "more",
        ),
      ),
    );
    return entry.panel;
  }

  function syncOpen(entry) {
    const open = expanded.has(entry.product.id);
    entry.card.dataset.open = String(open);
    entry.open.setAttribute("aria-expanded", String(open));
    if (!open) {
      entry.panel?.remove();
      return;
    }
    const panel = panelFor(entry);
    if (entry.card.isConnected && !panel.isConnected) entry.card.after(panel);
    refresh(entry.product.id);
  }

  function toggle(product) {
    if (expanded.has(product.id)) expanded.delete(product.id);
    else expanded.add(product.id);
    syncOpen(entryFor(product));
  }

  function refresh(productId) {
    const lines = getLines();
    for (const [id, entry] of entries) {
      if (productId != null && id !== productId) continue;
      for (const control of entry.steppers) {
        const count = quantities.variantQuantity(lines, id, control.variant);
        control.value.value = String(count);
        control.root.dataset.active = String(count > 0);
        // The shared action wrapper re-enables buttons, so dim instead of disable.
        control.less.setAttribute("aria-disabled", String(count === 0));
      }
      const total = quantities.productQuantity(lines, id);
      entry.pill.textContent = `${total} in order`;
      entry.pill.hidden = !total;
      entry.card.dataset.inOrder = String(total > 0);
    }
    updateBar();
  }

  function nodes(products) {
    return products.flatMap((product) => {
      const entry = entryFor(product);
      return expanded.has(product.id) ? [entry.card, panelFor(entry)] : [entry.card];
    });
  }

  updateBar();
  return { nodes, orderBar, refresh };
}
