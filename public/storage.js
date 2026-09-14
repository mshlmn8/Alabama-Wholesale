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
    const remoteDraftCount = this.remoteDrafts.size;
    const preferencesTemporary =
      Object.keys(this.temporaryPreferences).length > 0;
    return {
      warning:
        this.writeWarning ||
        (remoteDraftCount || preferencesTemporary
          ? "Some cloud drafts or preferences are available only in this session because device storage could not save them. Your existing saved work is preserved."
          : null),
      remoteDraftCount,
      preferencesTemporary,
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
    return {
      ...data.drafts,
      ...Object.fromEntries(
        [...this.remoteDrafts].map(([id, entry]) => [id, entry.draft]),
      ),
    };
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
  saveDraft(draft) {
    if (!validId(draft?.id) || !Array.isArray(draft.lines))
      throw new Error("Invalid draft.");
    const saved = this.mutate((data) => {
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
      if (
        current &&
        ((draft.localRevision ?? 0) !== (current.localRevision ?? 0) ||
          (this.remoteDrafts.has(draft.id) &&
            (draft.version || 0) !== (current.version || 0)))
      )
        throw new DraftConflict();
      const saved = {
        ...clone(draft),
        localRevision: (current?.localRevision || 0) + 1,
        syncState: "local",
        updatedAt: Date.now(),
      };
      data.drafts[draft.id] = saved;
      return saved;
    });
    this.remoteDrafts.delete(draft.id);
    return saved;
  }
  removeDraft(id) {
    this.mutate((data) => {
      delete data.drafts[id];
    });
    this.remoteDrafts.delete(id);
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
      if (remote.status !== "draft" || !validId(remote.id)) continue;
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
  retryStorage() {
    const data = this.read();
    this.draftView(data);
    for (const [id, entry] of this.remoteDrafts)
      data.drafts[id] = {
        ...clone(entry.draft),
        localRevision: entry.localRevision + 1,
      };
    data.preferences = { ...data.preferences, ...this.temporaryPreferences };
    data.revision++;
    this.write(data);
    this.remoteDrafts.clear();
    this.temporaryPreferences = {};
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
        if (!Object.hasOwn(data.drafts, draft.id)) {
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
