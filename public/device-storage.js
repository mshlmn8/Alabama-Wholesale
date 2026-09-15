const DATABASE = "aw-workspace-storage";
const CHANNEL = "aw-device-workspace";
const MAX_RAW_CHARS = 12 * 1024 * 1024;
export class DeviceStorageFailure extends Error {
  constructor(code, message, legacyConflict = false) {
    super(message);
    this.name = "DeviceStorageFailure";
    this.code = code;
    this.legacyConflict = legacyConflict;
  }
}
function failure(code = "DEVICE_STORAGE_FAILED", legacyConflict = false) {
  const messages = {
    DEVICE_STORAGE_UNAVAILABLE:
      "This browser cannot open the device backup. Existing device records are preserved.",
    DEVICE_STORAGE_TIMEOUT:
      "The device backup took too long. Keep this tab open and try again.",
    DEVICE_STORAGE_FAILED:
      "The device backup could not be saved. Your unsaved edits remain in this tab.",
    DEVICE_STORAGE_VERIFY_FAILED:
      "The device backup could not be verified. Keep this tab open and export your work.",
    DEVICE_STORAGE_CONFLICT: legacyConflict
      ? "An older app tab changed this device workspace. Both stored copies are preserved. Export your work before resolving the conflict."
      : "This workspace changed in another tab. Your edits remain in this tab. Export your work before resolving the conflict.",
    DEVICE_STORAGE_INVALID_KEY:
      "This device backup does not belong to a supported workspace.",
    DEVICE_STORAGE_INVALID_DATA:
      "This workspace cannot be stored as a device backup.",
  };
  return new DeviceStorageFailure(
    code,
    messages[code] || messages.DEVICE_STORAGE_FAILED,
    legacyConflict,
  );
}
function knownKey(key) {
  if (
    typeof key !== "string" ||
    !key.startsWith("aw:v2:") ||
    key.length <= 6 ||
    key.length > 500 ||
    ["__proto__", "prototype", "constructor"].includes(key.slice(6))
  )
    throw failure("DEVICE_STORAGE_INVALID_KEY");
  return key;
}
function canonical(raw) {
  if (typeof raw !== "string" || raw.length > MAX_RAW_CHARS)
    throw failure("DEVICE_STORAGE_INVALID_DATA");
  try {
    const data = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.format !== "aw-workspace" ||
      data.version !== 1 ||
      !data.drafts ||
      typeof data.drafts !== "object" ||
      Array.isArray(data.drafts) ||
      !Array.isArray(data.queue)
    )
      throw Error();
    delete data.revision;
    return JSON.stringify(data);
  } catch {
    throw failure("DEVICE_STORAGE_INVALID_DATA");
  }
}
function browserOptions(options = {}) {
  try {
    return {
      storage:
        options.storage === undefined
          ? globalThis.localStorage
          : options.storage,
      indexedDB:
        options.indexedDB === undefined
          ? globalThis.indexedDB
          : options.indexedDB,
      BroadcastChannel:
        options.BroadcastChannel === undefined
          ? globalThis.BroadcastChannel
          : options.BroadcastChannel,
      eventTarget:
        options.eventTarget === undefined ? globalThis : options.eventTarget,
      onChange:
        typeof options.onChange === "function" ? options.onChange : null,
      timeoutMs: options.timeoutMs ?? 8000,
    };
  } catch {
    throw failure("DEVICE_STORAGE_UNAVAILABLE");
  }
}
function readLocal(storage, key) {
  if (typeof storage?.getItem !== "function")
    throw failure("DEVICE_STORAGE_UNAVAILABLE");
  try {
    const raw = storage.getItem(key);
    if (raw !== null && typeof raw !== "string") throw Error();
    return raw;
  } catch {
    throw failure("DEVICE_STORAGE_UNAVAILABLE");
  }
}
function active(signal) {
  if (signal.aborted) throw failure("DEVICE_STORAGE_TIMEOUT");
}
function withAbort(promise, signal) {
  active(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure("DEVICE_STORAGE_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
async function bounded(timeoutMs, callback) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError("timeoutMs must be between 1 and 30000");
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withAbort(callback(controller.signal), controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw failure("DEVICE_STORAGE_TIMEOUT");
    if (error instanceof DeviceStorageFailure) throw error;
    throw failure();
  } finally {
    clearTimeout(timer);
  }
}
function openDatabase(indexedDB, signal) {
  if (typeof indexedDB?.open !== "function")
    throw failure("DEVICE_STORAGE_UNAVAILABLE");
  active(signal);
  return new Promise((resolve, reject) => {
    let request,
      settled = false;
    const finish = (error, value) => {
      if (settled) {
        value?.close();
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) {
        value?.close();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(failure("DEVICE_STORAGE_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (signal.aborted || settled) {
          request.transaction?.abort();
          return;
        }
        try {
          if (!request.result.objectStoreNames.contains("workspaces"))
            request.result.createObjectStore("workspaces", { keyPath: "key" });
        } catch {
          request.transaction?.abort();
          finish(failure());
        }
      };
      request.onsuccess = () =>
        finish(
          signal.aborted ? failure("DEVICE_STORAGE_TIMEOUT") : null,
          request.result,
        );
      request.onerror = () => finish(failure());
      request.onblocked = () => finish(failure("DEVICE_STORAGE_UNAVAILABLE"));
    } catch {
      finish(failure());
    }
  });
}
function transact(db, mode, signal, perform) {
  active(signal);
  return new Promise((resolve, reject) => {
    let tx,
      settled = false,
      result,
      overridden;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const cancel = (error) => {
      overridden = error;
      try {
        tx?.abort();
      } catch {}
      finish(error);
    };
    const abort = () => cancel(failure("DEVICE_STORAGE_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      tx = db.transaction(
        ["workspaces"],
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
      tx.oncomplete = () => finish();
      tx.onabort = () =>
        finish(
          overridden ||
            (signal.aborted ? failure("DEVICE_STORAGE_TIMEOUT") : failure()),
        );
      tx.onerror = () => cancel(failure());
      perform(
        tx.objectStore("workspaces"),
        (value) => {
          result = value;
        },
        cancel,
      );
    } catch {
      cancel(failure());
    }
  });
}
function getRecord(db, key, signal) {
  return transact(db, "readonly", signal, (store, result) => {
    const request = store.get(key);
    request.onsuccess = () => result(request.result ?? null);
  });
}
function validateRecord(row, key) {
  if (
    !row ||
    row.key !== key ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    (row.legacyRaw !== null && typeof row.legacyRaw !== "string")
  )
    throw failure("DEVICE_STORAGE_VERIFY_FAILED");
  try {
    canonical(row.raw);
  } catch {
    throw failure("DEVICE_STORAGE_VERIFY_FAILED");
  }
  return row;
}
function sameRecord(a, b) {
  return (
    a?.key === b.key &&
    a.version === b.version &&
    a.raw === b.raw &&
    a.legacyRaw === b.legacyRaw
  );
}
async function withDatabase(options, callback) {
  return bounded(options.timeoutMs, async (signal) => {
    const db = await openDatabase(options.indexedDB, signal);
    try {
      return await callback(db, signal);
    } finally {
      db.close();
    }
  });
}

function createAdapter(key, initial, options) {
  let row = initial,
    cache = initial.raw,
    cacheCanonical = canonical(cache),
    committedCanonical = cacheCanonical;
  let warning = null,
    conflict = false,
    legacyConflict = false,
    disposed = false,
    running = null,
    inFlight = false;
  let lastError = null,
    channel = null,
    notificationQueued = false,
    uncertain = null;
  const sender =
    globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const status = () => ({
    pending: inFlight || cacheCanonical !== committedCanonical,
    warning,
    conflicted: conflict,
    legacyConflict,
  });
  const changed = () => {
    if (disposed || notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      if (!disposed) {
        try {
          options.onChange?.(status());
        } catch {}
      }
    });
  };
  const failed = (error) => {
    lastError = error instanceof DeviceStorageFailure ? error : failure();
    warning = lastError.message;
    if (lastError.code === "DEVICE_STORAGE_CONFLICT") {
      conflict = true;
      legacyConflict ||= lastError.legacyConflict;
    }
    changed();
    return lastError;
  };
  const checkLegacy = () => {
    if (readLocal(options.storage, key) !== row.legacyRaw)
      throw failure("DEVICE_STORAGE_CONFLICT", true);
  };
  try {
    checkLegacy();
  } catch (error) {
    failed(error);
  }

  async function writeNext(raw) {
    const expected = row;
    return withDatabase(options, async (db, signal) => {
      checkLegacy();
      if (expected.version >= Number.MAX_SAFE_INTEGER)
        throw failure("DEVICE_STORAGE_CONFLICT");
      const next = {
        key,
        raw,
        version: expected.version + 1,
        legacyRaw: expected.legacyRaw,
      };
      uncertain = next;
      await transact(db, "readwrite", signal, (store, _result, cancel) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const current = validateRecord(request.result, key);
            if (!sameRecord(current, expected))
              throw failure("DEVICE_STORAGE_CONFLICT");
            checkLegacy();
            store.put(next);
          } catch (error) {
            cancel(error instanceof DeviceStorageFailure ? error : failure());
          }
        };
      });
      const verified = validateRecord(await getRecord(db, key, signal), key);
      if (!sameRecord(verified, next)) throw failure("DEVICE_STORAGE_CONFLICT");
      checkLegacy();
      uncertain = null;
      return verified;
    });
  }
  async function pump() {
    try {
      // A timeout or failed readback can follow a successful commit. Verify
      // that exact attempted version before retrying; never overwrite a foreign one.
      if (uncertain && !conflict) {
        const recovered = await withDatabase(options, async (db, signal) =>
          validateRecord(await getRecord(db, key, signal), key),
        );
        checkLegacy();
        if (sameRecord(recovered, uncertain)) {
          row = recovered;
          committedCanonical = canonical(recovered.raw);
          if (conflict)
            throw (
              lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict)
            );
          warning = null;
          lastError = null;
          changed();
        } else if (!sameRecord(recovered, row))
          throw failure("DEVICE_STORAGE_CONFLICT");
        uncertain = null;
      }
      if (conflict)
        throw lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict);
      while (cacheCanonical !== committedCanonical) {
        if (conflict)
          throw lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict);
        const snapshot = cache;
        inFlight = true;
        const committed = await writeNext(snapshot);
        row = committed;
        committedCanonical = canonical(committed.raw);
        inFlight = false;
        if (conflict)
          throw lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict);
        warning = null;
        lastError = null;
        changed();
        if (!disposed) {
          try {
            channel?.postMessage({ key, version: row.version, sender });
          } catch {}
        }
      }
    } catch (error) {
      inFlight = false;
      throw failed(error);
    }
  }
  function schedule() {
    if (!running) {
      running = Promise.resolve()
        .then(pump)
        .finally(() => {
          running = null;
          if (!conflict && !warning && cacheCanonical !== committedCanonical)
            schedule();
        });
      // setItem intentionally stages synchronously; flush observes any rejection.
      running.catch(() => {});
    }
    return running;
  }
  async function refresh() {
    try {
      return await withDatabase(options, async (db, signal) => {
        for (;;) {
          active(signal);
          checkLegacy();
          // An own transaction can have committed before its verified row is
          // installed in memory. Wait for that writer before comparing versions.
          if (running) {
            await withAbort(running, signal);
            continue;
          }
          const beforeRead = row;
          const latest = validateRecord(await getRecord(db, key, signal), key);
          // A new own write (or another refresh) may have begun during this read.
          // Re-read after it settles instead of treating its revision as foreign.
          if (running || row !== beforeRead) continue;
          if (readLocal(options.storage, key) !== latest.legacyRaw)
            throw failure("DEVICE_STORAGE_CONFLICT", true);
          if (sameRecord(latest, row)) return status();
          if (conflict || status().pending)
            throw failure("DEVICE_STORAGE_CONFLICT", legacyConflict);
          row = latest;
          cache = latest.raw;
          cacheCanonical = canonical(cache);
          committedCanonical = cacheCanonical;
          changed();
          return status();
        }
      });
    } catch (error) {
      throw failed(error);
    }
  }
  const onStorage = (event) => {
    if (event.key === key || event.key === null) refresh().catch(() => {});
  };
  try {
    if (typeof options.BroadcastChannel === "function") {
      channel = new options.BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        const message = event.data;
        if (
          message?.key === key &&
          message.sender !== sender &&
          Number.isSafeInteger(message.version) &&
          message.version > row.version
        )
          refresh().catch(() => {});
      };
    }
  } catch {
    channel = null;
  }
  options.eventTarget?.addEventListener?.("storage", onStorage);
  return {
    getItem(requestedKey) {
      if (requestedKey !== key) throw failure("DEVICE_STORAGE_INVALID_KEY");
      return cache;
    },
    setItem(requestedKey, raw) {
      if (requestedKey !== key) throw failure("DEVICE_STORAGE_INVALID_KEY");
      if (disposed) throw failure("DEVICE_STORAGE_UNAVAILABLE");
      if (conflict)
        throw lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict);
      const nextCanonical = canonical(raw);
      cache = raw;
      cacheCanonical = nextCanonical;
      if (cacheCanonical !== committedCanonical || inFlight) schedule();
      changed();
    },
    committedItem(requestedKey) {
      if (requestedKey !== key) throw failure("DEVICE_STORAGE_INVALID_KEY");
      return row.raw;
    },
    isPersisted(requestedKey, raw = cache) {
      return (
        requestedKey === key &&
        !conflict &&
        !warning &&
        canonical(raw) === committedCanonical
      );
    },
    async flush() {
      try {
        return await bounded(options.timeoutMs, async (signal) => {
          for (;;) {
            active(signal);
            checkLegacy();
            if (conflict)
              throw (
                lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict)
              );
            // Observe writes staged while an earlier commit or warning check
            // was in flight. A completed flush never reports pending content.
            if (running) await withAbort(running, signal);
            if (uncertain || cacheCanonical !== committedCanonical) {
              await withAbort(schedule(), signal);
              continue;
            }
            if (conflict)
              throw (
                lastError || failure("DEVICE_STORAGE_CONFLICT", legacyConflict)
              );
            if (warning) {
              const beforeRead = row;
              const verified = await withAbort(
                withDatabase(options, async (db, readSignal) =>
                  validateRecord(await getRecord(db, key, readSignal), key),
                ),
                signal,
              );
              if (
                running ||
                row !== beforeRead ||
                uncertain ||
                cacheCanonical !== committedCanonical
              )
                continue;
              checkLegacy();
              if (!sameRecord(verified, row))
                throw failure("DEVICE_STORAGE_CONFLICT");
              if (conflict)
                throw (
                  lastError ||
                  failure("DEVICE_STORAGE_CONFLICT", legacyConflict)
                );
              warning = null;
              lastError = null;
              changed();
            }
            if (running || uncertain || cacheCanonical !== committedCanonical)
              continue;
            return status();
          }
        });
      } catch (error) {
        throw failed(error);
      }
    },
    status,
    refresh,
    dispose() {
      disposed = true;
      options.eventTarget?.removeEventListener?.("storage", onStorage);
      try {
        channel?.close();
      } catch {}
      channel = null;
      // Pending authorized writes continue; only callbacks/listeners stop.
    },
  };
}

/** Open an existing account-scoped device workspace; never mutate localStorage. */
export async function openDeviceStorage(key, suppliedOptions = {}) {
  knownKey(key);
  const options = browserOptions(suppliedOptions);
  const row = await withDatabase(options, async (db, signal) => {
    const existing = await getRecord(db, key, signal);
    return existing ? validateRecord(existing, key) : null;
  });
  return row ? createAdapter(key, row, options) : null;
}

/** Create only if absent, with the original localStorage bytes as conflict baseline. */
export async function createDeviceStorage(key, raw, suppliedOptions = {}) {
  knownKey(key);
  const requestedCanonical = canonical(raw),
    options = browserOptions(suppliedOptions);
  const legacyRaw = readLocal(options.storage, key);
  const row = await withDatabase(options, async (db, signal) => {
    const selected = await transact(
      db,
      "readwrite",
      signal,
      (store, result, cancel) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            if (request.result) {
              const current = validateRecord(request.result, key);
              if (
                canonical(current.raw) !== requestedCanonical ||
                current.legacyRaw !== readLocal(options.storage, key)
              )
                throw failure(
                  "DEVICE_STORAGE_CONFLICT",
                  current.legacyRaw !== readLocal(options.storage, key),
                );
              result(current);
            } else {
              if (readLocal(options.storage, key) !== legacyRaw)
                throw failure("DEVICE_STORAGE_CONFLICT", true);
              const initial = { key, raw, version: 1, legacyRaw };
              store.add(initial);
              result(initial);
            }
          } catch (error) {
            cancel(error instanceof DeviceStorageFailure ? error : failure());
          }
        };
      },
    );
    const verified = validateRecord(await getRecord(db, key, signal), key);
    if (!sameRecord(verified, selected))
      throw failure("DEVICE_STORAGE_CONFLICT");
    if (readLocal(options.storage, key) !== verified.legacyRaw)
      throw failure("DEVICE_STORAGE_CONFLICT", true);
    return verified;
  });
  return createAdapter(key, row, options);
}
