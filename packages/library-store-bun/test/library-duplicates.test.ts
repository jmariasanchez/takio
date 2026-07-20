import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { FormatId, LibraryItem } from "@takio/core";

import { BunSqliteLibraryStore } from "../src/index.js";

describe("BunSqliteLibraryStore duplicate review", () => {
  let directory: string;
  let databasePath: string;
  let stores: BunSqliteLibraryStore[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-library-duplicates-"));
    databasePath = join(directory, "library.sqlite");
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores) {
      store.close();
    }
    await rm(directory, { recursive: true, force: true });
  });

  function createStore(): BunSqliteLibraryStore {
    const store = new BunSqliteLibraryStore(databasePath);
    stores.push(store);
    return store;
  }

  async function openStore(): Promise<BunSqliteLibraryStore> {
    const store = createStore();
    expect(await store.open({ config: {} })).toEqual({ ok: true, value: null });
    return store;
  }

  function referencedItem(
    id: string,
    title: string,
    sourcePath: string,
    format: FormatId,
    overrides: Partial<LibraryItem> = {},
  ): LibraryItem {
    return {
      id,
      title,
      sourcePath,
      format,
      addedAt: "2026-07-20T10:00:00.000Z",
      formats: [
        {
          sourcePath,
          format,
          addedAt: "2026-07-20T10:00:00.000Z",
          provenance: "referenced",
        },
      ],
      tags: [],
      ...overrides,
    };
  }

  const firstPage = {
    page: { limit: 100, offset: 0 },
    disposition: "unreviewed" as const,
  };

  it("derives conservative signals, scan accounting, and stable pages", async () => {
    const store = await openStore();
    const firstPath = join(directory, "first.epub");
    const secondPath = join(directory, "second.pdf");
    const missingPath = join(directory, "missing.mobi");
    await writeFile(firstPath, "same content");
    await writeFile(secondPath, "same content");
    const items = [
      referencedItem("a", "Dune", firstPath, "epub", {
        authors: [{ name: "Frank Herbert" }],
        author: "Frank Herbert",
        identifiers: { ISBN: "9780441172719" },
      }),
      referencedItem("b", " dune ", secondPath, "pdf", {
        authors: [{ name: "FRANK   HERBERT" }],
        author: "FRANK   HERBERT",
        identifiers: { isbn: "9780441172719" },
      }),
      referencedItem("c", "DUNE", missingPath, "mobi", {
        author: "Frank Herbert",
        identifiers: { IsBn: "9780441172719" },
      }),
    ];
    for (const item of items) {
      expect(await store.add({ item })).toEqual({ ok: true, value: item });
    }

    const first = await store.listDuplicateCandidates({
      page: { limit: 1, offset: 0 },
      disposition: "unreviewed",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.total).toBe(3);
    expect(first.value.scan).toEqual({
      filesHashed: 2,
      fingerprintsReused: 0,
      unreadableFormats: 1,
    });
    expect(first.value.candidates).toHaveLength(1);
    expect(first.value.candidates[0]).toMatchObject({
      left: { id: "a" },
      right: { id: "b" },
      signals: [
        {
          kind: "same-content",
          leftFormat: "epub",
          rightFormat: "pdf",
          bytes: 12,
        },
        { kind: "same-identifier" },
        { kind: "same-title-author" },
      ],
    });

    const second = await store.listDuplicateCandidates({
      page: { limit: 1, offset: 1 },
      disposition: "unreviewed",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.candidates.map(({ left, right }) => [left.id, right.id])).toEqual([
      ["a", "c"],
    ]);
    const stableFirst = await store.listDuplicateCandidates(firstPage);
    const stableSecond = await store.listDuplicateCandidates(firstPage);
    if (!stableFirst.ok || !stableSecond.ok) throw new Error("Expected stable duplicate scans");
    expect(
      stableFirst.value.candidates.map(({ left, right, reviewToken }) => [
        left.id,
        right.id,
        reviewToken,
      ]),
    ).toEqual(
      stableSecond.value.candidates.map(({ left, right, reviewToken }) => [
        left.id,
        right.id,
        reviewToken,
      ]),
    );
  });

  it("reuses persisted managed fingerprints without reopening managed files", async () => {
    const store = await openStore();
    const leftPrimary = join(directory, "left.epub");
    const rightPrimary = join(directory, "right.pdf");
    const leftManaged = join(directory, "left.mobi");
    const rightManaged = join(directory, "right.azw3");
    await writeFile(leftPrimary, "left primary");
    await writeFile(rightPrimary, "right primary");
    await writeFile(leftManaged, "managed match");
    await writeFile(rightManaged, "managed match");
    expect(
      (await store.add({ item: referencedItem("left", "Left", leftPrimary, "epub") })).ok,
    ).toBe(true);
    expect(
      (await store.add({ item: referencedItem("right", "Right", rightPrimary, "pdf") })).ok,
    ).toBe(true);
    expect(
      await store.attachFormat({ id: "left", source: { kind: "copy", path: leftManaged } }),
    ).toMatchObject({ ok: true });
    expect(
      await store.attachFormat({ id: "right", source: { kind: "copy", path: rightManaged } }),
    ).toMatchObject({ ok: true });

    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected managed fingerprint candidate");
    expect(listed.value.scan).toEqual({
      filesHashed: 2,
      fingerprintsReused: 2,
      unreadableFormats: 0,
    });
    expect(listed.value.candidates).toHaveLength(1);
    expect(listed.value.candidates[0]).toMatchObject({
      left: { id: "left" },
      right: { id: "right" },
      signals: [{ kind: "same-content", leftFormat: "mobi", rightFormat: "azw3" }],
    });
  });

  it("preserves case-sensitive identifier values and orders candidates without locale collation", async () => {
    const store = await openStore();
    const items = [
      referencedItem("z-left", "Z left", join(directory, "z-left.epub"), "epub", {
        identifiers: { ISBN: "z" },
      }),
      referencedItem("z-right", "Z right", join(directory, "z-right.pdf"), "pdf", {
        identifiers: { isbn: "z" },
      }),
      referencedItem("accent-left", "Accent left", join(directory, "accent-left.epub"), "epub", {
        identifiers: { ISBN: "ä" },
      }),
      referencedItem("accent-right", "Accent right", join(directory, "accent-right.pdf"), "pdf", {
        identifiers: { isbn: "ä" },
      }),
      referencedItem("case-upper", "Upper", join(directory, "upper.mobi"), "mobi", {
        identifiers: { asin: "AbC" },
      }),
      referencedItem("case-lower", "Lower", join(directory, "lower.azw3"), "azw3", {
        identifiers: { ASIN: "abc" },
      }),
    ];
    for (const item of items) {
      expect((await store.add({ item })).ok).toBe(true);
    }

    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected identifier candidates");
    expect(
      listed.value.candidates.map(({ left, right, signals }) => ({
        ids: [left.id, right.id],
        value: signals[0]?.kind === "same-identifier" ? signals[0].value : null,
      })),
    ).toEqual([
      { ids: ["z-left", "z-right"], value: "z" },
      { ids: ["accent-left", "accent-right"], value: "ä" },
    ]);
    expect(
      listed.value.candidates.some(
        ({ left, right }) =>
          [left.id, right.id].includes("case-upper") ||
          [left.id, right.id].includes("case-lower"),
      ),
    ).toBe(false);
  });

  it("does not collide NUL-containing identifier or title-author tuples", async () => {
    const store = await openStore();
    const items = [
      referencedItem("identifier-left", "Identifier left", join(directory, "id-left.epub"), "epub", {
        identifiers: { "a\u0000b": "c" },
      }),
      referencedItem("identifier-right", "Identifier right", join(directory, "id-right.pdf"), "pdf", {
        identifiers: { a: "b\u0000c" },
      }),
      referencedItem("title-left", "a\u0000b", join(directory, "title-left.mobi"), "mobi", {
        author: "c",
      }),
      referencedItem("title-right", "a", join(directory, "title-right.azw3"), "azw3", {
        author: "b\u0000c",
      }),
    ];
    for (const item of items) {
      expect((await store.add({ item })).ok).toBe(true);
    }

    expect(await store.listDuplicateCandidates(firstPage)).toMatchObject({
      ok: true,
      value: { candidates: [], total: 0 },
    });
  });

  it("keeps canonically ordered non-BMP item IDs despite SQLite byte collation", async () => {
    const store = await openStore();
    const emojiId = "😀";
    const privateUseId = "\uE000";
    for (const item of [
      referencedItem(emojiId, "Same", join(directory, "emoji.epub"), "epub", {
        author: "Author",
      }),
      referencedItem(privateUseId, "Same", join(directory, "private.pdf"), "pdf", {
        author: "Author",
      }),
    ]) {
      expect((await store.add({ item })).ok).toBe(true);
    }

    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected a non-BMP duplicate candidate");
    const candidate = listed.value.candidates[0]!;
    expect([candidate.left.id, candidate.right.id]).toEqual([emojiId, privateUseId]);
    expect(
      await store.keepDuplicatePair({
        leftId: candidate.left.id,
        rightId: candidate.right.id,
        reviewToken: candidate.reviewToken,
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      await store.listDuplicateCandidates({
        page: { limit: 100, offset: 0 },
        disposition: "kept-both",
      }),
    ).toMatchObject({ ok: true, value: { total: 1 } });
  });

  it("does not let a referenced path collision retain an unowned managed file", async () => {
    const store = await openStore();
    const sourcePath = join(directory, "managed.pdf");
    await writeFile(sourcePath, "managed content");
    const imported = await store.import({ sourcePath });
    if (!imported.ok) throw new Error("Expected managed import");
    const managedPath = imported.value.sourcePath;
    const collidingReference = referencedItem(
      "reference",
      "Reference",
      basename(managedPath),
      "pdf",
    );
    expect(await store.add({ item: collidingReference })).toEqual({
      ok: true,
      value: collidingReference,
    });

    expect(await store.trash({ id: imported.value.id })).toMatchObject({
      ok: true,
      value: { id: imported.value.id },
    });
    expect(await store.purge({ id: imported.value.id })).toMatchObject({
      ok: true,
      value: { cleanupPending: false },
    });
    expect(await Bun.file(managedPath).exists()).toBe(false);
    expect(await store.get({ id: "reference" })).toEqual({
      ok: true,
      value: collidingReference,
    });
  });

  it("preserves a managed file used by an absolute referenced path", async () => {
    const store = await openStore();
    const sourcePath = join(directory, "shared.pdf");
    await writeFile(sourcePath, "shared content");
    const imported = await store.import({ sourcePath });
    if (!imported.ok) throw new Error("Expected managed import");
    const managedPath = imported.value.sourcePath;
    const absoluteReference = referencedItem(
      "reference",
      "Reference",
      managedPath,
      "pdf",
    );
    expect(await store.add({ item: absoluteReference })).toEqual({
      ok: true,
      value: absoluteReference,
    });

    expect(await store.trash({ id: imported.value.id })).toMatchObject({
      ok: true,
      value: { id: imported.value.id },
    });
    expect(await store.purge({ id: imported.value.id })).toMatchObject({
      ok: true,
      value: { cleanupPending: false },
    });
    expect(await Bun.file(managedPath).exists()).toBe(true);
    expect(await store.get({ id: "reference" })).toEqual({
      ok: true,
      value: absoluteReference,
    });
  });

  it("keeps and reopens only current evidence, exposing changed evidence as unreviewed", async () => {
    const store = await openStore();
    const leftPath = join(directory, "left.epub");
    const rightPath = join(directory, "right.pdf");
    await writeFile(leftPath, "same content");
    await writeFile(rightPath, "same content");
    for (const item of [
      referencedItem("left", "Kindred", leftPath, "epub", { author: "Octavia Butler" }),
      referencedItem("right", "Kindred", rightPath, "pdf", { author: "Octavia Butler" }),
    ]) {
      expect((await store.add({ item })).ok).toBe(true);
    }
    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected a duplicate candidate");
    const candidate = listed.value.candidates[0]!;
    const review = {
      leftId: candidate.left.id,
      rightId: candidate.right.id,
      reviewToken: candidate.reviewToken,
    };

    expect(await store.reopenDuplicatePair(review)).toEqual({
      ok: false,
      error: { code: "stale-review" },
    });
    expect(await store.keepDuplicatePair(review)).toEqual({ ok: true, value: null });
    expect((await store.listDuplicateCandidates(firstPage))).toMatchObject({
      ok: true,
      value: { total: 0 },
    });
    expect(
      await store.listDuplicateCandidates({
        page: { limit: 100, offset: 0 },
        disposition: "kept-both",
      }),
    ).toMatchObject({ ok: true, value: { total: 1 } });

    expect(await store.update({ id: "right", patch: { title: "Kindred revised", tags: [] } })).toMatchObject({
      ok: true,
      value: { id: "right", title: "Kindred revised" },
    });
    expect(await store.reopenDuplicatePair(review)).toEqual({
      ok: false,
      error: { code: "stale-review" },
    });
    expect(
      await store.mergeDuplicatePair({
        targetId: "left",
        sourceId: "right",
        reviewToken: review.reviewToken,
        metadata: { tags: [] },
        addSourceFormats: [],
        cover: "target",
      }),
    ).toEqual({ ok: false, error: { code: "stale-review" } });
    const changed = await store.listDuplicateCandidates(firstPage);
    if (!changed.ok) throw new Error("Expected changed evidence to remain reviewable");
    expect(changed.value.total).toBe(1);
    expect(changed.value.candidates[0]!.reviewToken).not.toBe(candidate.reviewToken);
    const currentReview = {
      leftId: "left",
      rightId: "right",
      reviewToken: changed.value.candidates[0]!.reviewToken,
    };
    expect(await store.keepDuplicatePair(currentReview)).toEqual({ ok: true, value: null });
    expect(await store.reopenDuplicatePair(currentReview)).toEqual({ ok: true, value: null });
    expect((await store.listDuplicateCandidates(firstPage))).toMatchObject({
      ok: true,
      value: { total: 1 },
    });
  });

  it("merges explicit metadata and formats, trashes the intact donor, and preserves shared files", async () => {
    const store = await openStore();
    const targetPath = join(directory, "target.epub");
    const sourcePath = join(directory, "source.mobi");
    const donorPdfPath = join(directory, "donor.pdf");
    const targetCoverPath = join(directory, "target-cover.jpg");
    const sourceCoverPath = join(directory, "source-cover.jpg");
    await writeFile(targetPath, "target format");
    await writeFile(sourcePath, "source format");
    await writeFile(donorPdfPath, "donor pdf");
    await writeFile(targetCoverPath, "target cover");
    await writeFile(sourceCoverPath, "source cover");
    const target = referencedItem("target", "Target", targetPath, "epub", {
      identifiers: { isbn: "shared" },
      tags: ["old"],
    });
    expect(await store.add({ item: target })).toEqual({ ok: true, value: target });
    const importedSource = await store.import({ sourcePath });
    if (!importedSource.ok) throw new Error("Expected donor import to succeed");
    const sourceId = importedSource.value.id;
    expect(
      await store.update({
        id: sourceId,
        patch: { identifiers: { ISBN: "shared" }, tags: ["donor"] },
      }),
    ).toMatchObject({ ok: true, value: { id: sourceId } });
    expect(await store.attachFormat({ id: sourceId, source: { kind: "copy", path: donorPdfPath } })).toMatchObject({
      ok: true,
      value: { id: sourceId },
    });
    const targetWithCover = await store.setCover({ id: "target", sourcePath: targetCoverPath });
    const sourceWithCover = await store.setCover({ id: sourceId, sourcePath: sourceCoverPath });
    if (!targetWithCover.ok || !targetWithCover.value || !sourceWithCover.ok || !sourceWithCover.value) {
      throw new Error("Expected cover setup to succeed");
    }
    const oldTargetCover = targetWithCover.value.coverPath!;
    const donorCover = sourceWithCover.value.coverPath!;
    const donorPdf = sourceWithCover.value.formats.find(({ format }) => format === "pdf")!;

    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected identifier candidate");
    const candidate = listed.value.candidates.find(
      ({ left, right }) => left.id === sourceId || right.id === sourceId,
    )!;
    using database = new Database(databasePath, { strict: true });
    database.run(`
      CREATE TRIGGER reject_unrequested_duplicate_tag_rewrite
      BEFORE DELETE ON library_item_tags
      WHEN OLD.library_item_id = 'target'
      BEGIN
        SELECT RAISE(ABORT, 'duplicate metadata must preserve omitted tags');
      END
    `);
    const merged = await store.mergeDuplicatePair({
      targetId: "target",
      sourceId,
      reviewToken: candidate.reviewToken,
      metadata: {
        title: "Merged title",
        author: "Merged Author",
        publisher: "Merged Publisher",
        identifiers: { ISBN: "shared" },
      },
      addSourceFormats: ["pdf"],
      cover: "source",
    });
    expect(merged).toMatchObject({
      ok: true,
      value: {
        target: {
          id: "target",
          title: "Merged title",
          author: "Merged Author",
          publisher: "Merged Publisher",
          coverPath: donorCover,
          tags: ["old"],
          formats: [{ format: "epub" }, { format: "pdf", provenance: "managed" }],
        },
        trashedSource: { id: sourceId, coverPath: donorCover },
        cleanupPending: false,
      },
    });
    expect(await Bun.file(oldTargetCover).exists()).toBe(false);
    expect(await Bun.file(donorPdf.sourcePath).exists()).toBe(true);
    expect(await Bun.file(donorCover).exists()).toBe(true);
    expect(await store.listTrash({ page: { limit: 100, offset: 0 } })).toMatchObject({
      ok: true,
      value: { total: 1, items: [{ id: sourceId }] },
    });

    expect(await store.purge({ id: sourceId })).toMatchObject({
      ok: true,
      value: { cleanupPending: false },
    });
    expect(await Bun.file(donorPdf.sourcePath).exists()).toBe(true);
    expect(await Bun.file(donorCover).exists()).toBe(true);
    expect(await store.get({ id: "target" })).toMatchObject({
      ok: true,
      value: {
        formats: [{ format: "epub" }, { format: "pdf" }],
        coverPath: donorCover,
        tags: ["old"],
      },
    });
  });

  it("clears duplicate target tags only when explicitly requested", async () => {
    const store = await openStore();
    const target = referencedItem("target", "Same", join(directory, "target.epub"), "epub", {
      author: "Author",
      tags: ["old"],
    });
    const source = referencedItem("source", "Same", join(directory, "source.pdf"), "pdf", {
      author: "Author",
    });
    expect((await store.add({ item: target })).ok).toBe(true);
    expect((await store.add({ item: source })).ok).toBe(true);
    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected title-author candidate");

    expect(
      await store.mergeDuplicatePair({
        targetId: "target",
        sourceId: "source",
        reviewToken: listed.value.candidates[0]!.reviewToken,
        metadata: { tags: [] },
        addSourceFormats: [],
        cover: "target",
      }),
    ).toMatchObject({ ok: true, value: { target: { id: "target", tags: [] } } });
    expect(await store.get({ id: "target" })).toMatchObject({
      ok: true,
      value: { tags: [] },
    });
  });

  it("rolls metadata and formats back when trashing the donor fails", async () => {
    const store = await openStore();
    const target = referencedItem("target", "Same", join(directory, "target.epub"), "epub", {
      author: "Author",
    });
    const source = referencedItem("source", "Same", join(directory, "source.pdf"), "pdf", {
      author: "Author",
    });
    expect((await store.add({ item: target })).ok).toBe(true);
    expect((await store.add({ item: source })).ok).toBe(true);
    const listed = await store.listDuplicateCandidates(firstPage);
    if (!listed.ok) throw new Error("Expected title-author candidate");
    const candidate = listed.value.candidates[0]!;
    using competitor = new Database(databasePath, { strict: true });
    competitor.run(`
      CREATE TRIGGER interrupt_duplicate_merge
      BEFORE UPDATE OF trashed_at ON library_items
      WHEN NEW.id = 'source'
      BEGIN
        SELECT RAISE(ABORT, 'injected merge failure');
      END
    `);

    expect(
      await store.mergeDuplicatePair({
        targetId: "target",
        sourceId: "source",
        reviewToken: candidate.reviewToken,
        metadata: { title: "Changed", tags: ["changed"] },
        addSourceFormats: [],
        cover: "target",
      }),
    ).toEqual({ ok: false, error: { code: "storage-unavailable" } });
    expect(await store.get({ id: "target" })).toEqual({ ok: true, value: target });
    expect(await store.get({ id: "source" })).toEqual({ ok: true, value: source });
    expect(await store.listTrash({ page: { limit: 100, offset: 0 } })).toMatchObject({
      ok: true,
      value: { total: 0 },
    });
  });

  it("backs up and migrates v7 review state and then reopens v8 without mutation", async () => {
    const initializer = await openStore();
    initializer.close();
    using downgrade = new Database(databasePath, { strict: true });
    downgrade.transaction(() => {
      downgrade.run("DROP TABLE duplicate_pair_reviews");
      downgrade.run("PRAGMA user_version = 7");
    }).immediate();
    downgrade.close();
    const before = await readFile(databasePath);

    const migrated = await openStore();
    migrated.close();
    expect(await readFile(`${databasePath}.v7.backup`)).toEqual(before);
    using current = new Database(databasePath, { strict: true });
    expect(current.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
      user_version: 8,
    });
    expect(
      current
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'duplicate_pair_reviews'",
        )
        .get(),
    ).toEqual({ name: "duplicate_pair_reviews" });
    current.close();
    const migratedBytes = await readFile(databasePath);

    const reopened = await openStore();
    reopened.close();
    expect(await readFile(databasePath)).toEqual(migratedBytes);
  });
});
