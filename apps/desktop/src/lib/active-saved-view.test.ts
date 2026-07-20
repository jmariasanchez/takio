import { describe, expect, test } from "bun:test";

import {
  clearActiveSavedViewId,
  readActiveSavedViewId,
  writeActiveSavedViewId,
} from "./active-saved-view";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
    removeItem(key: string): void {
      values.delete(key);
    },
  };
}

describe("active saved view persistence", () => {
  test("restores only the saved-view ID needed to resolve the current definition", () => {
    const storage = memoryStorage();

    writeActiveSavedViewId("view-42", storage);

    expect(readActiveSavedViewId(storage)).toBe("view-42");
  });

  test("clears the preference when the active view is detached", () => {
    const storage = memoryStorage();
    writeActiveSavedViewId("view-42", storage);

    clearActiveSavedViewId(storage);

    expect(readActiveSavedViewId(storage)).toBeNull();
  });

  test("discards a corrupt blank preference rather than restoring an invalid ID", () => {
    const storage = memoryStorage();
    storage.setItem("takio.active-saved-view-id.v1", "   ");

    expect(readActiveSavedViewId(storage)).toBeNull();
    expect(storage.getItem("takio.active-saved-view-id.v1")).toBeNull();
  });

  test("treats unavailable storage as best-effort so catalogue use is never blocked", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("storage unavailable");
      },
      setItem(): void {
        throw new Error("storage unavailable");
      },
      removeItem(): void {
        throw new Error("storage unavailable");
      },
    };

    expect(readActiveSavedViewId(storage)).toBeNull();
    expect(() => writeActiveSavedViewId("view-42", storage)).not.toThrow();
    expect(() => clearActiveSavedViewId(storage)).not.toThrow();
  });
});
