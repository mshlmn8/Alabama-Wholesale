// Retry device persistence independently of cloud autosave. A failed database write or
// storage probe must never be treated as a successful backup.
export function createStorageRecovery({
  workspace,
  reclaim,
  isCurrent = () => true,
  retry = () => workspace.retryStorage(),
  onRecovered = () => {},
  now = Date.now,
  interval = 30000,
}) {
  let pending = null,
    lastAttempt = -Infinity,
    disposed = false;
  const alive = () => !disposed && isCurrent();
  return {
    attempt({ force = false } = {}) {
      if (!alive()) return Promise.resolve(false);
      if (pending) return pending;
      if (!force && now() - lastAttempt < interval)
        return Promise.resolve(false);
      if (!force && !workspace.storageStatus().warning)
        return Promise.resolve(false);
      lastAttempt = now();
      // Defer writes until after the current input/render operation finishes.
      pending = Promise.resolve()
        .then(async () => {
          if (!alive()) return false;
          try {
            await retry();
          } catch (error) {
            if (error.name !== "StorageFailure") throw error;
            await reclaim();
            if (!alive()) return false;
            await retry();
          }
          if (!alive()) return false;
          if (workspace.storageStatus().warning) return false;
          onRecovered();
          return true;
        })
        .finally(() => {
          pending = null;
        });
      return pending;
    },
    dispose() {
      disposed = true;
    },
  };
}
