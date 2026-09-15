const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
let nextId = 0;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, className, action) {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}
function field(labelText, input, hint) {
  const container = node("div", "catalog-photo-field");
  const label = node("label", "", labelText);
  input.id = `catalog-photo-field-${++nextId}`;
  label.htmlFor = input.id;
  container.append(label, input);
  if (hint) container.append(node("p", "catalog-photo-hint", hint));
  return container;
}
function normalized(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}
function textInput(maxLength) {
  const input = node("input");
  input.type = "text";
  input.maxLength = maxLength;
  return input;
}
function extracted(result) {
  const details = result?.details;
  if (!details || typeof details !== "object")
    throw new Error(
      "The photo details were incomplete. Try analyzing it again.",
    );
  const clean = {};
  for (const [key, limit] of [
    ["name", 300],
    ["variant", 200],
    ["barcode", 200],
  ]) {
    if (typeof details[key] !== "string" || details[key].length > limit)
      throw new Error(
        "The photo details were incomplete. Try analyzing it again.",
      );
    clean[key] = details[key].trim();
  }
  if (
    details.packSize !== null &&
    (!Number.isSafeInteger(details.packSize) ||
      details.packSize < 1 ||
      details.packSize > 1000000)
  )
    throw new Error(
      "The case quantity could not be read. Try analyzing the photo again.",
    );
  clean.packSize = details.packSize;
  return clean;
}

/** Photo analysis prepares an editor; only the caller's normal product save persists changes. */
export function createCatalogPhoto({
  request,
  getScope,
  isCurrent,
  getProducts,
  readImageFile,
  onReview,
}) {
  let elements = null,
    scope = null,
    sourceProductId = null;
  let file = null,
    image = null,
    previewUrl = null,
    result = null;
  let sequence = 0,
    controller = null,
    reading = false,
    analyzing = false,
    reviewing = false;
  let disposed = false,
    watch = null,
    cleanupViewport = null,
    previousFocus = null,
    failed = false;

  function current(captured = scope) {
    try {
      return (
        !disposed &&
        !!elements?.dialog.isConnected &&
        !!elements.dialog.open &&
        !!captured &&
        isCurrent(captured)
      );
    } catch {
      return false;
    }
  }
  function products() {
    const seen = new Set();
    return (getProducts?.() || []).filter((product) => {
      if (
        !product ||
        product.active === false ||
        product.deleted ||
        typeof product.id !== "string" ||
        !product.id ||
        typeof product.name !== "string" ||
        seen.has(product.id)
      )
        return false;
      seen.add(product.id);
      return true;
    });
  }
  function revokePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  function reset() {
    sequence++;
    controller?.abort();
    controller = null;
    clearInterval(watch);
    watch = null;
    cleanupViewport?.();
    cleanupViewport = null;
    const dialog = elements?.dialog;
    elements = null;
    if (dialog?.open) dialog.close();
    dialog?.remove();
    revokePreview();
    file = image = result = scope = sourceProductId = null;
    reading = analyzing = reviewing = failed = false;
    const focus = previousFocus;
    previousFocus = null;
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }
  function ensureCurrent() {
    if (current()) return true;
    reset();
    return false;
  }
  function showError(error) {
    if (!elements) return;
    elements.error.textContent = String(
      error?.message ||
        error ||
        "The photo could not be analyzed. Please try again.",
    ).slice(0, 500);
    elements.error.hidden = false;
  }
  function update() {
    if (!elements) return;
    const busy = reading || analyzing || reviewing;
    elements.dialog.setAttribute("aria-busy", String(busy));
    elements.action.disabled = busy || !file || !image;
    elements.action.textContent = reading
      ? "Reading photo…"
      : analyzing
        ? "Analyzing…"
        : reviewing
          ? "Opening review…"
          : result
            ? "Review product"
            : failed
              ? "Try again"
              : "Analyze photo";
    elements.status.textContent = reading
      ? "Preparing your photo…"
      : analyzing
        ? "Gemini is reading the package…"
        : reviewing
          ? "Opening the product editor…"
          : "";
    elements.review.hidden = !result;
    elements.again.hidden = !result;
    elements.again.disabled = busy;
    elements.fileInput.disabled = reviewing;
    elements.context.disabled = reviewing;
    elements.review.querySelectorAll("input, select").forEach((input) => {
      input.disabled = reviewing;
    });
    updateMode();
    elements.footnote.textContent = result
      ? "Review pricing next. Nothing is added until you save the product."
      : "Check the details before saving. Pricing is reviewed in the product editor.";
  }
  function invalidateAnalysis() {
    sequence++;
    controller?.abort();
    controller = null;
    analyzing = false;
    result = null;
    failed = false;
    if (elements) elements.error.hidden = true;
    update();
  }
  async function chooseFile() {
    if (!ensureCurrent() || reviewing) return;
    const selected = elements.fileInput.files?.[0];
    invalidateAnalysis();
    const attempt = sequence,
      captured = scope;
    revokePreview();
    file = image = null;
    elements.preview.hidden = true;
    elements.previewImage.removeAttribute("src");
    if (!selected) {
      reading = false;
      update();
      return;
    }
    reading = true;
    update();
    try {
      if (!IMAGE_TYPES.has(selected.type))
        throw new Error("Choose a JPEG, PNG or WebP photo.");
      if (!selected.size || selected.size > MAX_IMAGE_BYTES)
        throw new Error("Choose a photo smaller than 5 MB.");
      const prepared = await readImageFile(selected);
      if (attempt !== sequence) return;
      if (!current(captured)) {
        reset();
        return;
      }
      if (
        !IMAGE_TYPES.has(prepared?.mimeType) ||
        typeof prepared.data !== "string" ||
        !prepared.data ||
        prepared.data.length > 7 * 1024 * 1024
      )
        throw new Error("The photo could not be read. Choose another photo.");
      file = selected;
      image = { mimeType: prepared.mimeType, data: prepared.data };
      previewUrl = URL.createObjectURL(selected);
      const selectedUrl = previewUrl;
      elements.previewImage.onerror = () => {
        if (
          selected !== file ||
          selectedUrl !== previewUrl ||
          !current(captured)
        )
          return;
        invalidateAnalysis();
        file = image = null;
        reading = false;
        revokePreview();
        elements.preview.hidden = true;
        showError(
          "This file could not be opened as a photo. Choose another image.",
        );
        update();
      };
      elements.previewImage.src = previewUrl;
      elements.fileName.textContent = selected.name;
      elements.preview.hidden = false;
    } catch (error) {
      if (attempt !== sequence) return;
      if (!current(captured)) {
        reset();
        return;
      }
      showError(error);
    } finally {
      if (attempt === sequence) {
        reading = false;
        update();
      }
    }
  }
  function mode() {
    return elements?.existingMode.checked ? "existing" : "new";
  }
  function filterProducts() {
    if (!elements) return;
    const selected = elements.product.value;
    const all = products();
    const query = normalized(elements.search.value);
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = all.filter((product) =>
      terms.every((term) =>
        normalized(
          `${product.name} ${product.sku || ""} ${product.barcode || ""}`,
        ).includes(term),
      ),
    );
    matches.sort((a, b) => {
      const score = (product) =>
        normalized(product.name) === query
          ? 0
          : normalized(product.name).startsWith(query)
            ? 1
            : 2;
      return score(a) - score(b) || a.name.localeCompare(b.name);
    });
    const kept = all.find((product) => product.id === selected);
    const options =
      kept && !matches.some((product) => product.id === kept.id)
        ? [kept, ...matches]
        : matches;
    elements.product.replaceChildren(
      new Option("Choose an existing product", ""),
      ...options.map((product) => new Option(product.name, product.id)),
    );
    elements.product.value = kept ? kept.id : "";
    elements.matches.textContent = `${matches.length} matching ${matches.length === 1 ? "product" : "products"}${kept && !matches.includes(kept) ? ". Your selected product is kept." : "."}`;
  }
  function updateMode() {
    if (!elements) return;
    const existing = mode() === "existing";
    elements.existing.hidden = !existing;
    elements.nameField.hidden = existing;
    elements.packField.hidden = existing;
    elements.name.disabled = reviewing || existing;
    elements.packSize.disabled = reviewing || existing;
    elements.name.required = !existing;
    elements.variant.required = existing;
    elements.preserve.hidden = !existing;
  }
  async function analyze() {
    if (
      reading ||
      analyzing ||
      reviewing ||
      !ensureCurrent() ||
      !file ||
      !image
    )
      return;
    if (navigator.onLine === false) {
      failed = true;
      showError(
        "You’re offline. Reconnect, then try analyzing this photo again.",
      );
      update();
      return;
    }
    const text = elements.context.value.trim();
    if (text.length > 2000) {
      showError("Keep the photo instructions under 2,000 characters.");
      return;
    }
    if (
      sourceProductId &&
      !products().some((product) => product.id === sourceProductId)
    ) {
      showError(
        "This product is no longer available. Reopen the photo tool from the catalog.",
      );
      return;
    }
    const attempt = ++sequence,
      captured = scope,
      selectedFile = file;
    controller = new AbortController();
    const signal = controller.signal;
    analyzing = true;
    failed = false;
    result = null;
    elements.error.hidden = true;
    update();
    try {
      const response = await request("/api/assistant/catalog-photo", {
        method: "POST",
        body: {
          image,
          ...(text ? { text } : {}),
          ...(sourceProductId ? { productId: sourceProductId } : {}),
        },
        signal,
      });
      if (attempt !== sequence || selectedFile !== file) return;
      if (!current(captured)) {
        reset();
        return;
      }
      const details = extracted(response);
      result = details;
      for (const key of ["name", "variant", "barcode"])
        elements[key].value = details[key];
      elements.packSize.value = details.packSize ?? "";
      const all = products();
      const match =
        all.find((product) => product.id === sourceProductId) ||
        all.find((product) => product.id === response.matchedProductId);
      elements.search.value = "";
      elements.product.replaceChildren(
        new Option("Choose an existing product", ""),
        ...all.map((product) => new Option(product.name, product.id)),
      );
      elements.product.value = match?.id || "";
      elements.existingMode.checked = !!match;
      elements.newMode.checked = !match;
      filterProducts();
      updateMode();
      const warnings = Array.isArray(response.warnings)
        ? response.warnings
            .filter((value) => typeof value === "string" && value.trim())
            .slice(0, 12)
        : [];
      elements.warnings.replaceChildren(
        ...warnings.map((warning) => node("li", "", warning.slice(0, 500))),
      );
      elements.warningBox.hidden = !warnings.length;
    } catch (error) {
      if (attempt !== sequence) return;
      if (!current(captured)) {
        reset();
        return;
      }
      failed = true;
      showError(
        error?.code === "NETWORK" || error?.name === "TypeError"
          ? "Could not reach Gemini. Check your connection, then try again."
          : error?.name === "AbortError"
            ? "The photo analysis stopped. Please try again."
            : error,
      );
    } finally {
      if (attempt === sequence) {
        controller = null;
        analyzing = false;
        update();
        if (result && current(captured)) {
          elements.reviewTitle.focus({ preventScroll: true });
          elements.review.scrollIntoView({
            block: "start",
            behavior: "instant",
          });
        }
      }
    }
  }
  async function review() {
    if (reviewing || analyzing || !result || !file || !ensureCurrent()) return;
    const attempt = sequence,
      captured = scope;
    elements.error.hidden = true;
    const details = {
      name: elements.name.value.trim(),
      variant: elements.variant.value.trim(),
      barcode: elements.barcode.value.trim(),
      packSize:
        elements.packSize.value === "" ? null : Number(elements.packSize.value),
    };
    const productId = mode() === "existing" ? elements.product.value : null;
    if (productId) {
      details.name = result.name;
      details.packSize = result.packSize;
    }
    try {
      if (
        productId === "" ||
        (productId && !products().some((product) => product.id === productId))
      )
        throw new Error("Choose an existing product from the current catalog.");
      if (!productId && !details.name) {
        elements.name.focus();
        throw new Error("Enter a product name before continuing.");
      }
      if (productId && !details.variant) {
        elements.variant.focus();
        throw new Error("Enter the flavor or variant to add to this product.");
      }
      if (!productId && !elements.packSize.validity.valid) {
        elements.packSize.focus();
        throw new Error(
          "Case quantity must be a whole number from 1 to 1,000,000, or left blank.",
        );
      }
      extracted({ details });
      reviewing = true;
      update();
      await onReview({ productId, details, file }, () => {
        if (attempt === sequence && current(captured)) reset();
      });
    } catch (error) {
      if (attempt === sequence && current(captured)) showError(error);
      else if (attempt === sequence) reset();
    } finally {
      if (attempt === sequence) {
        reviewing = false;
        update();
      }
    }
  }
  function open({ productId } = {}) {
    if (disposed) return;
    reset();
    const captured = getScope();
    if (!captured || !isCurrent(captured)) return;
    scope = captured;
    sourceProductId =
      typeof productId === "string" && productId ? productId : null;
    previousFocus = document.activeElement;
    const dialog = node("dialog", "catalog-photo");
    const titleId = `catalog-photo-title-${++nextId}`;
    dialog.setAttribute("aria-labelledby", titleId);
    const shell = node("div", "catalog-photo-shell");
    const header = node("header", "catalog-photo-header");
    const heading = node("div");
    const title = node("h2", "", "Add from photo");
    title.id = titleId;
    heading.append(
      node("p", "catalog-photo-kicker", "GEMINI · CATALOG"),
      title,
      node(
        "p",
        "catalog-photo-description",
        "Photograph the label. Review the details. Add it to your catalog.",
      ),
    );
    const close = button("×", "catalog-photo-close", reset);
    close.setAttribute("aria-label", "Close photo product tool");
    header.append(heading, close);
    const body = node("div", "catalog-photo-body");
    const fileInput = node("input");
    fileInput.type = "file";
    fileInput.accept = [...IMAGE_TYPES].join(",");
    fileInput.addEventListener("change", chooseFile);
    const preview = node("div", "catalog-photo-preview");
    preview.hidden = true;
    const previewImage = node("img");
    previewImage.alt = "Selected product photo";
    const previewText = node("div");
    const fileName = node("strong", "catalog-photo-filename");
    previewText.append(
      fileName,
      node(
        "p",
        "catalog-photo-hint",
        "Use a clear photo of the product name, flavor and barcode.",
      ),
    );
    preview.append(previewImage, previewText);
    const context = node("textarea");
    context.rows = 2;
    context.maxLength = 2000;
    context.placeholder =
      "Brand, flavor, size, or anything that is hard to read";
    context.addEventListener("input", () => {
      if (!ensureCurrent()) return;
      if (analyzing || result || failed) invalidateAnalysis();
    });
    const again = button(
      "Analyze this photo again",
      "text-button catalog-photo-again",
      analyze,
    );
    again.hidden = true;
    const error = node("p", "catalog-photo-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const status = node("p", "catalog-photo-status");
    status.setAttribute("role", "status");
    const reviewPanel = node("section", "catalog-photo-review");
    reviewPanel.hidden = true;
    const reviewTitle = node("h3", "", "Check the photo details");
    reviewTitle.tabIndex = -1;
    const warningBox = node("div", "catalog-photo-warnings");
    warningBox.hidden = true;
    const warnings = node("ul");
    warningBox.append(node("strong", "", "Check before continuing"), warnings);
    const choice = node("fieldset", "catalog-photo-choice");
    choice.append(node("legend", "", "How should this be added?"));
    const radioName = `catalog-photo-mode-${++nextId}`;
    const newMode = node("input"),
      existingMode = node("input");
    for (const [input, value, label] of [
      [newMode, "new", "New product"],
      [existingMode, "existing", "Add a flavor to an existing product"],
    ]) {
      input.type = "radio";
      input.name = radioName;
      input.value = value;
      input.addEventListener("change", updateMode);
      const option = node("label");
      option.append(input, node("span", "", label));
      choice.append(option);
    }
    newMode.checked = true;
    const existing = node("div", "catalog-photo-existing");
    const search = node("input");
    search.type = "search";
    search.placeholder = "Find the product by name or code";
    search.addEventListener("input", filterProducts);
    const product = node("select");
    const matches = node("p", "catalog-photo-hint");
    const preserve = node(
      "p",
      "catalog-photo-preserve",
      "The existing product’s name, case size, prices and photo will be kept. Review the new flavor’s pricing next.",
    );
    existing.append(
      field("Search existing products", search),
      field("Existing product", product),
      matches,
      preserve,
    );
    const name = textInput(300),
      variant = textInput(200),
      barcode = textInput(200),
      packSize = node("input");
    barcode.inputMode = "text";
    packSize.type = "number";
    packSize.min = "1";
    packSize.max = "1000000";
    packSize.step = "1";
    packSize.inputMode = "numeric";
    packSize.placeholder = "Not shown";
    const details = node("div", "catalog-photo-details");
    const nameField = field("Product name", name),
      packField = field(
        "Units per case",
        packSize,
        "Leave blank if the photo does not show it.",
      );
    details.append(
      nameField,
      field("Flavor / variant", variant),
      field("Barcode", barcode),
      packField,
    );
    reviewPanel.append(reviewTitle, warningBox, choice, existing, details);
    body.append(
      field(
        "Product photo",
        fileInput,
        "JPEG, PNG or WebP · up to 5 MB. Choose a photo or use your camera.",
      ),
      preview,
      field("Photo instructions (optional)", context),
      again,
      error,
      status,
      reviewPanel,
    );
    const footer = node("footer", "catalog-photo-footer");
    const footnote = node("p", "catalog-photo-hint");
    const actions = node("div", "catalog-photo-actions");
    const action = button("Analyze photo", "primary", () =>
      result ? review() : analyze(),
    );
    actions.append(button("Cancel", "", reset), action);
    footer.append(footnote, actions);
    shell.append(header, body, footer);
    dialog.append(shell);
    elements = {
      dialog,
      fileInput,
      preview,
      previewImage,
      fileName,
      context,
      again,
      error,
      status,
      review: reviewPanel,
      reviewTitle,
      warningBox,
      warnings,
      newMode,
      existingMode,
      existing,
      search,
      product,
      matches,
      preserve,
      name,
      nameField,
      variant,
      barcode,
      packSize,
      packField,
      action,
      footnote,
    };
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      reset();
    });
    dialog.addEventListener("close", () => {
      if (elements?.dialog === dialog) reset();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        reset();
    });
    const viewport = window.visualViewport;
    const position = () => {
      dialog.style.setProperty(
        "--catalog-photo-viewport-height",
        `${viewport?.height || innerHeight}px`,
      );
      dialog.style.setProperty(
        "--catalog-photo-viewport-top",
        `${viewport?.offsetTop || 0}px`,
      );
    };
    const offline = () => {
      if (!current()) {
        reset();
        return;
      }
      if (analyzing) {
        invalidateAnalysis();
        failed = true;
        showError(
          "Connection lost. Reconnect, then try analyzing this photo again.",
        );
        update();
      }
    };
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    window.addEventListener("resize", position);
    window.addEventListener("offline", offline);
    cleanupViewport = () => {
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      window.removeEventListener("offline", offline);
    };
    document.body.append(dialog);
    position();
    dialog.showModal();
    updateMode();
    update();
    fileInput.focus({ preventScroll: true });
    watch = setInterval(() => {
      if (!current()) reset();
    }, 500);
  }
  return {
    open,
    reset,
    dispose() {
      reset();
      disposed = true;
    },
  };
}
