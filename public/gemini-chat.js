const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_LENGTH = 30000;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function symbol(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute(
    "d",
    {
      spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
      close: "m6 6 12 12M18 6 6 18",
      send: "M12 20V4M5 11l7-7 7 7",
    }[name],
  );
  svg.append(path);
  return svg;
}

function historyForRequest(messages) {
  let history = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, text }) => ({ role, text }));
  while (
    history.reduce((length, item) => length + item.text.length, 0) >
    MAX_HISTORY_LENGTH
  )
    history = history.slice(2);
  return history;
}

/**
 * request(path, { method, body, signal }) must use the app's authenticated API.
 * getScope captures the signed-in session and optional storeId/storeName.
 * isCurrent compares both the session generation and selected store.
 * Call reset at every identity change, including signing back into the same UID.
 */
export function createGeminiChat({ request, getScope, isCurrent }) {
  let conversationScope = null;
  let messages = [];
  let composerValue = "";
  let pending = null;
  let failure = null;
  let sequence = 0;
  let elements = null;
  let disposed = false;

  function current(scope) {
    return !disposed && !!scope && isCurrent(scope);
  }

  function close() {
    const dialog = elements?.dialog;
    if (!dialog) return;
    elements = null;
    if (dialog.open) dialog.close();
    dialog.remove();
  }

  function reset() {
    sequence++;
    pending?.controller.abort();
    pending = null;
    messages = [];
    failure = null;
    composerValue = "";
    conversationScope = null;
    close();
  }

  function refreshScope() {
    if (conversationScope && !current(conversationScope)) reset();
  }

  function scrollToLatest() {
    if (elements)
      elements.transcript.scrollTop = elements.transcript.scrollHeight;
  }

  function render() {
    if (!elements) return;
    const { transcript, welcome, send, input, status, error, retry, clear } =
      elements;
    welcome.hidden = messages.length > 0 || !!pending || !!failure;
    const visibleMessages = [
      ...messages,
      ...(pending || failure
        ? [
            {
              id: (pending || failure).id,
              role: "user",
              text: (pending || failure).text,
            },
          ]
        : []),
    ];
    const visibleIds = new Set(visibleMessages.map((item) => String(item.id)));
    transcript.querySelectorAll("[data-message-id]").forEach((item) => {
      if (!visibleIds.has(item.dataset.messageId)) item.remove();
    });
    for (const message of visibleMessages) {
      if (transcript.querySelector(`[data-message-id="${message.id}"]`))
        continue;
      const item = node("article", `gemini-chat-message is-${message.role}`);
      item.dataset.messageId = message.id;
      item.append(
        node(
          "div",
          "gemini-chat-speaker",
          message.role === "user" ? "You" : "Gemini",
        ),
        node("p", "gemini-chat-message-text", message.text),
      );
      transcript.append(item);
    }
    input.disabled = !!pending;
    send.disabled = !!pending || !input.value.trim();
    send.setAttribute(
      "aria-label",
      pending ? "Waiting for Gemini" : "Send message",
    );
    clear.disabled = !messages.length && !pending && !failure && !composerValue;
    status.textContent = pending ? "Gemini is thinking…" : "";
    error.hidden = !failure;
    error.querySelector("p").textContent = failure?.message || "";
    retry.disabled = !!pending;
    transcript.setAttribute("aria-busy", String(!!pending));
  }

  function errorMessage(error) {
    if (error?.code === "NETWORK" || error?.name === "TypeError")
      return "Could not reach Gemini. Check your connection, then try again.";
    if (error?.name === "AbortError")
      return "Gemini took too long to respond. Please try again.";
    return String(
      error?.message || "Gemini could not reply. Please try again.",
    ).slice(0, 400);
  }

  async function sendMessage(retryFailed = false) {
    if (pending || disposed) return;
    refreshScope();
    if (!elements) return;
    const text = (retryFailed ? failure?.text : elements.input.value)?.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) return;
    const scope = getScope();
    if (!current(scope)) {
      reset();
      return;
    }
    conversationScope = scope;
    const attempt = {
      id: retryFailed ? failure.id : ++sequence,
      generation: ++sequence,
      text,
      scope,
      controller: new AbortController(),
    };
    pending = attempt;
    failure = null;
    if (!retryFailed) {
      composerValue = "";
      elements.input.value = "";
    }
    resizeComposer();
    render();
    scrollToLatest();
    try {
      const result = await request("/api/assistant/chat", {
        method: "POST",
        body: {
          text,
          history: historyForRequest(messages),
          ...(scope.storeId ? { storeId: scope.storeId } : {}),
        },
        signal: attempt.controller.signal,
      });
      if (pending !== attempt || sequence !== attempt.generation) return;
      if (!current(scope)) {
        reset();
        return;
      }
      const reply = typeof result?.text === "string" ? result.text.trim() : "";
      if (!reply || reply.length > 12000)
        throw new Error(
          "Gemini returned an incomplete response. Please try again.",
        );
      messages.push(
        { id: attempt.id, role: "user", text },
        { id: ++sequence, role: "model", text: reply },
      );
      pending = null;
      render();
      scrollToLatest();
    } catch (error) {
      if (pending !== attempt || sequence !== attempt.generation) return;
      if (!current(scope)) {
        reset();
        return;
      }
      failure = { id: attempt.id, text, message: errorMessage(error) };
      pending = null;
      render();
      elements?.error.scrollIntoView({ block: "nearest" });
    }
  }

  function resizeComposer() {
    if (!elements) return;
    const input = elements.input;
    input.style.height = "auto";
    input.style.height = `${Math.min(140, Math.max(48, input.scrollHeight))}px`;
  }

  function open() {
    if (disposed) return;
    refreshScope();
    if (elements?.dialog.open) {
      elements.input.focus();
      return;
    }
    const scope = getScope();
    if (!current(scope)) return;
    conversationScope ||= scope;
    const previousFocus = document.activeElement?.matches("body, html")
      ? document.querySelector(".gemini-launch")
      : document.activeElement;
    const dialog = node("dialog", "gemini-chat");
    dialog.setAttribute("aria-labelledby", "gemini-chat-title");
    dialog.setAttribute("aria-describedby", "gemini-chat-context");
    const shell = node("div", "gemini-chat-shell");
    const header = node("header", "gemini-chat-header");
    const brand = node("span", "gemini-chat-mark");
    brand.append(symbol("spark"));
    const heading = node("div", "gemini-chat-heading");
    const title = node("h2", "", "Chat with Gemini");
    title.id = "gemini-chat-title";
    const context = node(
      "p",
      "",
      scope.storeName
        ? `${scope.storeName} · Alabama Wholesale`
        : "Alabama Wholesale",
    );
    context.id = "gemini-chat-context";
    heading.append(title, context);
    const dismiss = node("button", "gemini-chat-close");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Close Gemini chat");
    dismiss.append(symbol("close"));
    dismiss.addEventListener("click", close);
    header.append(brand, heading, dismiss);

    const transcript = node("div", "gemini-chat-transcript");
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-label", "Conversation with Gemini");
    transcript.setAttribute("aria-live", "polite");
    transcript.setAttribute("aria-relevant", "additions");
    transcript.tabIndex = 0;
    const welcome = node("section", "gemini-chat-welcome");
    welcome.append(
      node("p", "gemini-chat-eyebrow", "Your ordering assistant"),
      node("h3", "", "A little help, right here."),
      node("p", "", "Ask about products, building an order, or using the app."),
    );
    const starters = node("div", "gemini-chat-starters");
    for (const [label, prompt] of [
      ["Find a product", "Help me find "],
      ["Finish an order", "How do I finish and submit an order?"],
      ["Understand saved drafts", "How do saved drafts work?"],
    ]) {
      const starter = node("button", "", label);
      starter.type = "button";
      starter.addEventListener("click", () => {
        input.value = prompt;
        composerValue = prompt;
        input.focus();
        resizeComposer();
        render();
      });
      starters.append(starter);
    }
    welcome.append(starters);
    transcript.append(welcome);

    const responseState = node("div", "gemini-chat-response-state");
    const status = node("p", "gemini-chat-status");
    status.setAttribute("role", "status");
    const error = node("div", "gemini-chat-error");
    error.hidden = true;
    const errorText = node("p");
    errorText.setAttribute("role", "alert");
    const retry = node("button", "", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => sendMessage(true));
    const edit = node("button", "", "Edit message");
    edit.type = "button";
    edit.addEventListener("click", () => {
      if (!failure) return;
      composerValue = failure.text;
      input.value = composerValue;
      failure = null;
      render();
      resizeComposer();
      input.focus();
    });
    const errorActions = node("div", "gemini-chat-error-actions");
    errorActions.append(retry, edit);
    error.append(errorText, errorActions);
    responseState.append(status, error);

    const footer = node("footer", "gemini-chat-footer");
    const form = node("form", "gemini-chat-composer");
    const label = node("label", "gemini-chat-input-label", "Message Gemini");
    label.htmlFor = "gemini-chat-input";
    const input = node("textarea", "gemini-chat-input");
    input.id = "gemini-chat-input";
    input.rows = 1;
    input.maxLength = MAX_MESSAGE_LENGTH;
    input.placeholder = "Ask Gemini…";
    input.value = composerValue;
    input.setAttribute("autocapitalize", "sentences");
    input.addEventListener("input", () => {
      composerValue = input.value;
      resizeComposer();
      render();
    });
    input.addEventListener("keydown", (event) => {
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.isComposing &&
        matchMedia("(hover: hover) and (pointer: fine)").matches
      ) {
        event.preventDefault();
        sendMessage();
      }
    });
    const send = node("button", "gemini-chat-send");
    send.type = "submit";
    send.setAttribute("aria-label", "Send message");
    send.append(symbol("send"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage();
    });
    form.append(label, input, send);
    const footnote = node("div", "gemini-chat-footnote");
    const sessionNote = node(
      "p",
      "",
      "Chat lasts for this session. Review important details.",
    );
    const clear = node("button", "gemini-chat-clear", "Clear chat");
    clear.type = "button";
    clear.addEventListener("click", () => {
      sequence++;
      pending?.controller.abort();
      pending = null;
      messages = [];
      failure = null;
      composerValue = "";
      input.value = "";
      render();
      resizeComposer();
      input.focus();
    });
    footnote.append(sessionNote, clear);
    footer.append(responseState, form, footnote);
    shell.append(header, transcript, footer);
    dialog.append(shell);
    elements = {
      dialog,
      transcript,
      welcome,
      input,
      send,
      status,
      error,
      retry,
      clear,
    };
    const viewport = window.visualViewport;
    function updateViewport() {
      if (!viewport || !matchMedia("(max-width: 600px)").matches) {
        dialog.style.removeProperty("--chat-viewport-height");
        dialog.style.removeProperty("--chat-viewport-top");
        return;
      }
      dialog.style.setProperty(
        "--chat-viewport-height",
        `${viewport.height}px`,
      );
      dialog.style.setProperty(
        "--chat-viewport-top",
        `${viewport.offsetTop}px`,
      );
    }
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    dialog.addEventListener("close", () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      dialog.remove();
      if (elements?.dialog === dialog) elements = null;
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
        close();
    });
    document.body.append(dialog);
    render();
    updateViewport();
    dialog.showModal();
    resizeComposer();
    scrollToLatest();
    // Do not open a phone keyboard before the user chooses to write.
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) input.focus();
    else dismiss.focus();
  }

  function dispose() {
    reset();
    disposed = true;
  }

  return { open, close, reset, refreshScope, dispose };
}
