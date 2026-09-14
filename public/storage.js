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
    try {
      this.storage.setItem(this.key, JSON.stringify(data));
    } catch {
      throw new StorageFailure(
        "Could not save on this device. Browser storage may be full or unavailable. Export your draft and try again.",
      );
    }
    return clone(result ?? data);
  }
  getDraft(id) {
    const drafts = this.read().drafts;
    return clone(Object.hasOwn(drafts, id) ? drafts[id] : null);
  }
  listDrafts() {
    return Object.values(this.read().drafts)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(clone);
  }
  saveDraft(draft) {
    if (!validId(draft?.id) || !Array.isArray(draft.lines))
      throw new Error("Invalid draft.");
    return this.mutate((data) => {
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
      const current = data.drafts[draft.id];
      if (
        current &&
        (draft.localRevision ?? 0) !== (current.localRevision ?? 0)
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
  }
  removeDraft(id) {
    this.mutate((data) => {
      delete data.drafts[id];
    });
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
    this.mutate((data) => {
      for (const remote of drafts) {
        if (remote.status !== "draft" || !validId(remote.id)) continue;
        const local = data.drafts[remote.id];
        if (
          !local ||
          (local.syncState === "synced" &&
            (remote.version || 0) > (local.version || 0))
        ) {
          data.drafts[remote.id] = {
            ...clone(remote),
            localRevision: (local?.localRevision || 0) + 1,
            syncState: "synced",
          };
        }
      }
    });
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
    return clone(this.read().preferences);
  }
  setPreferences(values) {
    this.mutate((data) => {
      data.preferences = { ...data.preferences, ...clone(values) };
    });
    return this.preferences();
  }
  exportBackup() {
    const data = this.read();
    return {
      format: "aw-workspace",
      version: 1,
      exportedAt: Date.now(),
      drafts: Object.values(data.drafts),
      preferences: data.preferences,
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
