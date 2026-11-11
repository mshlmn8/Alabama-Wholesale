// Order-sheet catalog, used at every width: set quantities in place instead of
// through a dialog. (The phone- prefix is historical.)
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

// Blank restores the saved quantity (null); unreadable input is refused.
export function typedQuantity(raw, valid) {
  if (!valid) throw new Error("Use a whole number from 0 to 1,000,000.");
  const text = String(raw ?? "").trim();
  return text === "" ? null : Number(text);
}

export function assertSameDraft(knownId, currentId) {
  if ((knownId ?? null) !== (currentId ?? null))
    throw new Error(
      "Your order changed since this page was shown. The quantities are now up to date; please try again.",
    );
}

// After a change, explains a quantity that could not go as low as asked.
export function heldElsewhereMessage(after, wanted) {
  if (wanted < 0 || after <= wanted) return null;
  return after === 1
    ? "1 is in a line with a note or case unit. Change it on the Order screen."
    : `${after} are in lines with a note or case unit. Change them on the Order screen.`;
}

// Builds the order panel's groups from draft lines grouped by product.
export function orderGroupsFor(grouped, { productOf, variantsOf, priceOf, labelOf, cash }) {
  return (grouped || []).map((group) => {
    const product = productOf(group.productId);
    const options = product ? variantsOf(product).length : 0;
    let amount = 0,
      priced = true;
    const lines = group.lines.map((line) => {
      const price = priceOf(line);
      const total = price == null ? null : price * line.quantity;
      if (total == null) priced = false;
      else amount += total;
      const name = labelOf(line) || (options > 1 ? "Standard" : "");
      return {
        label: `${name}${line.unit === "case" ? " (case)" : ""}`.trim(),
        quantity: line.quantity,
        amount: total == null ? "Check item" : cash(total),
      };
    });
    return {
      name: product?.name || "Product unavailable",
      amount: priced ? cash(amount) : "Check items",
      lines,
    };
  });
}

// Flattens the order panel's groups into display rows.
export function orderPanelRows(groups) {
  return (groups || []).flatMap((group) => [
    { kind: "group", text: group.name, amount: group.amount },
    ...group.lines.map((line) => ({
      kind: "line",
      text: line.label ? `${line.quantity} × ${line.label}` : `${line.quantity}`,
      amount: line.amount,
    })),
  ]);
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
    orderGroups = () => [],
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

  // Desktop: the same order, itemised, beside the catalog.
  const panelLines = el("div", { class: "catalog-order-lines" });
  const panelSubtotalLabel = el("dt", {}, "Subtotal");
  const panelSubtotal = el("dd", {});
  const panelTax = el("dd", {});
  const panelTotal = el("dd", {});
  const panelTotals = el(
    "dl",
    { class: "catalog-order-totals" },
    el("div", {}, panelSubtotalLabel, panelSubtotal),
    el("div", {}, el("dt", {}, "Estimated tax"), panelTax),
    el(
      "div",
      { class: "catalog-order-total" },
      el("dt", {}, "Estimated total"),
      panelTotal,
    ),
  );
  const panelReview = button("Review and submit", onReview, "primary");
  const panelNote = el(
    "p",
    { class: "catalog-order-note" },
    "The total is an estimate until the order is confirmed.",
  );
  const orderPanel = el(
    "aside",
    { class: "catalog-order-panel", "aria-label": "Your order" },
    el("h2", {}, "Your order"),
    panelLines,
    panelTotals,
    panelReview,
    panelNote,
  );

  function updateBar() {
    const units = quantities.draftUnits(getLines());
    const sums = totals();
    const label = orderBarLabel(sums, units, cash);
    orderBar.hidden = !units;
    barUnits.textContent = label.units;
    barTotal.textContent = label.total;
    const rows = orderPanelRows(orderGroups());
    orderPanel.dataset.empty = String(!rows.length);
    panelTotals.hidden = panelReview.hidden = panelNote.hidden = !rows.length;
    panelLines.replaceChildren(
      ...(rows.length
        ? rows.map((row) =>
            el(
              "div",
              { class: `catalog-order-row catalog-order-${row.kind}` },
              el("span", {}, row.text),
              el("span", {}, row.amount),
            ),
          )
        : [
            el(
              "p",
              { class: "catalog-order-empty" },
              "Nothing yet. Set quantities in the catalog and they appear here.",
            ),
          ]),
    );
    panelSubtotalLabel.textContent = `Subtotal, ${units} ${
      units === 1 ? "item" : "items"
    }`;
    const unknown = !!sums.missing?.length;
    panelSubtotal.textContent = unknown ? "Check items" : cash(sums.subtotal);
    panelTax.textContent = unknown ? "—" : cash(sums.tax);
    panelTotal.textContent = label.total;
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
    const saved = () =>
      quantities.variantQuantity(getLines(), product.id, variant);
    const apply = (wanted, change) => {
      try {
        assertOrderable(currentProduct(product.id), variant, variantsOf);
        changeLines(change);
        const held = heldElsewhereMessage(saved(), wanted);
        if (held) throw new Error(held);
      } finally {
        refresh(product.id);
      }
    };
    // Some touch browsers tap a button without first committing the field.
    const pending = () => {
      if (!value.validity.valid || value.value.trim() === "") return null;
      const typed = Number(value.value);
      return Number.isSafeInteger(typed) &&
        typed >= 0 &&
        typed <= 1_000_000 &&
        typed !== saved()
        ? typed
        : null;
    };
    const step = (delta) => {
      const typed = pending();
      apply(Math.max(0, (typed ?? saved()) + delta), (lines) =>
        quantities.stepVariantQuantity(
          typed == null
            ? lines
            : quantities.setVariantQuantity(
                lines,
                product.id,
                variant,
                typed,
                makeId,
              ),
          product.id,
          variant,
          delta,
          makeId,
        ),
      );
    };
    const less = button("", () => step(-1), "phone-step phone-step-less", "minus");
    const more = button("", () => step(1), "phone-step phone-step-more", "plus");
    less.setAttribute("aria-label", `Decrease ${label} quantity`);
    more.setAttribute("aria-label", `Increase ${label} quantity`);
    value.addEventListener("focus", () => value.select());
    value.addEventListener("change", () =>
      act(() => {
        let typed;
        try {
          typed = typedQuantity(value.value, value.validity.valid);
        } finally {
          if (typed == null) refresh(product.id);
        }
        if (typed == null) return;
        apply(typed, (lines) =>
          quantities.setVariantQuantity(lines, product.id, variant, typed, makeId),
        );
      }),
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
    return entry;
  }

  function panelFor(entry) {
    if (entry.panel) return entry.panel;
    const { product, variants, single } = entry;
    // A single product's row shows only in dense photo grids, where the card
    // is too narrow for its own stepper.
    const rows = variants.map((variant) => {
          const price = priceFor(product.id, variant);
          const available = availableFor(product.id, variant);
          const row = el(
            "div",
            {
              class: `phone-flavor-row${single ? " phone-flavor-row-single" : ""}`,
            },
            el(
              "div",
              { class: "phone-flavor-info" },
              el(
                "span",
                { class: "phone-flavor-name" },
                variant || (single ? product.name : "Standard"),
              ),
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
    refresh(entry.product.id, false);
  }

  function toggle(product) {
    if (expanded.has(product.id)) expanded.delete(product.id);
    else expanded.add(product.id);
    syncOpen(entryFor(product));
  }

  function refresh(productId, bar = true) {
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
    if (bar) updateBar();
  }

  function nodes(products) {
    const list = products.flatMap((product) => {
      const entry = entryFor(product);
      return expanded.has(product.id) ? [entry.card, panelFor(entry)] : [entry.card];
    });
    refresh(null, false);
    updateBar();
    return list;
  }

  updateBar();
  return { nodes, orderBar, orderPanel, refresh };
}
