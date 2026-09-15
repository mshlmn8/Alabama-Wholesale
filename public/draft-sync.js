// Draft autosave is deliberately separate from the queue for financial actions.
// An uncertain request keeps its exact ID and payload until its receipt resolves.
const clone = (value) => JSON.parse(JSON.stringify(value));
const validId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 250 &&
  !value.includes("/") &&
  !["__proto__", "constructor", "prototype"].includes(value);
const version = (value) => Number.isSafeInteger(value) && value >= 0;
const problem = (code, message) => Object.assign(new Error(message), { code });
const clean = (value) =>
  typeof value === "string" ? value.trim() : (value ?? "");
function body(draft) {
  return {
    id: draft.id,
    storeId: draft.storeId,
    lines: draft.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      variant: clean(line.variant),
      quantity: line.quantity,
      unit: line.unit ?? "each",
      note: clean(line.note),
    })),
    notes: clean(draft.notes),
  };
}
const bodyKey = (draft) => JSON.stringify(body(draft));
const intentKey = (draft) =>
  JSON.stringify([body(draft), draft.acknowledgeLegacyReview === true]);
function matches(draft, remote) {
  return (
    Array.isArray(remote?.lines) &&
    bodyKey(draft) === bodyKey(remote) &&
    (!draft.acknowledgeLegacyReview ||
      (!remote.legacy?.requiresReview && !remote.migrationBlocked))
  );
}
function validRecovery(id, record) {
  const command = record?.command,
    sent = record?.sentDraft,
    payload = command?.payload;
  if (
    !validId(id) ||
    !validId(command?.id) ||
    command.type !== "order.save" ||
    !payload ||
    payload.id !== id ||
    sent?.id !== id ||
    !validId(sent.storeId) ||
    payload.storeId !== sent.storeId ||
    !Array.isArray(sent.lines) ||
    !Array.isArray(payload.lines) ||
    !version(payload.expectedVersion) ||
    !version(sent.version ?? 0) ||
    payload.expectedVersion !== (sent.version ?? 0)
  )
    return false;
  try {
    return (
      intentKey(payload) === intentKey(sent) &&
      Object.keys(payload).every((key) =>
        [
          "id",
          "storeId",
          "lines",
          "notes",
          "expectedVersion",
          "acknowledgeLegacyReview",
        ].includes(key),
      )
    );
  } catch {
    return false;
  }
}

export function createDraftSync({
  workspace,
  send,
  isCurrent = () => true,
  online = () => navigator.onLine,
  onChange = () => {},
  delay = 600,
  maxWait = 2000,
  timers = {},
  uuid = () => crypto.randomUUID(),
}) {
  const setTimer =
    timers.setTimeout?.bind(timers) || globalThis.setTimeout.bind(globalThis);
  const clearTimer =
    timers.clearTimeout?.bind(timers) ||
    globalThis.clearTimeout.bind(globalThis);
  const now = timers.now?.bind(timers) || Date.now;
  const entries = new Map(),
    ready = new Map();
  let disposed = false,
    active = 0;
  const alive = (entry) =>
    !disposed && isCurrent() && (!entry || entries.get(entry.id) === entry);
  function changed(entry) {
    // A view update must not change the outcome of an acknowledged server save.
    if (alive(entry)) {
      try {
        onChange(entry.id);
      } catch {
        /* The view can recover on its next render. */
      }
    }
  }
  function cancel(entry) {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    ready.delete(entry.id);
  }
  function resolveWaiters(entry) {
    if (!entry.confirmedRemote) return;
    for (const waiter of entry.waiters.splice(0))
      waiter.resolve(clone(entry.confirmedRemote));
  }
  function rejectWaiters(entry, error) {
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
  }
  function stop(entry, phase, error) {
    cancel(entry);
    entry.phase = phase;
    entry.error = error;
    changed(entry);
    rejectWaiters(entry, error);
  }
  function localStatus(entry) {
    try {
      return workspace.localDraftStatus(entry.id);
    } catch (error) {
      entry.storageError = error;
      return { localPersisted: false, conflicted: false };
    }
  }
  function remember(entry, record) {
    if (!alive(entry)) return;
    try {
      workspace.rememberDraftSave(entry.id, record);
    } catch (error) {
      entry.storageError = error;
    }
  }
  function pendingRecord(entry) {
    const p = entry.pending;
    return p
      ? {
          command: clone(p.command),
          sentDraft: clone(p.sentDraft),
          attempts: p.attempts,
          ...(p.failure ? { failure: clone(p.failure) } : {}),
        }
      : null;
  }
  function create(draft) {
    const entry = {
      id: draft.id,
      latest: clone(draft),
      key: intentKey(draft),
      generation: 1,
      serverVersion: draft.version ?? 0,
      confirmedKey: null,
      confirmedRemote: null,
      confirmedGeneration: 0,
      pending: null,
      running: false,
      timer: null,
      firstDirty: now(),
      lastEdit: now(),
      phase: "dirty",
      error: null,
      storageError: null,
      paused: false,
      waiters: [],
      lastSavedAt: null,
      definitive: false,
      recoveryLoaded: false,
    };
    entries.set(entry.id, entry);
    return entry;
  }
  function isSaved(entry) {
    return (
      !entry.pending &&
      entry.confirmedKey === entry.key &&
      !["conflict", "blocked"].includes(entry.phase)
    );
  }
  function blocked(entry) {
    if (entry.phase === "conflict" || entry.error?.code === "INVALID_RECOVERY")
      return entry.error;
    if (localStatus(entry).conflicted)
      return problem(
        "LOCAL_CONFLICT",
        "This draft changed in another tab. Resolve the conflict before cloud saving.",
      );
    if (
      workspace
        .pending()
        .some(
          (item) =>
            ["order.save", "order.submit"].includes(item.command?.type) &&
            item.command.payload?.id === entry.id,
        )
    )
      return problem(
        "PENDING_COMMAND",
        "Resolve this draft’s pending action in Sync center first.",
      );
    if (
      entry.serverVersion === 0 &&
      (entry.latest.legacy?.requiresReview || entry.latest.migrationBlocked) &&
      entry.latest.acknowledgeLegacyReview !== true
    )
      return problem(
        "LEGACY_REVIEW_REQUIRED",
        "Review this recovered draft before its first cloud save.",
      );
    return null;
  }
  function check(entry) {
    let error;
    try {
      error = blocked(entry);
    } catch (e) {
      error = e;
    }
    if (!error) return true;
    stop(
      entry,
      [
        "LOCAL_CONFLICT",
        "VERSION_CONFLICT",
        "COMMAND_CONFLICT",
        "INVALID_TRANSITION",
      ].includes(error.code) || entry.phase === "conflict"
        ? "conflict"
        : "blocked",
      error,
    );
    return false;
  }
  function markDirty(entry, draft) {
    const key = intentKey(draft),
      different = key !== entry.key;
    entry.latest = clone(draft);
    if (different) {
      entry.key = key;
      entry.generation++;
      entry.lastEdit = now();
      if (entry.firstDirty === null) entry.firstDirty = now();
      if (entry.definitive && entry.phase !== "conflict") {
        entry.pending = null;
        entry.definitive = false;
        entry.error = null;
        remember(entry, null);
      }
    }
    return different;
  }
  function reconcileLocal(entry) {
    const latest = workspace.getDraft(entry.id);
    if (!latest) {
      stop(
        entry,
        "blocked",
        problem(
          "DRAFT_MISSING",
          "This draft is no longer available on this device.",
        ),
      );
      return false;
    }
    if (localStatus(entry).conflicted) {
      stop(
        entry,
        "conflict",
        problem(
          "LOCAL_CONFLICT",
          "This draft changed in another tab. Resolve the conflict before cloud saving.",
        ),
      );
      return false;
    }
    // A newer local tab edit wins before a request begins. Already-sent bodies
    // remain immutable and are acknowledged before this newer revision is sent.
    if ((latest.localRevision ?? 0) > (entry.latest.localRevision ?? 0))
      markDirty(entry, latest);
    else if (
      (latest.localRevision ?? 0) === (entry.latest.localRevision ?? 0) &&
      (latest.version ?? 0) >= (entry.latest.version ?? 0) &&
      intentKey(latest) === entry.key
    )
      entry.latest = clone(latest);
    if (!entry.pending && (latest.version ?? 0) > entry.serverVersion) {
      stop(
        entry,
        "conflict",
        problem(
          "VERSION_CONFLICT",
          "A newer cloud revision is available. Reload it before saving these edits.",
        ),
      );
      return false;
    }
    return true;
  }
  function schedule(entry, immediate = false, force = false) {
    if (!alive(entry) || entry.running || (entry.paused && !force)) return;
    cancel(entry);
    if (!check(entry)) return;
    if (isSaved(entry)) {
      entry.phase = "saved";
      entry.error = null;
      resolveWaiters(entry);
      changed(entry);
      return;
    }
    if (entry.definitive || (entry.pending?.attempts ?? 0) >= 5) return;
    if (!online()) {
      stop(
        entry,
        "offline",
        problem("OFFLINE", "Reconnect to save this draft to the cloud."),
      );
      return;
    }
    entry.phase = "dirty";
    entry.error = null;
    const wait = immediate
      ? 0
      : Math.max(
          0,
          Math.min(
            entry.lastEdit + delay,
            (entry.firstDirty ?? now()) + maxWait,
          ) - now(),
        );
    if (!wait) {
      ready.set(entry.id, entry);
      pump();
    } else
      entry.timer = setTimer(() => {
        entry.timer = null;
        ready.set(entry.id, entry);
        pump();
      }, wait);
    changed(entry);
  }
  function pump() {
    if (!alive()) return;
    while (active < 2 && ready.size) {
      const [id, entry] = ready.entries().next().value;
      ready.delete(id);
      if (alive(entry) && !entry.running) void run(entry);
    }
  }
  function responseOrder(response) {
    return (
      response?.result?.order || response?.result || response?.order || response
    );
  }
  function validateResponse(pending, remote) {
    if (
      remote?.id !== pending.sentDraft.id ||
      remote?.storeId !== pending.sentDraft.storeId ||
      remote?.status !== "draft" ||
      !Number.isSafeInteger(remote.version) ||
      remote.version !== pending.command.payload.expectedVersion + 1 ||
      !matches(pending.sentDraft, remote)
    )
      throw problem(
        "INVALID_CONFIRMATION",
        "The server response did not confirm this draft. Retry to check the original save.",
      );
  }
  function acknowledge(entry, sent, remote, generation, key) {
    entry.serverVersion = remote.version;
    entry.confirmedRemote = clone(remote);
    entry.confirmedKey = key;
    entry.confirmedGeneration = generation;
    entry.lastSavedAt = now();
    // Cloud success is independent of the browser cache. Keep the server version
    // even if storage becomes unavailable while the request is in flight.
    try {
      const acknowledged = workspace.ackCloudDraft(sent, remote)?.draft;
      if (
        acknowledged &&
        (acknowledged.localRevision ?? 0) >= (entry.latest.localRevision ?? 0)
      )
        markDirty(entry, acknowledged);
    } catch (error) {
      entry.storageError = error;
    }
    if ((entry.latest.version ?? 0) > remote.version) {
      entry.serverVersion = entry.latest.version;
      stop(
        entry,
        "conflict",
        problem(
          "VERSION_CONFLICT",
          "A newer cloud revision is already present on this device. Reload it before continuing.",
        ),
      );
      return;
    }
    entry.latest.version = remote.version;
    entry.latest.syncState = entry.key === key ? "synced" : "local";
    if (entry.key === key) {
      if (Object.hasOwn(remote, "legacy"))
        entry.latest.legacy = clone(remote.legacy);
      if (Object.hasOwn(remote, "migrationBlocked"))
        entry.latest.migrationBlocked = remote.migrationBlocked;
    }
    if (localStatus(entry).conflicted) {
      stop(
        entry,
        "conflict",
        problem(
          "LOCAL_CONFLICT",
          "Cloud save completed, but this device draft changed in another tab. Resolve it before continuing.",
        ),
      );
      return;
    }
    const remaining = [];
    for (const waiter of entry.waiters) {
      if (waiter.generation <= generation) waiter.resolve(clone(remote));
      else remaining.push(waiter);
    }
    entry.waiters = remaining;
  }
  async function run(entry) {
    if (!alive(entry) || !check(entry)) return;
    try {
      if (!reconcileLocal(entry)) return;
    } catch (error) {
      stop(entry, "blocked", error);
      return;
    }
    if (!online()) {
      stop(
        entry,
        "offline",
        problem("OFFLINE", "Reconnect to save this draft to the cloud."),
      );
      return;
    }
    if (isSaved(entry)) {
      entry.phase = "saved";
      resolveWaiters(entry);
      changed(entry);
      return;
    }
    if (!entry.pending) {
      const sentDraft = clone(entry.latest);
      sentDraft.version = entry.serverVersion;
      const payload = {
        ...body(sentDraft),
        expectedVersion: entry.serverVersion,
      };
      if (sentDraft.acknowledgeLegacyReview === true)
        payload.acknowledgeLegacyReview = true;
      entry.pending = {
        command: { id: uuid(), type: "order.save", payload },
        sentDraft,
        generation: entry.generation,
        key: entry.key,
        attempts: 0,
      };
      entry.firstDirty = null;
    }
    const pending = entry.pending;
    if (pending.attempts >= 5) {
      stop(
        entry,
        "error",
        problem(
          "RETRY_LIMIT",
          "Automatic retries paused. Retry this draft when the connection is ready.",
        ),
      );
      return;
    }
    entry.running = true;
    active++;
    pending.attempts++;
    entry.phase = "saving";
    entry.error = null;
    remember(entry, pendingRecord(entry));
    changed(entry);
    let retryDelay = null;
    try {
      if (!alive(entry)) {
        rejectWaiters(
          entry,
          problem("SESSION_CHANGED", "The signed-in account changed."),
        );
        return;
      }
      const remote = responseOrder(await send(clone(pending.command)));
      if (!alive(entry)) {
        rejectWaiters(
          entry,
          problem("SESSION_CHANGED", "The signed-in account changed."),
        );
        return;
      }
      validateResponse(pending, remote);
      entry.pending = null;
      entry.definitive = false;
      entry.error = null;
      acknowledge(
        entry,
        pending.sentDraft,
        remote,
        pending.generation,
        pending.key,
      );
      remember(entry, null);
      if (entry.phase !== "conflict")
        entry.phase = isSaved(entry) ? "saved" : "dirty";
    } catch (error) {
      if (!alive(entry)) {
        rejectWaiters(
          entry,
          problem("SESSION_CHANGED", "The signed-in account changed."),
        );
        return;
      }
      const status = Number(error.status || error.statusCode || 0);
      const conflict =
        status === 409 ||
        ["VERSION_CONFLICT", "COMMAND_CONFLICT", "INVALID_TRANSITION"].includes(
          error.code,
        );
      const definitive =
        status >= 400 && status < 500 && ![408, 425, 429].includes(status);
      entry.definitive = definitive;
      entry.error = error;
      if (conflict || definitive) {
        pending.failure = {
          kind: conflict ? "conflict" : "definitive",
          code: String(error.code || "SAVE_REJECTED"),
          message: String(error.message || "The draft save was rejected."),
          status,
        };
        remember(entry, pendingRecord(entry));
      }
      if (conflict) stop(entry, "conflict", error);
      else if (definitive || pending.attempts >= 5) stop(entry, "error", error);
      else if (!online())
        stop(
          entry,
          "offline",
          problem("OFFLINE", "Reconnect to finish checking this draft save."),
        );
      else {
        entry.phase = "error";
        retryDelay = Math.min(30000, 1000 * 2 ** (pending.attempts - 1));
      }
    } finally {
      entry.running = false;
      active--;
      if (alive(entry)) {
        changed(entry);
        if (
          retryDelay !== null &&
          (!entry.paused || entry.waiters.length > 0)
        ) {
          cancel(entry);
          entry.timer = setTimer(() => {
            entry.timer = null;
            schedule(entry, true, entry.waiters.length > 0);
          }, retryDelay);
        } else if (!entry.pending && entry.phase === "dirty")
          schedule(entry, entry.waiters.length > 0, entry.waiters.length > 0);
      }
      pump();
    }
  }
  function stage(draft) {
    if (
      !alive() ||
      !validId(draft?.id) ||
      !validId(draft.storeId) ||
      !Array.isArray(draft.lines) ||
      !version(draft.version ?? 0)
    )
      return;
    let entry = entries.get(draft.id);
    if (!entry) entry = create(draft);
    else {
      if ((draft.localRevision ?? 0) < (entry.latest.localRevision ?? 0))
        return;
      const different = markDirty(entry, draft);
      if (
        !different &&
        (entry.timer !== null || entry.running || isSaved(entry))
      ) {
        changed(entry);
        return;
      }
    }
    if (
      entry.phase === "conflict" ||
      entry.error?.code === "INVALID_RECOVERY"
    ) {
      changed(entry);
      return;
    }
    schedule(entry);
  }
  function seed(remoteDrafts = []) {
    if (!alive()) return;
    const remoteById = new Map(
      remoteDrafts
        .filter(
          (d) =>
            validId(d?.id) &&
            d.status === "draft" &&
            Array.isArray(d.lines) &&
            version(d.version),
        )
        .map((d) => [d.id, d]),
    );
    const locals = workspace.listDrafts(),
      recovery = workspace.autosaveRecovery();
    for (const draft of locals) {
      if (
        !validId(draft?.id) ||
        !validId(draft.storeId) ||
        !Array.isArray(draft.lines)
      )
        continue;
      let entry = entries.get(draft.id);
      if (!entry) entry = create(draft);
      else if ((draft.localRevision ?? 0) >= (entry.latest.localRevision ?? 0))
        markDirty(entry, draft);
      if (!entry.recoveryLoaded) {
        entry.recoveryLoaded = true;
        const record = Object.hasOwn(recovery, draft.id)
          ? recovery[draft.id]
          : null;
        if (record) {
          if (!validRecovery(draft.id, record)) {
            stop(
              entry,
              "blocked",
              problem(
                "INVALID_RECOVERY",
                "This draft has an invalid recovery record. Export it before resolving recovery.",
              ),
            );
            continue;
          }
          const sentDraft = clone(record.sentDraft),
            same = intentKey(sentDraft) === entry.key;
          entry.pending = {
            command: clone(record.command),
            sentDraft,
            generation: same ? entry.generation : 0,
            key: intentKey(sentDraft),
            attempts:
              Number.isInteger(record.attempts) && record.attempts >= 0
                ? record.attempts
                : 0,
          };
          entry.serverVersion = record.command.payload.expectedVersion;
          if (["conflict", "definitive"].includes(record.failure?.kind)) {
            entry.pending.failure = clone(record.failure);
            entry.error = problem(
              String(record.failure.code || "SAVE_REJECTED"),
              String(
                record.failure.message ||
                  "Review the rejected draft save before retrying.",
              ),
            );
            entry.error.status = Number(record.failure.status) || 400;
            entry.definitive = true;
            entry.phase =
              record.failure.kind === "conflict" ? "conflict" : "error";
          }
        }
      }
      if (
        entry.running ||
        entry.phase === "conflict" ||
        entry.error?.code === "INVALID_RECOVERY"
      )
        continue;
      const remote = remoteById.get(entry.id);
      if (remote && remote.version >= entry.serverVersion) {
        if (
          matches(entry.latest, remote) &&
          (!entry.pending || matches(entry.pending.sentDraft, remote))
        ) {
          entry.pending = null;
          entry.error = null;
          acknowledge(entry, entry.latest, remote, entry.generation, entry.key);
          remember(entry, null);
          if (entry.phase !== "conflict") entry.phase = "saved";
          cancel(entry);
          changed(entry);
          continue;
        }
        if (
          entry.pending &&
          remote.version ===
            entry.pending.command.payload.expectedVersion + 1 &&
          matches(entry.pending.sentDraft, remote)
        ) {
          const pending = entry.pending;
          entry.pending = null;
          entry.error = null;
          acknowledge(
            entry,
            pending.sentDraft,
            remote,
            pending.generation,
            pending.key,
          );
          remember(entry, null);
        } else if (remote.version > entry.serverVersion) {
          stop(
            entry,
            "conflict",
            problem(
              "VERSION_CONFLICT",
              "This draft has newer edits in the cloud. Reload them before saving.",
            ),
          );
          continue;
        }
      }
      schedule(entry);
    }
  }
  function status(id) {
    const entry = entries.get(id);
    if (!entry)
      return {
        phase: "blocked",
        localPersisted: false,
        cloudConfirmed: false,
        error: null,
        serverVersion: 0,
        lastSavedAt: null,
      };
    const local = localStatus(entry);
    let same = true;
    try {
      const latest = workspace.getDraft(id);
      same = !!latest && intentKey(latest) === entry.key;
    } catch (error) {
      entry.storageError = error;
    }
    return {
      phase: local.conflicted
        ? "conflict"
        : !same && entry.phase === "saved"
          ? "dirty"
          : entry.phase,
      localPersisted: local.localPersisted,
      cloudConfirmed: !local.conflicted && same && isSaved(entry),
      error: entry.error?.message || entry.storageError?.message || null,
      code: entry.error?.code || null,
      serverVersion: entry.serverVersion,
      lastSavedAt: entry.lastSavedAt,
    };
  }
  function flush(id) {
    if (!alive())
      return Promise.reject(
        problem("SESSION_CHANGED", "The signed-in account changed."),
      );
    const entry = entries.get(id);
    if (!entry)
      return Promise.reject(
        problem(
          "DRAFT_MISSING",
          "This draft is not available for cloud saving.",
        ),
      );
    if (!check(entry)) return Promise.reject(entry.error);
    try {
      if (!reconcileLocal(entry)) return Promise.reject(entry.error);
    } catch (error) {
      return Promise.reject(error);
    }
    if (isSaved(entry)) return Promise.resolve(clone(entry.confirmedRemote));
    if (!online()) {
      stop(
        entry,
        "offline",
        problem("OFFLINE", "Reconnect to save this draft to the cloud."),
      );
      return Promise.reject(entry.error);
    }
    if (entry.definitive || (entry.pending?.attempts ?? 0) >= 5)
      return Promise.reject(entry.error);
    const promise = new Promise((resolve, reject) =>
      entry.waiters.push({ generation: entry.generation, resolve, reject }),
    );
    schedule(entry, true, true);
    return promise;
  }
  function retry(id) {
    if (id === undefined)
      return Promise.all([...entries.keys()].map((key) => retry(key)));
    const entry = entries.get(id);
    if (!entry)
      return Promise.reject(
        problem("DRAFT_MISSING", "This draft is not available."),
      );
    if (!alive())
      return Promise.reject(
        problem("SESSION_CHANGED", "The signed-in account changed."),
      );
    if (!check(entry)) return Promise.reject(entry.error);
    if (entry.pending) {
      entry.pending.attempts = 0;
      delete entry.pending.failure;
    }
    entry.definitive = false;
    entry.error = null;
    entry.phase = "dirty";
    return flush(id);
  }
  function resume() {
    if (alive())
      for (const entry of entries.values())
        if (!entry.running) schedule(entry, true);
  }
  function pause(id) {
    const entry = entries.get(id);
    if (entry) {
      entry.paused = true;
      cancel(entry);
    }
  }
  function unpause(id) {
    const entry = entries.get(id);
    if (entry) {
      entry.paused = false;
      schedule(entry);
    }
  }
  function forget(id) {
    const entry = entries.get(id);
    if (!entry) return;
    cancel(entry);
    remember(entry, null);
    rejectWaiters(
      entry,
      problem("DRAFT_REMOVED", "This draft was closed or submitted."),
    );
    entries.delete(id);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const entry of entries.values()) {
      cancel(entry);
      rejectWaiters(
        entry,
        problem("SESSION_CHANGED", "The signed-in account changed."),
      );
    }
    ready.clear();
  }
  return {
    stage,
    seed,
    get: (id) =>
      entries.has(id) ? clone(entries.get(id).latest) : workspace.getDraft(id),
    status,
    flush,
    retry,
    resume,
    pause,
    unpause,
    forget,
    dispose,
    hasUnsaved: () =>
      !disposed &&
      [...entries.values()].some((entry) => !status(entry.id).cloudConfirmed),
  };
}
