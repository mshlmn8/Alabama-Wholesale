const clone = (value) => JSON.parse(JSON.stringify(value));
const validId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 250 &&
  !["__proto__", "prototype", "constructor"].includes(value) &&
  !value.includes("/");
const empty = () => ({
  format: "aw-workspace",
  version: 1,
  revision: 0,
  drafts: {},
  queue: [],
  preferences: {},
});
export class StorageFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "StorageFailure";
  }
}
export class DraftConflict extends Error {
  constructor() {
    super(
      "This draft changed in another tab. Reload the saved draft before editing.",
    );
    this.name = "DraftConflict";
  }
}
export class Workspace {
  constructor(storage, key) {
    this.storage = storage;
    this.key = `aw:v2:${key}`;
    this.remoteDrafts = new Map();
    this.workingDrafts = new Map();
    this.retiredDrafts = new Map();
    this.confirmedOrderVersions = new Map();
    this.recoveryOverrides = new Map();
    this.temporaryPreferences = {};
    this.writeWarning = null;
    this.read();
  }
  read() {
    let raw;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      throw new StorageFailure(
        "Browser storage is unavailable. Your changes cannot be saved on this device.",
      );
    }
    if (!raw) return empty();
    try {
      const data = JSON.parse(raw);
      if (
        data.format !== "aw-workspace" ||
        data.version !== 1 ||
        !data.drafts ||
        !Array.isArray(data.queue)
      )
        throw new Error();
      return data;
    } catch {
      throw new StorageFailure(
        "The saved workspace could not be read. Export the browser data before clearing storage.",
      );
    }
  }
  mutate(fn) {
    const data = this.read();
    const result = fn(data);
    data.revision++;
    this.write(data);
    return clone(result ?? data);
  }
  write(data) {
    if (this.storage.status?.().conflicted) throw new DraftConflict();
    try {
      this.storage.setItem(this.key, JSON.stringify(data));
    } catch {
      this.writeWarning =
        "Could not save on this device. Browser storage may be full or unavailable. Export your draft and try again.";
      throw new StorageFailure(this.writeWarning);
    }
    this.writeWarning = null;
  }
  storageStatus() {
    const backend = this.storage.status?.();
    const data = this.workingDrafts.size || backend ? this.read() : null;
    const workingUnprotectedCount = [...this.workingDrafts].filter(
      ([id, entry]) =>
        entry.draft.syncState !== "synced" || this.workingConflict(data, id),
    ).length;
    const committed = backend
      ? JSON.parse(this.storage.committedItem(this.key) || "null")
      : null;
    const databaseOnly = backend
      ? Object.values(data.drafts).filter(
          (draft) =>
            !this.workingDrafts.has(draft.id) &&
            (backend.conflicted ||
              JSON.stringify(committed?.drafts?.[draft.id]) !==
                JSON.stringify(draft)),
        )
      : [];
    const unprotectedDraftCount =
      workingUnprotectedCount +
      databaseOnly.filter(
        (draft) => draft.syncState !== "synced" || backend.conflicted,
      ).length;
    const cloudOnlyDraftCount =
      [...this.remoteDrafts.keys()].filter((id) => !this.workingDrafts.has(id))
        .length +
      this.workingDrafts.size -
      workingUnprotectedCount +
      databaseOnly.filter(
        (draft) => draft.syncState === "synced" && !backend.conflicted,
      ).length;
    const remoteDraftCount = this.remoteDrafts.size;
    const preferencesTemporary =
      Object.keys(this.temporaryPreferences).length > 0;
    return {
      warning:
        this.storage.databaseUnavailable ||
        backend?.warning ||
        this.writeWarning ||
        (remoteDraftCount ||
        preferencesTemporary ||
        this.workingDrafts.size ||
        this.recoveryOverrides.size
          ? "Some cloud drafts or preferences are available only in this session because device storage could not save them. Your existing saved work is preserved."
          : null),
      remoteDraftCount,
      cloudOnlyDraftCount,
      unprotectedDraftCount,
      temporaryRecoveryCount: this.recoveryOverrides.size,
      preferencesTemporary,
    };
  }
  durableBase(data, id) {
    const current = Object.hasOwn(data.drafts, id) ? data.drafts[id] : null;
    return {
      exists: !!current,
      localRevision: current?.localRevision || 0,
      version: current?.version || 0,
      fingerprint: current ? JSON.stringify(current) : null,
    };
  }
  workingConflict(data, id) {
    const entry = this.workingDrafts.get(id);
    return (
      !!entry &&
      JSON.stringify(entry.base) !== JSON.stringify(this.durableBase(data, id))
    );
  }
  localDraftStatus(id) {
    const data = this.read();
    this.draftView(data);
    let committed = true;
    if (this.storage.committedItem) {
      const saved = JSON.parse(this.storage.committedItem(this.key) || "null");
      committed =
        JSON.stringify(saved?.drafts?.[id]) === JSON.stringify(data.drafts[id]);
    }
    return {
      localPersisted:
        committed &&
        !this.storage.status?.().conflicted &&
        !this.workingDrafts.has(id) &&
        !this.remoteDrafts.has(id) &&
        Object.hasOwn(data.drafts, id),
      conflicted:
        !!this.storage.status?.().conflicted || this.workingConflict(data, id),
    };
  }
  draftView(data) {
    for (const [id, entry] of this.remoteDrafts) {
      const local = Object.hasOwn(data.drafts, id) ? data.drafts[id] : null;
      if (
        local
          ? local.syncState !== "synced" ||
            (local.localRevision || 0) !== entry.localRevision ||
            (local.version || 0) >= (entry.draft.version || 0)
          : entry.hadLocal
      )
        this.remoteDrafts.delete(id);
    }
    const view = {
      ...data.drafts,
      ...Object.fromEntries(
        [...this.remoteDrafts].map(([id, entry]) => [id, entry.draft]),
      ),
      ...Object.fromEntries(
        [...this.workingDrafts].map(([id, entry]) => [id, entry.draft]),
      ),
    };
    for (const [id, retired] of this.retiredDrafts) {
      const current = view[id];
      if (
        current?.syncState === "synced" &&
        JSON.stringify(current) === retired.fingerprint &&
        JSON.stringify(this.durableBase(data, id)) ===
          JSON.stringify(retired.base) &&
        !this.draftHasPending(data, id)
      )
        delete view[id];
      else this.retiredDrafts.delete(id);
    }
    return view;
  }
  draftHasPending(data, id) {
    return !!(
      data.queue.some(
        (entry) =>
          entry.command?.payload?.id === id ||
          entry.command?.payload?.orderId === id,
      ) ||
      data.draftAutosave?.[id] ||
      this.recoveryOverrides.get(id)
    );
  }
  getDraft(id) {
    const drafts = this.draftView(this.read());
    return clone(Object.hasOwn(drafts, id) ? drafts[id] : null);
  }
  listDrafts() {
    return Object.values(this.draftView(this.read()))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(clone);
  }
  prepareDraft(data, draft) {
    if (!validId(draft?.id) || !Array.isArray(draft.lines))
      throw new Error("Invalid draft.");
    if (this.workingConflict(data, draft.id)) throw new DraftConflict();
    if (
      data.queue.some(
        (entry) =>
          entry.command.type === "order.submit" &&
          entry.command.payload.id === draft.id,
      )
    )
      throw new Error(
        "This draft is being submitted. Wait for confirmation or retry the pending submission before editing it.",
      );
    const current = this.draftView(data)[draft.id];
    if (this.retiredDrafts.has(draft.id))
      throw new Error(
        "This order was submitted or closed elsewhere. Open the confirmed order or start a new draft.",
      );
    if (
      current &&
      ((draft.localRevision ?? 0) !== (current.localRevision ?? 0) ||
        (this.remoteDrafts.has(draft.id) &&
          !this.workingDrafts.has(draft.id) &&
          (draft.version || 0) !== (current.version || 0)))
    )
      throw new DraftConflict();
    return {
      ...clone(draft),
      localRevision: (current?.localRevision || 0) + 1,
      syncState: "local",
      updatedAt: Date.now(),
    };
  }
  saveDraft(draft) {
    const saved = this.mutate((data) => {
      const next = this.prepareDraft(data, draft);
      data.drafts[next.id] = next;
      return next;
    });
    this.remoteDrafts.delete(saved.id);
    this.workingDrafts.delete(saved.id);
    return saved;
  }
  saveDraftForCloud(draft) {
    const data = this.read();
    const saved = this.prepareDraft(data, draft);
    const base =
      this.workingDrafts.get(saved.id)?.base ||
      this.durableBase(data, saved.id);
    data.drafts[saved.id] = saved;
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      this.workingDrafts.set(saved.id, { draft: saved, base });
      return { draft: clone(saved), localPersisted: false };
    }
    this.remoteDrafts.delete(saved.id);
    this.workingDrafts.delete(saved.id);
    return {
      draft: clone(saved),
      localPersisted: this.localDraftStatus(saved.id).localPersisted,
    };
  }
  ackCloudDraft(sent, remote) {
    if (
      remote?.id !== sent?.id ||
      remote.status !== "draft" ||
      !Number.isSafeInteger(remote.version)
    )
      throw new Error("Invalid cloud draft confirmation.");
    const data = this.read();
    const current = this.draftView(data)[sent.id];
    if (!current) return { draft: null, localPersisted: false };
    if ((current.version || 0) > remote.version)
      return { draft: clone(current), ...this.localDraftStatus(sent.id) };
    const same = current.localRevision === sent.localRevision;
    // A fresh cloud read is not a new local edit. Rewriting an identical synced
    // copy only to update lastSyncedAt can create a quota warning at sign-in.
    if (
      same &&
      current.version === remote.version &&
      current.syncState === "synced" &&
      ["legacy", "migrationBlocked"].every(
        (key) =>
          !Object.hasOwn(remote, key) ||
          JSON.stringify(current[key]) === JSON.stringify(remote[key]),
      )
    )
      return { draft: clone(current), ...this.localDraftStatus(sent.id) };
    const updated = {
      ...clone(current),
      version: remote.version,
      syncState: same ? "synced" : "local",
      lastSyncedAt: Date.now(),
    };
    if (same) {
      if (Object.hasOwn(remote, "legacy"))
        updated.legacy = clone(remote.legacy);
      if (Object.hasOwn(remote, "migrationBlocked"))
        updated.migrationBlocked = remote.migrationBlocked;
    }
    const base =
      this.workingDrafts.get(sent.id)?.base || this.durableBase(data, sent.id);
    if (this.workingConflict(data, sent.id)) {
      this.workingDrafts.set(sent.id, { draft: updated, base });
      return { draft: clone(updated), localPersisted: false };
    }
    data.drafts[sent.id] = updated;
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      this.workingDrafts.set(sent.id, { draft: updated, base });
      return { draft: clone(updated), localPersisted: false };
    }
    this.remoteDrafts.delete(sent.id);
    this.workingDrafts.delete(sent.id);
    return {
      draft: clone(updated),
      localPersisted: this.localDraftStatus(updated.id).localPersisted,
    };
  }
  reloadDraftFromCloud(remote, expectedLocalRevision) {
    if (
      !validId(remote?.id) ||
      remote.status !== "draft" ||
      !Array.isArray(remote.lines)
    )
      throw new Error("Invalid cloud draft.");
    const data = this.read(),
      current = this.draftView(data)[remote.id];
    if (
      (current?.localRevision || 0) !== expectedLocalRevision ||
      this.workingConflict(data, remote.id)
    )
      throw new DraftConflict();
    if (
      data.queue.some(
        (entry) =>
          ["order.save", "order.submit"].includes(entry.command.type) &&
          entry.command.payload.id === remote.id,
      )
    )
      throw new Error(
        "Resolve this draft’s pending action in Sync center first.",
      );
    const updated = {
      ...clone(remote),
      localRevision: (current?.localRevision || 0) + 1,
      syncState: "synced",
      lastSyncedAt: Date.now(),
    };
    const base = this.durableBase(data, remote.id);
    data.drafts[remote.id] = updated;
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      this.workingDrafts.set(remote.id, { draft: updated, base });
      this.remoteDrafts.delete(remote.id);
      return { draft: clone(updated), localPersisted: false };
    }
    this.remoteDrafts.delete(remote.id);
    this.workingDrafts.delete(remote.id);
    return {
      draft: clone(updated),
      localPersisted: this.localDraftStatus(updated.id).localPersisted,
    };
  }
  autosaveRecovery() {
    const records = { ...(this.read().draftAutosave || {}) };
    for (const [id, record] of this.recoveryOverrides) {
      if (record === null) delete records[id];
      else records[id] = clone(record);
    }
    return clone(records);
  }
  rememberDraftSave(id, record) {
    if (
      !validId(id) ||
      (record !== null &&
        (record?.command?.type !== "order.save" ||
          record.command.payload?.id !== id ||
          record.sentDraft?.id !== id))
    )
      throw new Error("Invalid draft save recovery record.");
    const data = this.read();
    const durable = Object.hasOwn(data.draftAutosave || {}, id)
      ? data.draftAutosave[id]
      : null;
    if (JSON.stringify(durable) === JSON.stringify(record)) {
      this.recoveryOverrides.delete(id);
      return true;
    }
    this.recoveryOverrides.set(id, record === null ? null : clone(record));
    data.draftAutosave = this.autosaveRecovery();
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      return false;
    }
    this.recoveryOverrides.clear();
    return true;
  }
  removeDraft(id) {
    this.mutate((data) => {
      delete data.drafts[id];
    });
    this.remoteDrafts.delete(id);
    this.workingDrafts.delete(id);
  }
  retireConfirmedDraft(order) {
    // Absence from a list is not proof of submission: use a canonical order read.
    if (
      !validId(order?.id) ||
      !validId(order.storeId) ||
      !["submitted", "approved", "picking", "delivered", "cancelled"].includes(
        order.status,
      ) ||
      !Number.isSafeInteger(order.version) ||
      order.version < 1
    )
      return { retired: false, reason: "unconfirmed" };
    const data = this.read();
    const current = this.draftView(data)[order.id];
    if (!current) return { retired: false, reason: "missing" };
    if (
      current.storeId !== order.storeId ||
      (current.version || 0) > order.version
    )
      return { retired: false, reason: "stale" };
    if (this.workingConflict(data, order.id))
      return { retired: false, reason: "conflict" };
    if (current.syncState !== "synced")
      return { retired: false, reason: "dirty" };
    if (this.draftHasPending(data, order.id))
      return { retired: false, reason: "pending" };
    const retirement = {
      fingerprint: JSON.stringify(current),
      base: this.durableBase(data, order.id),
    };
    if (Object.hasOwn(data.drafts, order.id)) {
      delete data.drafts[order.id];
      data.revision++;
      // A failed write must leave both the durable copy and session overlays intact.
      try {
        this.write(data);
      } catch (error) {
        if (!(error instanceof StorageFailure)) throw error;
        // Hide only this exact clean cache from editing/autosave. Keep the original
        // bytes and overlays recoverable until a successful storage retry.
        this.retiredDrafts.set(order.id, retirement);
        this.confirmedOrderVersions.set(order.id, order.version);
        return { retired: true, localPersisted: false };
      }
    }
    this.remoteDrafts.delete(order.id);
    this.workingDrafts.delete(order.id);
    this.recoveryOverrides.delete(order.id);
    this.retiredDrafts.delete(order.id);
    this.confirmedOrderVersions.set(order.id, order.version);
    const committed = this.storage.committedItem
      ? JSON.parse(this.storage.committedItem(this.key) || "null")
      : null;
    return { retired: true, localPersisted: !committed?.drafts?.[order.id] };
  }
  markDraftSynced(id, localRevision, remote) {
    this.mutate((data) => {
      const current = data.drafts[id];
      if (!current) return;
      current.version = remote.version ?? current.version;
      current.syncState =
        current.localRevision === localRevision ? "synced" : "local";
      current.lastSyncedAt = Date.now();
    });
  }
  mergeRemoteDrafts(drafts) {
    const data = this.read();
    const current = this.draftView(data);
    const changes = new Map();
    for (const remote of drafts) {
      if (
        remote.status !== "draft" ||
        !validId(remote.id) ||
        (this.confirmedOrderVersions.has(remote.id) &&
          (remote.version || 0) <=
            this.confirmedOrderVersions.get(remote.id)) ||
        this.workingDrafts.has(remote.id)
      )
        continue;
      const local = current[remote.id];
      if (
        !local ||
        (local.syncState === "synced" &&
          (remote.version || 0) > (local.version || 0))
      ) {
        const durable = Object.hasOwn(data.drafts, remote.id)
          ? data.drafts[remote.id]
          : null;
        // A temporary cache keeps the durable base revision so another tab's
        // successful edit cannot share its revision and be overwritten.
        const localRevision = durable?.localRevision || 0;
        const draft = { ...clone(remote), localRevision, syncState: "synced" };
        changes.set(remote.id, { draft, localRevision, hadLocal: !!durable });
        current[remote.id] = draft;
      }
    }
    if (!changes.size) return;
    for (const [id, entry] of changes)
      data.drafts[id] = {
        ...entry.draft,
        localRevision: entry.localRevision + 1,
      };
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      for (const [id, entry] of changes) this.remoteDrafts.set(id, entry);
      return;
    }
    for (const id of changes.keys()) this.remoteDrafts.delete(id);
  }
  enqueue(command, metadata = {}) {
    if (!command?.id || !command.type) throw new Error("Invalid command.");
    return this.mutate((data) => {
      const found = data.queue.find((entry) => entry.command.id === command.id);
      if (found) {
        if (JSON.stringify(found.command) !== JSON.stringify(command))
          throw new Error(
            "Cannot reuse a command ID for a different operation.",
          );
        return found;
      }
      const entry = {
        command: clone(command),
        metadata: clone(metadata),
        createdAt: Date.now(),
        error: null,
      };
      data.queue.push(entry);
      return entry;
    });
  }
  pending() {
    return clone(this.read().queue);
  }
  fail(id, error, code = "", status = null) {
    this.mutate((data) => {
      const item = data.queue.find((entry) => entry.command.id === id);
      if (item) {
        item.error = String(error);
        item.code = code;
        item.status = status;
        item.lastAttemptAt = Date.now();
      }
    });
  }
  acknowledge(id) {
    this.mutate((data) => {
      data.queue = data.queue.filter((entry) => entry.command.id !== id);
    });
  }
  preferences() {
    return clone({ ...this.read().preferences, ...this.temporaryPreferences });
  }
  setPreferences(values) {
    this.mutate((data) => {
      data.preferences = { ...data.preferences, ...clone(values) };
    });
    for (const key of Object.keys(values))
      delete this.temporaryPreferences[key];
    return this.preferences();
  }
  rememberPreferences(values) {
    const data = this.read();
    const temporary = { ...this.temporaryPreferences, ...clone(values) };
    const preferences = { ...data.preferences, ...temporary };
    if (JSON.stringify(preferences) === JSON.stringify(data.preferences)) {
      this.temporaryPreferences = {};
      return clone(preferences);
    }
    data.preferences = preferences;
    data.revision++;
    try {
      this.write(data);
    } catch (error) {
      if (!(error instanceof StorageFailure)) throw error;
      this.temporaryPreferences = temporary;
      return clone(preferences);
    }
    this.temporaryPreferences = {};
    return clone(preferences);
  }
  persistenceSnapshot() {
    const data = this.read();
    this.draftView(data);
    for (const [id, entry] of this.workingDrafts) {
      if (this.workingConflict(data, id)) throw new DraftConflict();
    }
    for (const [id, entry] of this.remoteDrafts)
      if (!this.workingDrafts.has(id) && !this.retiredDrafts.has(id))
        data.drafts[id] = {
          ...clone(entry.draft),
          localRevision: entry.localRevision + 1,
        };
    for (const [id, entry] of this.workingDrafts)
      if (!this.retiredDrafts.has(id)) data.drafts[id] = clone(entry.draft);
    for (const id of this.retiredDrafts.keys()) delete data.drafts[id];
    data.draftAutosave = this.autosaveRecovery();
    data.preferences = { ...data.preferences, ...this.temporaryPreferences };
    data.revision++;
    return data;
  }
  clearStorageOverlays() {
    this.remoteDrafts.clear();
    this.workingDrafts.clear();
    this.retiredDrafts.clear();
    this.recoveryOverrides.clear();
    this.temporaryPreferences = {};
  }
  adoptStorage(storage) {
    // Capture again after opening the database: typing and cloud confirmations
    // may have advanced this workspace while that asynchronous operation ran.
    const data = this.persistenceSnapshot();
    storage.setItem(this.key, JSON.stringify(data));
    this.storage = storage;
    this.writeWarning = null;
    this.clearStorageOverlays();
  }
  async flushStorage() {
    if (this.storage.databaseUnavailable)
      throw new StorageFailure(this.storage.databaseUnavailable);
    try {
      await this.storage.flush?.();
    } catch (error) {
      if (error.code === "DEVICE_STORAGE_CONFLICT") throw new DraftConflict();
      throw new StorageFailure(
        "The device database could not save this copy. Keep this tab open until your draft says Saved online, or export a copy.",
      );
    }
  }
  retryStorage() {
    const data = this.persistenceSnapshot();
    this.write(data);
    this.clearStorageOverlays();
    return this.storageStatus();
  }
  exportBackup() {
    const data = this.read();
    return {
      format: "aw-workspace",
      version: 1,
      exportedAt: Date.now(),
      drafts: Object.values(this.draftView(data)).map(clone),
      preferences: clone({ ...data.preferences, ...this.temporaryPreferences }),
      queue: clone(data.queue),
      draftAutosave: this.autosaveRecovery(),
    };
  }
  importBackup(backup) {
    if (
      backup?.format !== "aw-workspace" ||
      backup.version !== 1 ||
      !Array.isArray(backup.drafts) ||
      backup.drafts.length > 500
    )
      throw new Error("Invalid workspace backup.");
    const checked = backup.drafts.map((draft) => {
      if (
        !draft ||
        !validId(draft.id) ||
        !Array.isArray(draft.lines) ||
        draft.lines.length > 1000
      )
        throw new Error("Invalid draft in backup.");
      for (const line of draft.lines) {
        if (
          !line ||
          typeof line.productId !== "string" ||
          !Number.isSafeInteger(line.quantity) ||
          line.quantity <= 0 ||
          !["each", "case"].includes(line.unit)
        )
          throw new Error("Invalid order line in backup.");
      }
      return clone(draft);
    });
    return this.mutate((data) => {
      let imported = 0;
      for (const draft of checked) {
        if (!Object.hasOwn(this.draftView(data), draft.id)) {
          data.drafts[draft.id] = {
            ...draft,
            status: "draft",
            version: 0,
            localRevision: 1,
            syncState: "local",
          };
          imported++;
        }
      }
      if (["light", "dark"].includes(backup.preferences?.theme))
        data.preferences.theme = backup.preferences.theme;
      return { imported, skipped: checked.length - imported };
    });
  }
}
export function createDraft(storeId) {
  return {
    id: crypto.randomUUID(),
    storeId,
    lines: [],
    notes: "",
    status: "draft",
    version: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
