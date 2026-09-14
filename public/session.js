export class SessionChanged extends Error {
  constructor() {
    super("The signed-in account changed. This result was not applied.");
    this.code = "SESSION_CHANGED";
  }
}
export async function runSessionTask(
  snapshot,
  isCurrent,
  request,
  apply = (value) => value,
) {
  let result;
  try {
    result = await request(snapshot);
  } catch (error) {
    if (!isCurrent(snapshot)) throw new SessionChanged();
    throw error;
  }
  if (!isCurrent(snapshot)) throw new SessionChanged();
  return apply(result, snapshot);
}
export async function afterConfirmation(result, refresh, onWarning) {
  try {
    await refresh();
  } catch (error) {
    if (error.code === "SESSION_CHANGED") throw error;
    onWarning(error);
  }
  return result;
}

// Read-only requests are discarded when their view changes or a newer read starts.
export function createRequestGate() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async run(request, apply) {
      const requestGeneration = ++generation;
      let result;
      try {
        result = await request();
      } catch (error) {
        if (requestGeneration === generation) throw error;
        return;
      }
      if (requestGeneration === generation) return apply(result);
    },
  };
}
