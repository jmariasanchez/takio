const activeSavedViewStorageKey = "takio.active-saved-view-id.v1";

type ActiveSavedViewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(
  storage?: ActiveSavedViewStorage,
): ActiveSavedViewStorage | null {
  if (storage) {
    return storage;
  }

  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readActiveSavedViewId(
  storage?: ActiveSavedViewStorage,
): string | null {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return null;
  }

  try {
    const id = resolved.getItem(activeSavedViewStorageKey);
    if (id === null || id.trim().length > 0) {
      return id;
    }
    resolved.removeItem(activeSavedViewStorageKey);
  } catch {
    // Persistence is best-effort; an unavailable preference store must not block startup.
  }
  return null;
}

export function writeActiveSavedViewId(
  id: string,
  storage?: ActiveSavedViewStorage,
): void {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return;
  }

  try {
    if (id.trim().length === 0) {
      resolved.removeItem(activeSavedViewStorageKey);
    } else {
      resolved.setItem(activeSavedViewStorageKey, id);
    }
  } catch {
    // Persistence is best-effort; the active view still works for this session.
  }
}

export function clearActiveSavedViewId(storage?: ActiveSavedViewStorage): void {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return;
  }

  try {
    resolved.removeItem(activeSavedViewStorageKey);
  } catch {
    // Persistence is best-effort; clearing session state must still succeed.
  }
}
