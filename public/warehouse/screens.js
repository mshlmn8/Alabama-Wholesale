import {
  warehouseQuantity,
  warehouseMoney,
  preparePurchaseLines,
  prepareReceiptLines,
  filterWarehouseStock,
  purchaseTitle,
  dateText,
  moneyText,
  quantityText,
} from "./helpers.js";
const OPEN = new Set(["ordered", "partially received"]);
const variants = (product) =>
  product.variants?.length
    ? [...(product.standardVariantEnabled ? [""] : []), ...product.variants]
    : [""];
const qtyInput = (input, value = "", attrs = {}) =>
  input("number", value, {
    min: 0,
    step: 1,
    max: 1_000_000,
    inputmode: "numeric",
    ...attrs,
  });
const localDate = (value) =>
  value
    ? new Date(value - new Date(value).getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 10)
    : "";
export function createWarehouseScreens(ctx) {
  const {
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
    getData,
    navigate,
    scope,
    isCurrent,
    download,
  } = ctx;
  const owner = () => getData()?.me?.role === "master";
  function requireOwner() {
    if (!owner()) throw new Error("Owner access is required.");
  }
  const heading = (title, description, actions = []) =>
    el(
      "header",
      { class: "page-heading" },
      el(
        "div",
        {},
        el("h1", { id: "page-title", tabindex: -1 }, title),
        el("p", {}, description),
      ),
      el("div", { class: "actions" }, actions),
    );
  const empty = (title, description, action) =>
    el(
      "div",
      { class: "empty" },
      el("span", { class: "empty-mark", "aria-hidden": "true" }, "◇"),
      el("h2", {}, title),
      el("p", {}, description),
      action,
    );
  const panel = (...children) => el("section", { class: "panel" }, children);
  const badge = (text) =>
    el(
      "span",
      { class: `badge ${OPEN.has(text) ? "open" : ""}` },
      text || "Unknown",
    );
  const productName = (id) =>
    getData().products?.find((product) => product.id === id)?.name || id;
  const supplierName = (po) =>
    po.supplierSnapshot?.name ||
    getData().suppliers?.find((supplier) => supplier.id === po.supplierId)
      ?.name ||
    "Supplier purchase";
  const table = (headers, rows) =>
    el(
      "div",
      {
        class: "table-wrap",
        tabindex: 0,
        "aria-label": "Scrollable data table",
      },
      el(
        "table",
        {},
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            headers.map((text) => el("th", { scope: "col" }, text)),
          ),
        ),
        el("tbody", {}, rows),
      ),
    );
  const td = (...children) => el("td", {}, children);
  const stat = (label, value, caption) =>
    el(
      "div",
      { class: "stat" },
      el("p", {}, label),
      el("strong", {}, value),
      el("small", {}, caption),
    );
  function overview() {
    const data = getData(),
      stock = data.stock || [],
      orders = data.purchaseOrders || [],
      open = orders.filter((po) => OPEN.has(po.status)),
      low = filterWarehouseStock(stock, data.products || [], { lowOnly: true }),
      unknown = stock.filter((row) => row.onHand == null);
    return el(
      "div",
      { class: "screen" },
      heading(
        "Warehouse overview",
        "A clear view of stock and supplier commitments.",
        owner()
          ? [
              button(
                "Create purchase order",
                () => showPurchaseEditor(),
                "primary",
              ),
            ]
          : [],
      ),
      el(
        "section",
        { class: "overview-hero" },
        el(
          "div",
          {},
          el("p", { class: "eyebrow" }, "KEEP THE WAREHOUSE MOVING"),
          el("h2", {}, "From supplier delivery\nto stock you can trust."),
          el(
            "p",
            {},
            "Only accepted receipts add resalable inventory. Open purchases stay visible until received or closed.",
          ),
        ),
        button("Receive a delivery", () => navigate("receive"), "light"),
      ),
      el(
        "div",
        { class: "stats" },
        stat(
          "Open purchases",
          String(open.length),
          "Ordered or partially received",
        ),
        stat(
          "Stock at reorder point",
          String(low.length),
          "Based on available counted units",
        ),
        stat(
          "Counts needed",
          String(unknown.length),
          "Unknown stock remains unknown",
        ),
      ),
      el(
        "div",
        { class: "overview-grid" },
        panel(
          el(
            "div",
            { class: "section-heading" },
            el("h2", {}, "Expected deliveries"),
            button("All purchases", () => navigate("purchasing"), "subtle"),
          ),
          open.length
            ? purchaseCards(open.slice(0, 5))
            : empty(
                "No open purchases",
                "Confirmed supplier orders will appear here.",
              ),
        ),
        panel(
          el(
            "div",
            { class: "section-heading" },
            el("h2", {}, "Stock needs attention"),
            button("View stock", () => navigate("stock"), "subtle"),
          ),
          low.length || unknown.length
            ? el(
                "div",
                { class: "attention-list" },
                [...unknown.slice(0, 3), ...low.slice(0, 4)].map((row) =>
                  el(
                    "div",
                    {},
                    el(
                      "div",
                      {},
                      el("strong", {}, productName(row.productId)),
                      el("p", {}, row.variant || "Standard"),
                    ),
                    row.onHand == null
                      ? badge("Count needed")
                      : el(
                          "strong",
                          {},
                          `${quantityText(row.availableEach ?? row.available)} available`,
                        ),
                  ),
                ),
              )
            : empty(
                "No stock flags",
                "Configured counted stock is above its reorder points.",
              ),
        ),
      ),
    );
  }
  function stock() {
    const data = getData();
    let query = "",
      lowOnly = false;
    const search = input("search", "", {
        placeholder: "Product, flavor, barcode, SKU or bin",
        "aria-label": "Search warehouse stock",
        onInput: (event) => {
          query = event.target.value;
          draw();
        },
      }),
      low = input("checkbox", "", {
        onChange: (event) => {
          lowOnly = event.target.checked;
          draw();
        },
      }),
      result = el("div", { class: "results" }),
      count = el("p", { class: "small", role: "status" });
    const root = el(
      "div",
      { class: "screen" },
      heading(
        "Warehouse stock",
        "One shared inventory. Counts, reservations and confirmed supplier inbound.",
      ),
      el(
        "div",
        { class: "filters" },
        field("Search or enter barcode", search),
        el("label", { class: "check" }, low, "At or below reorder point"),
      ),
      count,
      result,
    );
    function draw() {
      const rows = filterWarehouseStock(data.stock || [], data.products || [], {
        query,
        lowOnly,
      });
      count.textContent = `${rows.length} matching stock records${rows.length > 150 ? " · Showing first 150" : ""}`;
      const tableRows = rows.slice(0, 150).map((row) =>
        el(
          "tr",
          {},
          td(
            el("strong", {}, productName(row.productId)),
            el("p", { class: "small" }, row.variant || "Standard"),
            el(
              "p",
              { class: "small muted" },
              row.warehouseBin || row.bin || "No bin assigned",
            ),
          ),
          td(quantityText(row.onHand)),
          td(quantityText(row.reserved)),
          td(quantityText(row.availableEach ?? row.available)),
          td(quantityText(row.confirmedInboundEach ?? row.inboundEach)),
          td(
            `${quantityText(row.reorderPoint)} / ${quantityText(row.targetEach ?? row.target)}`,
          ),
          td(
            el(
              "div",
              { class: "row-actions" },
              button("Count stock", () => showCount(row)),
              button("Configure", () => showConfiguration(row)),
              button("Movements", () => showMovements(row)),
            ),
          ),
        ),
      );
      result.replaceChildren(
        table(
          [
            "Product / location",
            "On hand",
            "Reserved",
            "Available",
            "Inbound",
            "Reorder / target",
            "Actions",
          ],
          tableRows,
        ),
      );
      if (!rows.length)
        result.append(
          empty("No matching stock", "Try another name, barcode or filter."),
        );
    }
    draw();
    return root;
  }
  function showCount(row) {
    const m = modal(
        "Count warehouse stock",
        `${productName(row.productId)} / ${row.variant || "Standard"}`,
      ),
      onHand = qtyInput(input, row.onHand ?? "", {
        min: row.reserved || 0,
        max: 1_000_000_000,
      }),
      reorder = qtyInput(input, row.reorderPoint ?? 0),
      reason = el("textarea", { rows: 3, maxlength: 2000 });
    m.content.append(
      notice(
        `Count individual resalable units. ${row.reserved || 0} units are reserved; a physical count cannot fall below reservations.`,
      ),
      field("Physical on-hand quantity (each)", onHand),
      field("Reorder point (each)", reorder),
      field("Reason for adjustment", reason),
    );
    m.footer.append(
      button(
        "Save count online",
        async () => {
          m.guard();
          if (!reason.value.trim()) throw new Error("Enter a count reason.");
          await command("inventory.adjust", {
            productId: row.productId,
            variant: row.variant || "",
            onHand: warehouseQuantity(onHand.value, {
              min: row.reserved || 0,
              max: 1_000_000_000,
            }),
            reorderPoint: warehouseQuantity(reorder.value),
            reason: reason.value.trim(),
            expectedVersion: row.version ?? 0,
          });
          m.guard();
          m.close();
          toast("Warehouse count confirmed.");
        },
        "primary",
      ),
    );
  }
  function showConfiguration(row) {
    const m = modal(
        "Stock settings",
        `${productName(row.productId)} / ${row.variant || "Standard"}`,
      ),
      bin = input("text", row.warehouseBin || row.bin || "", {
        maxlength: 200,
      }),
      target = qtyInput(input, row.targetEach ?? row.target ?? "", {
        max: 1_000_000_000,
        placeholder: "Not configured",
      }),
      reorder = qtyInput(input, row.reorderPoint ?? 0);
    m.content.append(
      field("Warehouse bin / location", bin),
      field(
        "Target stock (each)",
        target,
        "Leave empty when the stock target is unknown.",
      ),
      field("Reorder point (each)", reorder),
    );
    m.footer.append(
      button(
        "Save settings",
        async () => {
          m.guard();
          await command("inventory.configure", {
            productId: row.productId,
            variant: row.variant || "",
            warehouseBin: bin.value.trim(),
            targetEach: warehouseQuantity(target.value, {
              nullable: true,
              max: 1_000_000_000,
            }),
            reorderPoint: warehouseQuantity(reorder.value),
            expectedVersion: row.version ?? 0,
          });
          m.guard();
          m.close();
          toast("Stock settings saved.");
        },
        "primary",
      ),
    );
  }
  function showMovements(row) {
    const m = modal(
      "Warehouse movements",
      `${productName(row.productId)} / ${row.variant || "Standard"}`,
    );
    const rows = (
      getData().movements ||
      getData().warehouseMovements ||
      []
    ).filter(
      (item) =>
        item.productId === row.productId &&
        (item.variant || "") === (row.variant || ""),
    );
    m.content.append(
      rows.length
        ? table(
            ["Date", "Movement", "Quantity (each)", "Reason"],
            rows.map((item) =>
              el(
                "tr",
                {},
                td(dateText(item.effectiveAt || item.createdAt)),
                td(item.kind || item.sourceType || "Adjustment"),
                td(quantityText(item.quantityEach ?? item.deltaEach)),
                td(item.reason || item.note || item.sourceId || "—"),
              ),
            ),
          )
        : notice(
            "No movements in the loaded history for this item. Older records may require a history refresh.",
          ),
    );
  }
  function purchaseCards(orders, receiveOnly = false) {
    return el(
      "div",
      { class: "purchase-list" },
      orders.map((po) =>
        el(
          "article",
          { class: "purchase-card" },
          el(
            "div",
            { class: "purchase-card-heading" },
            el(
              "div",
              {},
              el("h3", {}, purchaseTitle(po)),
              el("p", {}, supplierName(po)),
            ),
            badge(po.status),
          ),
          el(
            "div",
            { class: "purchase-meta" },
            el("span", {}, `${po.lines?.length || 0} line items`),
            el(
              "span",
              {},
              `Expected ${dateText(po.expectedDeliveryAt ?? po.expectedAt)}`,
            ),
            owner() ? el("span", {}, moneyText(po.totalCostCents)) : null,
          ),
          el(
            "div",
            { class: "actions" },
            button(
              receiveOnly ? "Open receiving" : "View purchase",
              () => showPurchase(po.id),
              "primary",
            ),
            OPEN.has(po.status) && !receiveOnly
              ? button("Receive", () => showPurchase(po.id, true))
              : null,
          ),
        ),
      ),
    );
  }
  function purchasing(receiveOnly = false) {
    const data = getData(),
      orders = (data.purchaseOrders || []).filter(
        (po) => !receiveOnly || OPEN.has(po.status),
      );
    return el(
      "div",
      { class: "screen" },
      heading(
        receiveOnly ? "Receive a delivery" : "Purchasing",
        receiveOnly
          ? "Match accepted and rejected goods to their saved purchase quantities."
          : "Prepare supplier orders and track the commitment through to receipt.",
        !receiveOnly && owner()
          ? [
              button(
                "Create purchase order",
                () => showPurchaseEditor(),
                "primary",
              ),
            ]
          : [],
      ),
      receiveOnly
        ? notice(
            "Record accepted goods separately from damage or rejection. Replacements remain outstanding until accepted.",
          )
        : null,
      orders.length
        ? purchaseCards(orders, receiveOnly)
        : empty(
            receiveOnly ? "Nothing awaiting receipt" : "No purchase orders yet",
            receiveOnly
              ? "Only ordered or partially received purchases are available here."
              : "Create a draft purchase order after configuring a supplier and its product mappings.",
          ),
      !receiveOnly ? renderSuggestions() : null,
    );
  }
  function renderSuggestions() {
    const data = getData(),
      suggestions = data.suggestions || [];
    return panel(
      el("h2", {}, "Stock-target suggestions"),
      el(
        "p",
        {},
        "Targets subtract available stock and confirmed inbound. Review supplier multiples before ordering.",
      ),
      suggestions.length
        ? el(
            "div",
            { class: "suggestions" },
            suggestions.slice(0, 30).map((item) =>
              el(
                "article",
                {},
                el("strong", {}, productName(item.productId)),
                el("p", {}, item.variant || "Standard"),
                el(
                  "p",
                  { class: "small" },
                  `${quantityText(item.targetEach)} target − ${quantityText(item.availableEach ?? item.available)} available − ${quantityText(item.confirmedInboundEach ?? item.inboundEach)} inbound`,
                ),
                el(
                  "p",
                  {},
                  item.suggestedQuantity != null
                    ? `Suggested ${item.suggestedQuantity} ${item.unit || "supplier units"}`
                    : item.suggestedEach != null
                      ? `${quantityText(item.suggestedEach)} each before supplier-unit rounding`
                      : "More information needed",
                ),
                (item.warnings || []).map((text) =>
                  el(
                    "p",
                    { class: "small muted" },
                    typeof text === "string"
                      ? text
                      : text.message || "Review ordering terms.",
                  ),
                ),
                item.missingInputs?.length
                  ? el(
                      "p",
                      { class: "small muted" },
                      `Configure: ${item.missingInputs.map((name) => ({ onHand: "physical count", reserved: "reservations", targetEach: "stock target", supplierProduct: "supplier product mapping", orderMultiple: "order multiple", packSize: "supplier case size", quantityLimit: "a supported purchase quantity" })[name] || name).join(", ")}.`,
                    )
                  : null,
                item.overdueOrders?.length
                  ? el(
                      "p",
                      { class: "small overdue" },
                      `Overdue purchases: ${item.overdueOrders.map((id) => purchaseTitle((data.purchaseOrders || []).find((po) => po.id === id) || { number: id })).join(", ")}. Confirm revised delivery dates before ordering more.`,
                    )
                  : null,
              ),
            ),
          )
        : notice(
            "No validated purchase suggestions are available. Configure physical stock, targets and supplier order multiples.",
          ),
    );
  }
  async function showPurchase(id, receiveNow = false) {
    const saved = scope(),
      m = modal(
        "Purchase order",
        "Saved supplier quantities and receipt history.",
      );
    const response = await api(
      `/api/warehouse/purchase-orders/${encodeURIComponent(id)}`,
    );
    if (!isCurrent(saved) || !m.dialog.open) return;
    const po = response.purchaseOrder;
    if (!po?.id) {
      m.content.append(notice("Purchase order could not be verified.", true));
      return;
    }
    m.content.replaceChildren(
      el(
        "div",
        { class: "purchase-detail-heading" },
        el("h3", {}, purchaseTitle(po)),
        badge(po.status),
      ),
      el("p", {}, supplierName(po)),
      el(
        "p",
        { class: "small" },
        `Expected ${dateText(po.expectedDeliveryAt ?? po.expectedAt)} · Revision ${po.version}`,
      ),
      table(
        [
          "Item",
          "Ordered",
          "Accepted",
          "Rejected",
          "Closed",
          "Outstanding",
          ...(owner() ? ["Cost / unit"] : []),
        ],
        (po.lines || []).map((line) =>
          el(
            "tr",
            {},
            td(
              el("strong", {}, line.name || productName(line.productId)),
              el("p", { class: "small" }, line.variant || "Standard"),
              el(
                "p",
                { class: "small muted" },
                `${line.unit}${line.unit === "case" ? ` · ${line.packSize ?? "unknown"} each per case` : ""}`,
              ),
            ),
            td(line.quantity),
            td(line.acceptedQuantity || 0),
            td(line.rejectedQuantity || 0),
            td(line.closedQuantity || 0),
            td(
              line.outstandingQuantity ??
                Math.max(
                  0,
                  line.quantity -
                    (line.acceptedQuantity || 0) -
                    (line.closedQuantity || 0),
                ),
            ),
            owner() ? td(moneyText(line.unitCostCents)) : null,
          ),
        ),
      ),
    );
    if (owner()) {
      m.content.append(
        el(
          "p",
          { class: "purchase-total" },
          `Total ${moneyText(po.totalCostCents)}`,
        ),
      );
      if (po.notes) m.content.append(el("p", {}, po.notes));
      m.footer.append(
        button("Download / print PO", async () => {
          m.guard();
          const blob = await api(
            `/api/warehouse/purchase-orders/${encodeURIComponent(po.id)}/document`,
            { blob: true },
          );
          m.guard();
          download(
            blob,
            `${purchaseTitle(po).replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`,
          );
        }),
      );
      if (po.status === "draft")
        m.footer.append(
          button("Edit draft", () => {
            m.guard();
            m.close();
            showPurchaseEditor(po);
          }),
          button("Mark ordered", () => showMarkOrdered(po, m), "primary"),
        );
      if (OPEN.has(po.status) || ["received", "closed"].includes(po.status))
        m.footer.append(button("Amend quantities", () => showAmend(po, m)));
      if (OPEN.has(po.status))
        m.footer.append(button("Close outstanding", () => showClose(po, m)));
    }
    const receipts = response.receipts || [];
    if (receipts.length)
      m.content.append(
        el("h3", { class: "section-spacer" }, "Receipt history"),
        el(
          "div",
          { class: "receipt-history" },
          receipts.map((receipt) =>
            el(
              "article",
              {},
              el(
                "strong",
                {},
                dateText(receipt.receivedAt || receipt.createdAt),
              ),
              el(
                "ul",
                {},
                (receipt.lines || []).map((line) =>
                  el(
                    "li",
                    {},
                    `${po.lines.find((item) => item.id === line.lineId)?.name || line.lineId}: ${line.acceptedQuantity || 0} accepted, ${line.rejectedQuantity || 0} rejected${line.rejectedQuantity ? ` · ${line.rejectedDisposition === "close" ? "quantity closed" : "replacement expected"}` : ""}`,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    if (po.amendments?.length)
      m.content.append(
        el("h3", { class: "section-spacer" }, "Amendment history"),
        el(
          "ul",
          {},
          po.amendments.map((item) =>
            el(
              "li",
              {},
              `${dateText(item.at || item.createdAt)} · ${item.reason || "Quantity amendment"}`,
            ),
          ),
        ),
      );
    if (OPEN.has(po.status))
      m.footer.append(
        button("Record delivery", () => showReceive(po, m), "primary"),
      );
    if (receiveNow && OPEN.has(po.status)) showReceive(po, m);
  }
  function showMarkOrdered(po, parent) {
    requireOwner();
    const m = modal("Confirm supplier order placed", purchaseTitle(po));
    m.content.append(
      notice(
        "Confirm only after placing this order with the supplier. This records a supplier commitment and confirmed inbound; it does not send an order or increase stock.",
      ),
      el("p", {}, `Supplier: ${supplierName(po)}`),
      el("p", {}, `Purchase total: ${moneyText(po.totalCostCents)}`),
    );
    m.footer.append(
      button("Cancel", m.close),
      button(
        "I placed this supplier order",
        async () => {
          m.guard();
          requireOwner();
          await command("purchase.order", {
            id: po.id,
            expectedVersion: po.version,
          });
          m.guard();
          m.close();
          parent.close();
          toast("Supplier order marked ordered.");
        },
        "primary",
      ),
    );
  }
  function showAmend(po, parent) {
    requireOwner();
    const m = modal(
      "Amend ordered quantities",
      "Saved product, pack and cost terms remain unchanged.",
    );
    const rows = po.lines.map((line) => ({
        line,
        control: qtyInput(input, line.quantity, {
          min: (line.acceptedQuantity || 0) + (line.closedQuantity || 0),
        }),
      })),
      reason = el("textarea", { rows: 3, maxlength: 2000 });
    m.content.append(
      ...rows.map(({ line, control }) =>
        field(
          `${line.name} / ${line.variant || "Standard"} (${line.unit})`,
          control,
        ),
      ),
      field("Reason for amendment", reason),
    );
    m.footer.append(
      button(
        "Save amendment",
        async () => {
          m.guard();
          requireOwner();
          if (!reason.value.trim())
            throw new Error("Enter the amendment reason.");
          await command("purchase.amend", {
            id: po.id,
            expectedVersion: po.version,
            reason: reason.value.trim(),
            lines: rows.map(({ line, control }) => ({
              lineId: line.id,
              quantity: warehouseQuantity(control.value, {
                min: (line.acceptedQuantity || 0) + (line.closedQuantity || 0),
              }),
            })),
          });
          m.guard();
          m.close();
          parent.close();
          toast("Purchase quantities amended.");
        },
        "primary",
      ),
    );
  }
  function showClose(po, parent) {
    requireOwner();
    const m = modal("Close outstanding quantities", purchaseTitle(po)),
      reason = el("textarea", { rows: 3, maxlength: 2000 });
    m.content.append(
      notice(
        "This closes every remaining supplier obligation on this purchase. It does not add stock or erase prior receipts.",
      ),
      field("Reason for closing", reason),
    );
    m.footer.append(
      button("Keep open", m.close),
      button(
        "Close remaining quantities",
        async () => {
          m.guard();
          requireOwner();
          if (!reason.value.trim())
            throw new Error("Enter why these quantities are being closed.");
          await command("purchase.close", {
            id: po.id,
            expectedVersion: po.version,
            reason: reason.value.trim(),
          });
          m.guard();
          m.close();
          parent.close();
          toast("Outstanding purchase quantities closed.");
        },
        "danger",
      ),
    );
  }
  function showReceive(po, parent) {
    const m = modal(
        "Record a supplier delivery",
        `${purchaseTitle(po)} · Quantities use the saved purchase unit.`,
      ),
      openedAt = Date.now(),
      received = input("date", localDate(openedAt), {
        max: localDate(openedAt),
      }),
      note = el("textarea", { rows: 3, maxlength: 2000 });
    const rows = po.lines
      .filter(
        (line) =>
          (line.outstandingQuantity ??
            line.quantity -
              (line.acceptedQuantity || 0) -
              (line.closedQuantity || 0)) > 0,
      )
      .map((line) => ({
        line,
        accepted: qtyInput(input, 0),
        rejected: qtyInput(input, 0),
        disposition: select(
          [
            ["replacement", "Replacement expected"],
            ...(owner() ? [["close", "Close rejected quantity"]] : []),
          ],
          "replacement",
        ),
      }));
    m.content.append(
      notice(
        "Only accepted goods increase resalable stock. Rejected goods stay out of inventory. A replacement remains part of the outstanding supplier order.",
      ),
      field("Delivery date", received),
      ...rows.map(({ line, accepted, rejected, disposition }) =>
        panel(
          el("h3", {}, `${line.name} / ${line.variant || "Standard"}`),
          el(
            "p",
            {},
            `${line.outstandingQuantity ?? line.quantity - (line.acceptedQuantity || 0) - (line.closedQuantity || 0)} ${line.unit} outstanding${line.unit === "case" ? ` · saved pack ${line.packSize} each` : ""}`,
          ),
          el(
            "div",
            { class: "form-grid" },
            field(`Accepted (${line.unit})`, accepted),
            field(`Rejected / damaged (${line.unit})`, rejected),
          ),
          field("For rejected goods", disposition),
        ),
      ),
      field("Receiving note", note),
    );
    m.footer.append(
      button(
        "Confirm receipt online",
        async () => {
          m.guard();
          const lines = prepareReceiptLines(
            po,
            rows.map(({ line, accepted, rejected, disposition }) => ({
              lineId: line.id,
              acceptedQuantity: accepted.value,
              rejectedQuantity: rejected.value,
              rejectedDisposition: disposition.value,
            })),
            owner(),
          );
          const receivedAt =
            received.value === localDate(openedAt)
              ? openedAt
              : new Date(received.value + "T12:00:00").getTime();
          if (!Number.isFinite(receivedAt) || receivedAt > Date.now())
            throw new Error("Choose a valid delivery date.");
          await command("purchase.receive", {
            id: po.id,
            expectedVersion: po.version,
            receivedAt,
            note: note.value.trim(),
            lines,
          });
          m.guard();
          m.close();
          parent.close();
          toast("Supplier receipt confirmed. Accepted stock is updated.");
        },
        "primary",
      ),
    );
  }
  function suppliers() {
    requireOwner();
    const data = getData();
    return el(
      "div",
      { class: "screen" },
      heading(
        "Suppliers",
        "Keep ordering terms separate from the customer catalog.",
        [
          button("Add supplier", () => showSupplier(), "primary"),
          button("Map a supplier product", () => showMapping()),
        ],
      ),
      data.suppliers?.length
        ? el(
            "div",
            { class: "supplier-grid" },
            data.suppliers.map((supplier) =>
              panel(
                el(
                  "div",
                  { class: "section-heading" },
                  el("h2", {}, supplier.name),
                  badge(supplier.active === false ? "Inactive" : "Active"),
                ),
                el("p", {}, supplier.contact || "No contact name"),
                el(
                  "p",
                  {},
                  supplier.email || supplier.phone || "No contact details",
                ),
                el(
                  "div",
                  { class: "actions" },
                  button("Edit supplier", () => showSupplier(supplier)),
                  button("Add product mapping", () =>
                    showMapping(null, supplier.id),
                  ),
                ),
              ),
            ),
          )
        : empty(
            "Add your first supplier",
            "Supplier products need confirmed units, pack sizes and ordering multiples before purchasing.",
          ),
      panel(
        el("h2", {}, "Supplier product mappings"),
        data.supplierProducts?.length
          ? table(
              [
                "Supplier",
                "Product / flavor",
                "Supplier SKU",
                "Order unit",
                "Multiple",
                "Unit cost",
                "",
              ],
              data.supplierProducts.map((mapping) =>
                el(
                  "tr",
                  {},
                  td(
                    data.suppliers.find(
                      (item) => item.id === mapping.supplierId,
                    )?.name || "Supplier",
                  ),
                  td(
                    productName(mapping.productId),
                    el("p", { class: "small" }, mapping.variant || "Standard"),
                  ),
                  td(mapping.supplierSku || "—"),
                  td(
                    mapping.unit === "case"
                      ? `Case (${mapping.packSize ?? "unknown"} each)`
                      : "Each",
                  ),
                  td(quantityText(mapping.orderMultiple)),
                  td(moneyText(mapping.unitCostCents)),
                  td(button("Edit mapping", () => showMapping(mapping))),
                ),
              ),
            )
          : notice("No supplier product mappings yet."),
      ),
    );
  }
  function showSupplier(existing = {}) {
    requireOwner();
    const m = modal(
      existing.id ? "Edit supplier" : "Add supplier",
      "Supplier details remain private to the owner.",
    );
    const values = {
      name: input("text", existing.name || "", { maxlength: 200 }),
      contact: input("text", existing.contact || "", { maxlength: 200 }),
      email: input("email", existing.email || "", { maxlength: 254 }),
      phone: input("tel", existing.phone || "", { maxlength: 100 }),
      terms: el("textarea", {
        value: existing.terms || "",
        maxlength: 4000,
        rows: 3,
      }),
      notes: el("textarea", {
        value: existing.notes || "",
        maxlength: 4000,
        rows: 3,
      }),
      active: input("checkbox", "", { checked: existing.active !== false }),
    };
    m.content.append(
      el(
        "div",
        { class: "form-grid" },
        field("Supplier name", values.name),
        field("Contact person", values.contact),
        field("Email", values.email),
        field("Phone", values.phone),
      ),
      field("Ordering terms", values.terms),
      field("Internal notes", values.notes),
      el("label", { class: "check" }, values.active, "Active supplier"),
    );
    m.footer.append(
      button(
        "Save supplier",
        async () => {
          m.guard();
          requireOwner();
          if (!values.name.value.trim())
            throw new Error("Enter the supplier name.");
          await command("supplier.save", {
            ...(existing.id
              ? { id: existing.id, expectedVersion: existing.version }
              : {}),
            ...Object.fromEntries(
              Object.entries(values).map(([key, node]) => [
                key,
                key === "active" ? node.checked : node.value.trim(),
              ]),
            ),
          });
          m.guard();
          m.close();
          toast("Supplier saved.");
        },
        "primary",
      ),
    );
  }
  function showMapping(existing = null, supplierId = "") {
    requireOwner();
    const data = getData();
    if (!data.suppliers?.length) throw new Error("Add a supplier first.");
    const value = existing || {},
      m = modal(
        existing ? "Edit supplier product" : "Map a supplier product",
        "Costs are per selected supplier order unit, not automatically per each.",
      );
    const supplier = select(
        data.suppliers.map((item) => [item.id, item.name]),
        value.supplierId || supplierId || data.suppliers[0].id,
      ),
      product = select(
        data.products
          .filter((item) => item.active !== false && !item.deleted)
          .map((item) => [item.id, item.name]),
        value.productId || data.products[0]?.id,
      ),
      variant = select([], value.variant || ""),
      sku = input("text", value.supplierSku || "", { maxlength: 200 }),
      unit = select(
        [
          ["each", "Each"],
          ["case", "Case"],
        ],
        value.unit || "each",
      ),
      pack = qtyInput(input, value.packSize ?? "", { placeholder: "Unknown" }),
      multiple = qtyInput(input, value.orderMultiple ?? "", {
        placeholder: "Unknown",
      }),
      cost = input(
        "text",
        value.unitCostCents == null
          ? ""
          : (value.unitCostCents / 100).toFixed(2),
        { inputmode: "decimal", placeholder: "Unknown" },
      ),
      lead = qtyInput(input, value.leadTimeDays ?? "", {
        placeholder: "Unknown",
      }),
      active = input("checkbox", "", { checked: value.active !== false });
    function updateVariants() {
      const selected = data.products.find((item) => item.id === product.value);
      variant.replaceChildren(
        ...variants(selected || {}).map((name) =>
          el("option", { value: name }, name || "Standard"),
        ),
      );
      if (selected?.id === value.productId) variant.value = value.variant || "";
    }
    product.addEventListener("change", updateVariants);
    updateVariants();
    m.content.append(
      el(
        "div",
        { class: "form-grid" },
        field("Supplier", supplier),
        field("Catalog product", product),
        field("Flavor", variant),
        field("Supplier SKU", sku),
        field("Order unit", unit),
        field(
          "Each per supplier case",
          pack,
          "Each units use 1. Cases require a known size before ordering.",
        ),
        field("Order multiple (selected unit)", multiple),
        field("Cost per selected unit ($)", cost),
        field("Lead time (days)", lead),
      ),
      el("label", { class: "check" }, active, "Active mapping"),
    );
    m.footer.append(
      button(
        "Save mapping",
        async () => {
          m.guard();
          requireOwner();
          await command("supplierProduct.save", {
            ...(value.id
              ? { id: value.id, expectedVersion: value.version }
              : {}),
            supplierId: supplier.value,
            productId: product.value,
            variant: variant.value,
            supplierSku: sku.value.trim(),
            unit: unit.value,
            packSize:
              unit.value === "each"
                ? 1
                : warehouseQuantity(pack.value, { nullable: true, min: 1 }),
            orderMultiple: warehouseQuantity(multiple.value, {
              nullable: true,
              min: 1,
            }),
            unitCostCents: warehouseMoney(cost.value),
            leadTimeDays: warehouseQuantity(lead.value, {
              nullable: true,
              max: 3650,
            }),
            active: active.checked,
          });
          m.guard();
          m.close();
          toast("Supplier product mapping saved.");
        },
        "primary",
      ),
    );
  }
  function showPurchaseEditor(existing = null) {
    requireOwner();
    const data = getData(),
      suppliers = (data.suppliers || []).filter(
        (item) => item.active !== false,
      );
    if (!suppliers.length)
      throw new Error(
        "Add an active supplier before creating a purchase order.",
      );
    const m = modal(
        existing ? "Edit purchase draft" : "Create a purchase draft",
        "A saved draft does not place an external order or change stock.",
      ),
      supplier = select(
        suppliers.map((item) => [item.id, item.name]),
        existing?.supplierId || suppliers[0].id,
      ),
      expected = input(
        "date",
        localDate(existing?.expectedDeliveryAt ?? existing?.expectedAt),
      ),
      notes = el("textarea", {
        value: existing?.notes || "",
        maxlength: 4000,
        rows: 3,
      }),
      items = el("div", { class: "purchase-entry-lines" });
    let entries = [];
    function draw() {
      entries = (data.supplierProducts || [])
        .filter(
          (mapping) =>
            mapping.supplierId === supplier.value && mapping.active !== false,
        )
        .map((mapping) => {
          const previous = existing?.lines?.find(
            (line) => line.supplierProductId === mapping.id,
          );
          return {
            mapping,
            id: previous?.id || crypto.randomUUID(),
            control: qtyInput(input, previous?.quantity || 0, {
              step: mapping.orderMultiple || 1,
            }),
          };
        });
      items.replaceChildren(
        ...entries.map(({ mapping, control }) =>
          el(
            "div",
            { class: "purchase-entry" },
            el(
              "div",
              {},
              el("strong", {}, productName(mapping.productId)),
              el(
                "p",
                { class: "small" },
                `${mapping.variant || "Standard"} · ${mapping.unit}${mapping.unit === "case" ? ` of ${mapping.packSize ?? "?"} each` : ""} · multiple ${mapping.orderMultiple ?? "unknown"} · ${moneyText(mapping.unitCostCents)}`,
              ),
            ),
            field("Quantity", control),
          ),
        ),
      );
      if (!entries.length)
        items.append(
          notice(
            "This supplier has no active product mappings. Add mappings in Suppliers first.",
          ),
        );
    }
    supplier.addEventListener("change", draw);
    draw();
    m.content.append(
      el(
        "div",
        { class: "form-grid" },
        field("Supplier", supplier),
        field("Expected delivery", expected),
      ),
      items,
      field("Purchase notes", notes),
    );
    m.footer.append(
      button(
        "Save purchase draft",
        async () => {
          m.guard();
          requireOwner();
          const expectedDeliveryAt = expected.value
            ? new Date(expected.value + "T12:00:00").getTime()
            : null;
          if (expected.value && !Number.isFinite(expectedDeliveryAt))
            throw new Error("Choose a valid delivery date.");
          const result = await command("purchase.save", {
            ...(existing
              ? { id: existing.id, expectedVersion: existing.version }
              : {}),
            supplierId: supplier.value,
            expectedDeliveryAt,
            notes: notes.value.trim(),
            lines: preparePurchaseLines(
              entries.map((entry) => ({
                ...entry,
                quantity: entry.control.value,
              })),
            ),
          });
          m.guard();
          m.close();
          toast(
            "Purchase draft saved. Place it with the supplier before marking it ordered.",
          );
          await showPurchase(result.id);
        },
        "primary",
      ),
    );
  }
  function render(view) {
    if (view === "stock") return stock();
    if (view === "purchasing") return purchasing();
    if (view === "receive") return purchasing(true);
    if (view === "suppliers") return suppliers();
    return overview();
  }
  return { render };
}
