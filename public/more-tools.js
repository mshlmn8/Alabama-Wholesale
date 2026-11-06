export function mobileDestination(view) {
  if (view === "home") return null;
  return ["catalog", "build", "orders", "stores"].includes(view)
    ? view
    : "more";
}

// Reusable lists contain order intent only. Prices and allocations come from the
// current catalog and the normal ordering workflow when the draft is submitted.
export function reviewSavedList(saved, products) {
  const byId = new Map(products.map((product) => [product.id, product]));
  const problems = [],
    lines = [];
  for (const row of saved.lines || []) {
    const product = byId.get(row.productId),
      name = product?.name || row.productId;
    const variants = product?.variants?.length ? product.variants : [""];
    const mixed = ["mix", "each"].includes(row.selectionMode);
    const requested = mixed
      ? [...(row.allowedVariants || []), ...(row.excludedVariants || [])]
      : [row.variant || ""];
    if (
      !product ||
      product.deleted ||
      product.active === false ||
      product.stockStatus === "out-of-stock"
    )
      problems.push(`${name}: unavailable in the current catalog.`);
    else if (
      requested.some((variant) => !variants.includes(variant)) ||
      (mixed && !row.allowedVariants?.length)
    )
      problems.push(
        `${name}: flavor choices have changed. Update this list first.`,
      );
    else if (
      !["each", "case"].includes(row.unit) ||
      (row.unit === "case" &&
        (!Number.isSafeInteger(product.packSize) || product.packSize < 1))
    )
      problems.push(`${name}: the selected pack size is unavailable.`);
    else if (
      !Number.isSafeInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > 1000000
    )
      problems.push(`${name}: choose a valid whole quantity.`);
    else
      lines.push({
        productId: row.productId,
        variant: row.variant || "",
        quantity: row.quantity,
        unit: row.unit,
        note: row.note || "",
        ...(mixed
          ? {
              selectionMode: row.selectionMode,
              allowedVariants: [...row.allowedVariants],
              excludedVariants: [...(row.excludedVariants || [])],
            }
          : {}),
      });
  }
  if (!saved.lines?.length) problems.push("This list has no products.");
  return { lines: problems.length ? [] : lines, problems };
}

export function documentEntries(orders, returns, storeId, query = "") {
  const entries = [
    ...orders
      .filter(
        (row) =>
          row.storeId === storeId &&
          !row.deleted &&
          [
            "submitted",
            "approved",
            "picking",
            "delivered",
            "cancelled",
          ].includes(row.status) &&
          !row.legacy?.needsPriceReview &&
          !row.missingPriceSnapshots &&
          !row.missingSnapshots &&
          row.invoiceNumber,
      )
      .map((row) => ({
        id: row.id,
        kind: "invoice",
        label: row.invoiceNumber,
        at: row.submittedAt || row.createdAt || 0,
        record: row,
      })),
    ...returns
      .filter(
        (row) =>
          row.storeId === storeId &&
          !row.deleted &&
          row.status === "approved" &&
          row.creditMemoNumber,
      )
      .map((row) => ({
        id: row.id,
        kind: "credit-memo",
        label: row.creditMemoNumber,
        at: row.approvedAt || row.createdAt || 0,
        record: row,
      })),
  ];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) =>
      terms.every((term) =>
        `${entry.label} ${entry.record.invoiceNumber || ""}`
          .toLocaleLowerCase()
          .includes(term),
      ),
    )
    .sort((a, b) => b.at - a.at);
}

export async function prepareEvidencePhoto(file) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 6 * 1024 * 1024
  )
    throw new Error("Choose a PNG, JPEG or WebP photo under 6 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 50000000
    )
      throw new Error("Choose a smaller delivery photo.");
    const canvas = document.createElement("canvas");
    let scale = Math.min(
      1,
      1280 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error(
          "This browser cannot prepare photos. Try another device.",
        );
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/jpeg", 0.76).split(",")[1];
      if (data && data.length <= 270000)
        return { mimeType: "image/jpeg", data };
      scale *= 0.7;
    }
    throw new Error("This photo is too large. Choose a smaller image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createMoreTools(ctx) {
  const {
    el,
    input,
    select,
    button,
    field,
    heading,
    notice,
    empty,
    modal,
    api,
    command,
    toast,
  } = ctx;
  function capture(withDraft = false) {
    const scope = ctx.scope(),
      storeId = ctx.getStore()?.id,
      draft = ctx.getDraft();
    if (!storeId) throw new Error("Select a store first.");
    return {
      storeId,
      current() {
        return ctx.isCurrent(scope) && ctx.getStore()?.id === storeId;
      },
      check() {
        if (
          !this.current() ||
          (withDraft &&
            (ctx.getDraft()?.id !== draft?.id ||
              ctx.getDraft()?.localRevision !== draft?.localRevision))
        )
          throw new Error(
            "The account, store or draft changed. Reopen this tool.",
          );
      },
    };
  }
  const lineName = (row) => {
    const product = ctx
      .getState()
      .products.find((product) => product.id === row.productId);
    return `${product?.name || row.productId}${row.selectionMode === "each" ? " · Each flavor" : row.selectionMode === "mix" ? " · Mix" : row.variant ? " · " + row.variant : ""}`;
  };

  function saveList(source = ctx.getDraft(), existing = null) {
    const captured = capture();
    if (!source?.lines?.length)
      throw new Error("Add products to an order before saving a list.");
    if (source.storeId !== captured.storeId)
      throw new Error("Select the order’s store first.");
    const m = modal(
      existing ? "Edit saved order list" : "Save order list",
      "Keep products, quantities and flavor choices. Prices are checked again when you order.",
      true,
    );
    const name = input("text", existing?.name || "", {
      maxlength: 100,
      required: true,
      placeholder: "e.g. Weekly restock",
    });
    const notes = el("textarea", { maxlength: 10000 });
    notes.value = source.notes || "";
    const rows = source.lines.map((row) => ({
      row,
      quantity: input("number", row.quantity, {
        min: 1,
        max: 1000000,
        step: 1,
        "aria-label": `Saved quantity for ${lineName(row)}`,
      }),
      keep: input("checkbox", "", {
        checked: true,
        "aria-label": `Keep ${lineName(row)}`,
      }),
    }));
    m.content.append(
      field("List name", name),
      el(
        "div",
        { class: "saved-list-lines" },
        rows.map(({ row, quantity, keep }) =>
          el(
            "div",
            { class: "saved-list-edit-row" },
            el(
              "label",
              { class: "check-field" },
              keep,
              el(
                "span",
                {},
                lineName(row),
                el(
                  "small",
                  {},
                  `${row.unit === "case" ? "Cases" : "Items"}${row.excludedVariants?.length ? " · Excluding " + row.excludedVariants.join(", ") : ""}`,
                ),
              ),
            ),
            quantity,
          ),
        ),
      ),
      field("Order instructions", notes),
    );
    m.footer.append(
      button("Cancel", m.close),
      button(
        "Save list",
        async () => {
          captured.check();
          const lines = rows
            .filter((row) => row.keep.checked)
            .map(({ row, quantity }) => {
              const count = Number(quantity.value);
              if (!Number.isSafeInteger(count) || count < 1 || count > 1000000)
                throw new Error("Enter whole quantities from 1 to 1,000,000.");
              return { ...row, quantity: count };
            });
          if (!name.value.trim() || !lines.length)
            throw new Error("Enter a name and keep at least one product.");
          await command("order-list.save", {
            storeId: captured.storeId,
            name: name.value.trim(),
            lines,
            notes: notes.value,
            ...(existing
              ? { id: existing.id, expectedVersion: existing.version }
              : {}),
          });
          captured.check();
          m.close();
          ctx.setView("saved-lists");
          toast("Order list saved for this store.");
        },
        "primary",
      ),
    );
  }
  function reviewList(saved) {
    const captured = capture(true),
      review = reviewSavedList(saved, ctx.getState().products);
    const m = modal(
      saved.name,
      "Review quantities and current prices before adding to your draft.",
      true,
    );
    if (
      saved.storeId !== captured.storeId ||
      saved.userId !== ctx.getState().me.uid
    ) {
      m.close();
      throw new Error("This list belongs to another account or store.");
    }
    for (const problem of review.problems)
      m.content.append(notice(problem, true));
    const list = el("div", { class: "saved-list-lines" });
    for (const row of saved.lines)
      list.append(
        el(
          "div",
          { class: "saved-list-review-row" },
          el(
            "div",
            {},
            el("strong", {}, lineName(row)),
            el(
              "p",
              { class: "small" },
              `${row.quantity} ${row.unit}${row.selectionMode === "each" ? " of each allowed flavor" : ""}${row.excludedVariants?.length ? " · Excluding " + row.excludedVariants.join(", ") : ""}`,
            ),
          ),
          el(
            "strong",
            {},
            ctx.cash(
              ctx.price(row) == null ? null : ctx.price(row) * row.quantity,
            ),
          ),
        ),
      );
    m.content.append(
      list,
      notice(
        "Current catalog prices are shown. Availability and final pricing are verified when you submit. Existing draft items stay in place.",
      ),
    );
    m.footer.append(
      button("Close", m.close),
      button("Edit list", () => {
        captured.check();
        m.close();
        saveList(saved, saved);
      }),
    );
    if (!review.problems.length)
      m.footer.append(
        button(
          "Add to current draft",
          () => {
            captured.check();
            const latest = reviewSavedList(saved, ctx.getState().products);
            if (latest.problems.length)
              throw new Error(latest.problems.join(" "));
            ctx.addToDraft(latest.lines, saved.notes || "");
            m.close();
            ctx.setView("build");
            toast("Saved items added. Review your order before submitting.");
          },
          "primary",
        ),
      );
  }
  function renderSavedLists() {
    const store = ctx.getStore(),
      lists = (ctx.getState().orderLists || []).filter(
        (row) =>
          row.storeId === store?.id &&
          row.userId === ctx.getState().me.uid &&
          !row.deleted,
      );
    const root = el(
      "div",
      { class: "stack more-content-page" },
      heading(
        "Saved order lists",
        store
          ? `Reusable product lists for ${store.name}.`
          : "Select a store to save product lists.",
        [button("Save current order", () => saveList(), "", "plus")],
      ),
    );
    if (!lists.length)
      root.append(
        empty(
          "Your regulars, ready to reorder",
          "Add products in Build, then save that order as a named list. Saved instructions remain separate.",
          [button("Browse catalog", () => ctx.setView("catalog"), "primary")],
          "orders",
        ),
      );
    const captured = store ? capture() : null;
    for (const saved of lists)
      root.append(
        el(
          "section",
          { class: "panel saved-list-card" },
          el(
            "div",
            {},
            el("h2", {}, saved.name),
            el(
              "p",
              {},
              `${saved.lines.length} product lines · Updated ${ctx.date(saved.updatedAt)}`,
            ),
          ),
          el(
            "div",
            { class: "actions" },
            button(
              "Review list",
              () => {
                captured.check();
                reviewList(saved);
              },
              "primary",
            ),
            button("Edit", () => {
              captured.check();
              saveList(saved, saved);
            }),
            button("Delete", async () => {
              captured.check();
              if (
                !(await ctx.confirm(
                  "Delete this saved list?",
                  saved.name,
                  "Delete list",
                ))
              )
                return;
              captured.check();
              await command("order-list.delete", {
                storeId: captured.storeId,
                id: saved.id,
                expectedVersion: saved.version,
              });
              captured.check();
              toast("Saved list deleted.");
            }),
          ),
        ),
      );
    return root;
  }

  function renderDocuments() {
    const store = ctx.getStore();
    const root = el(
      "div",
      { class: "stack more-content-page" },
      heading(
        "Invoices & documents",
        store
          ? `Confirmed invoices and credit memos for ${store.name}.`
          : "Select a store to view documents.",
      ),
    );
    if (!store) return root;
    const captured = capture(),
      known = new Map(
        ctx
          .getState()
          .orders.filter((row) => row.storeId === store.id)
          .map((row) => [row.id, row]),
      );
    const search = input("search", "", {
      id: "document-search",
      placeholder: "Invoice or credit memo number",
      "aria-label": "Search loaded documents",
    });
    const type = select(
      [
        ["", "All documents"],
        ["invoice", "Invoices"],
        ["credit-memo", "Credit memos"],
      ],
      "",
      { "aria-label": "Document type" },
    );
    const from = input("date", "", { "aria-label": "Documents from date" }),
      to = input("date", "", { "aria-label": "Documents through date" });
    const listing = el("div", { class: "stack" }),
      message = el("p", { class: "small", role: "status" });
    let cursor = null,
      loaded = false,
      loading = false;
    const more = button("Load older invoices", () => load(), "");
    const render = () => {
      captured.check();
      const entries = documentEntries(
        [...known.values()],
        ctx.getState().returns,
        store.id,
        search.value,
      ).filter(
        (entry) =>
          (!type.value || entry.kind === type.value) &&
          (!from.value ||
            entry.at >= new Date(from.value + "T00:00:00").getTime()) &&
          (!to.value ||
            entry.at <= new Date(to.value + "T23:59:59.999").getTime()),
      );
      listing.replaceChildren(
        ...entries.map((entry) =>
          el(
            "article",
            { class: "document-row panel" },
            el(
              "div",
              {},
              el(
                "span",
                { class: "eyebrow" },
                entry.kind === "invoice" ? "Invoice" : "Credit memo",
              ),
              el("h2", {}, entry.label),
              el(
                "p",
                { class: "small" },
                `${ctx.date(entry.at)} · ${ctx.cash(entry.record.totalCents)}`,
              ),
            ),
            button(
              "Download PDF",
              async () => {
                captured.check();
                const blob = await (
                  await api(
                    `/api/documents/${encodeURIComponent(entry.id)}/${entry.kind}`,
                    { raw: true },
                  )
                ).blob();
                captured.check();
                ctx.download(
                  ctx.filename(entry.record, { store, kind: entry.kind }),
                  blob,
                );
              },
              "",
              "download",
            ),
          ),
        ),
      );
      if (!entries.length)
        listing.append(
          empty(
            "No matching loaded documents",
            "Change the filters or load older invoices. Pending return requests do not have a credit memo yet.",
            [],
            "orders",
          ),
        );
      more.hidden = loaded && !cursor;
      more.disabled = loading;
    };
    async function load() {
      if (loading) return;
      loading = true;
      message.textContent = "Loading invoices…";
      more.disabled = true;
      try {
        captured.check();
        const query = new URLSearchParams({ storeId: store.id });
        if (cursor) query.set("cursor", cursor);
        const response = await api(`/api/orders?${query}`);
        captured.check();
        for (const order of response.orders || [])
          if (order.storeId === store.id) known.set(order.id, order);
        cursor = response.nextCursor || null;
        loaded = true;
        message.textContent = cursor
          ? "Search covers loaded invoices. Load older invoices to look further back."
          : "All available invoice pages are loaded.";
        more.textContent = "Load older invoices";
        render();
      } catch (error) {
        if (captured.current()) {
          message.textContent = ctx.error(error);
          more.hidden = false;
          more.textContent = "Retry loading invoices";
        }
      } finally {
        loading = false;
        more.disabled = false;
      }
    }
    for (const control of [search, type, from, to])
      control.addEventListener(control === search ? "input" : "change", () => {
        captured.check();
        render();
      });
    root.append(
      el(
        "div",
        { class: "documents-filters" },
        field("Search loaded documents", search),
        field("Type", type),
        field("From", from),
        field("Through", to),
      ),
      message,
      listing,
      el("div", { class: "actions" }, more),
    );
    render();
    void load();
    return root;
  }

  function createEvidencePicker() {
    const control = input("file", "", {
      accept: "image/jpeg,image/png,image/webp",
      multiple: true,
      "aria-label": "Delivery photos",
    });
    const feedback = el(
      "p",
      { class: "small", role: "status" },
      "Optional: up to 3 photos. Photos are reduced for upload and shared only with authorized store users.",
    );
    const previews = el("div", { class: "evidence-previews" });
    let photos = [],
      busy = false,
      generation = 0,
      error = "";
    control.addEventListener("change", async () => {
      const current = ++generation;
      photos = [];
      error = "";
      previews.replaceChildren();
      busy = true;
      feedback.textContent = "Preparing delivery photos…";
      try {
        const files = [...control.files];
        if (files.length > 3)
          throw new Error("Choose up to three delivery photos.");
        const next = [];
        for (const file of files) next.push(await prepareEvidencePhoto(file));
        if (current !== generation) return;
        photos = next;
        previews.replaceChildren(
          ...photos.map((photo, index) =>
            el("img", {
              src: `data:${photo.mimeType};base64,${photo.data}`,
              alt: `Selected delivery photo ${index + 1}`,
              width: 96,
              height: 96,
            }),
          ),
        );
        feedback.textContent = photos.length
          ? `${photos.length} photo${photos.length === 1 ? "" : "s"} ready. Choose files again to replace them.`
          : "No photos selected.";
      } catch (e) {
        if (current === generation) {
          error = e.message;
          feedback.textContent = error;
        }
      } finally {
        if (current === generation) busy = false;
      }
    });
    return {
      node: el(
        "div",
        { class: "evidence-picker" },
        field("Delivery photos", control),
        feedback,
        previews,
      ),
      photos() {
        if (busy)
          throw new Error("Wait for the delivery photos to finish preparing.");
        if (error) throw new Error(error);
        return photos;
      },
    };
  }
  function showEvidence(record) {
    const captured = capture();
    if (record.storeId !== captured.storeId)
      throw new Error("Select this request’s store first.");
    const m = modal(
        "Delivery photos",
        record.invoiceNumber || "Delivery issue",
        true,
      ),
      urls = [];
    const content = el("div", { class: "evidence-gallery" }),
      feedback = el("p", { role: "status" }, "Loading private photos…");
    m.content.append(feedback, content);
    const originalClose = m.close;
    let closed = false;
    const close = () => {
      closed = true;
      for (const url of urls) URL.revokeObjectURL(url);
      originalClose();
    };
    m.dialog.addEventListener(
      "close",
      () => {
        closed = true;
        for (const url of urls) URL.revokeObjectURL(url);
      },
      { once: true },
    );
    m.footer.append(button("Close", close));
    void (async () => {
      try {
        for (const [index, photo] of (record.photos || []).entries()) {
          captured.check();
          const blob = await (
            await api(
              `/api/returns/${encodeURIComponent(record.id)}/photos/${encodeURIComponent(photo.id)}`,
              { raw: true },
            )
          ).blob();
          captured.check();
          if (closed || !m.dialog.open) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          content.append(
            el("img", {
              src: url,
              alt: `Delivery evidence ${index + 1}`,
              width: 640,
              height: 480,
            }),
          );
        }
        feedback.textContent = "Photos attached to this delivery issue.";
      } catch (error) {
        if (!closed && captured.current())
          feedback.textContent = ctx.error(error);
      }
    })();
  }
  function showHelp() {
    const m = modal(
      "Help & support",
      "Ordering help and your store’s contact details.",
    );
    const contact = ctx.getStore()?.assignedSalesman;
    if (contact && (contact.name || contact.phone || contact.email))
      m.content.append(
        el(
          "section",
          { class: "panel" },
          el("h2", {}, "Your store contact"),
          el("p", {}, contact.name || ""),
          contact.phone ? el("p", {}, contact.phone) : null,
          contact.email ? el("p", {}, contact.email) : null,
        ),
      );
    else
      m.content.append(
        notice(
          "Use your usual Alabama Wholesale contact for account questions. Assigned contact details will appear here when available.",
        ),
      );
    for (const [title, body] of [
      [
        "Start or repeat an order",
        "Use Catalog to add products, or Orders to reopen a previous order and choose Reorder. Review the new draft before submitting.",
      ],
      [
        "Report missing or damaged items",
        "Open Returns & delivery issues, choose a delivered invoice, select quantities and attach photos. Staff reviews the request before issuing credit.",
      ],
      [
        "Check a saved draft",
        "The header shows your save status. Open Data & sync to review pending or rejected actions before closing the app.",
      ],
    ])
      m.content.append(
        el(
          "details",
          { class: "help-guide" },
          el("summary", {}, title),
          el("p", {}, body),
        ),
      );
    m.content.append(
      button(
        "Ask the assistant",
        () => {
          m.close();
          ctx.assistant();
        },
        "",
        "spark",
      ),
    );
    m.footer.append(button("Close", m.close));
  }
  return {
    saveList,
    renderSavedLists,
    renderDocuments,
    createEvidencePicker,
    showEvidence,
    showHelp,
  };
}
