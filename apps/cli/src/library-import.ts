import type {
  LibraryImportEntryOutcome,
  LibraryStore,
} from "@takio/library-contract";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverEbookMeta,
  extractEbookMetadata,
  type ExtractedCover,
} from "./metadata.js";

const DEFAULT_METADATA_TIMEOUT_MS = 15_000;

export type MetadataImportStore = Pick<LibraryStore, "update" | "setCover">;

export type EnrichImportedLibraryOutcomesOptions = Readonly<{
  /** Use only for the explicit title supplied to a single-item import. */
  titleOverride?: string;
  timeoutMs?: number;
}>;

function isManagedImport(outcome: LibraryImportEntryOutcome): boolean {
  if (outcome.status !== "imported") {
    return false;
  }
  const primaryFormat = outcome.item.formats[0];
  return (
    primaryFormat?.sourcePath === outcome.item.sourcePath &&
    primaryFormat.provenance === "managed"
  );
}

async function installCover(
  store: MetadataImportStore,
  itemId: string,
  cover: ExtractedCover,
) {
  let workspace: string | undefined;
  try {
    workspace = await mkdtemp(join(tmpdir(), "takio-import-cover-"));
    await chmod(workspace, 0o700);
    const sourcePath = join(workspace, `cover${cover.extension}`);
    await writeFile(sourcePath, cover.bytes, { flag: "wx", mode: 0o600 });
    return await store.setCover({ id: itemId, sourcePath });
  } catch {
    return null;
  } finally {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function enrichImportedLibraryOutcomes(
  store: MetadataImportStore,
  outcomes: readonly LibraryImportEntryOutcome[],
  options: EnrichImportedLibraryOutcomesOptions = {},
): Promise<readonly LibraryImportEntryOutcome[]> {
  if (!outcomes.some(isManagedImport)) {
    return outcomes;
  }

  let backendPath: string;
  try {
    const discovery = await discoverEbookMeta();
    if (!discovery.ok) {
      return outcomes;
    }
    backendPath = discovery.path;
  } catch {
    return outcomes;
  }

  const enriched = [...outcomes];
  for (const [index, outcome] of outcomes.entries()) {
    if (!isManagedImport(outcome) || outcome.status !== "imported") {
      continue;
    }

    try {
      const extracted = await extractEbookMetadata({
        backendPath,
        sourcePath: outcome.item.sourcePath,
        timeoutMs: options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      });
      const patch =
        options.titleOverride === undefined
          ? extracted.metadata
          : { ...extracted.metadata, title: options.titleOverride };
      const updated = await store.update({ id: outcome.item.id, patch });
      if (!updated.ok || !updated.value) {
        continue;
      }

      let item = updated.value;
      if (extracted.cover) {
        const covered = await installCover(store, item.id, extracted.cover);
        if (covered?.ok && covered.value) {
          item = covered.value;
        }
      }
      enriched[index] = { ...outcome, item };
    } catch {
      // Metadata enrichment is best effort; the managed import remains authoritative.
    }
  }

  return enriched;
}
