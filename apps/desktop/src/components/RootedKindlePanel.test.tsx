import { describe, expect, test } from "bun:test";
import type { LibraryItem } from "@takio/core";

import { validateRootedKindleRequest, type RootedKindlePanelDraft } from "./RootedKindlePanel";

const item: LibraryItem = {
  id: "item-1",
  title: "Title",
  sourcePath: "/Books/Title.epub",
  format: "epub",
  addedAt: "2026-08-19T00:00:00.000Z",
  formats: [{
    format: "epub",
    sourcePath: "/Books/Title.epub",
    addedAt: "2026-08-19T00:00:00.000Z",
    provenance: "managed",
  }],
  tags: [],
  updatedAt: "2026-08-19T00:00:00.000Z",
};

const draft: RootedKindlePanelDraft = {
  enabled: true,
  host: "kindle.local",
  user: "root",
  remoteRoot: "/mnt/us/documents/koreader",
  identityFile: "/Users/me/.ssh/kindle",
  port: "22",
  timeoutMs: "30000",
  format: "epub",
};

describe("RootedKindlePanel validation", () => {
  test("requires explicit session opt-in and complete per-send configuration", () => {
    expect(validateRootedKindleRequest(item, draft)).toEqual({
      id: "item-1",
      format: "epub",
      host: "kindle.local",
      user: "root",
      remoteRoot: "/mnt/us/documents/koreader",
      identityFile: "/Users/me/.ssh/kindle",
      port: 22,
      timeoutMs: 30000,
    });
    expect(validateRootedKindleRequest(item, { ...draft, enabled: false })).toBeNull();
    expect(validateRootedKindleRequest(null, draft)).toBeNull();
    expect(validateRootedKindleRequest(item, { ...draft, identityFile: "" })).toBeNull();
    expect(validateRootedKindleRequest(item, { ...draft, port: "22;rm" })).toBeNull();
    expect(validateRootedKindleRequest(item, { ...draft, timeoutMs: "999" })).toBeNull();
    expect(validateRootedKindleRequest(item, { ...draft, host: "kindle.local\nProxyCommand" })).toBeNull();
    expect(validateRootedKindleRequest(item, { ...draft, format: "pdf" })).toBeNull();
  });
});
