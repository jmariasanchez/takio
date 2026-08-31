import type { LibraryItem } from "@takio/core";
import type { MetadataCandidate } from "@takio/library-contract";

import type {
  DesktopLibraryGetResult,
  DesktopMetadataCandidateListResult,
} from "./library";
import { discardMetadataCandidateCovers } from "./library";

export const BULK_METADATA_DISCOVERY_CONCURRENCY = 2;

export type BulkMetadataDiscoveryOutcome =
  | Readonly<{
      itemId: string;
      status: "ready";
      item: LibraryItem;
      candidates: readonly MetadataCandidate[];
    }>
  | Readonly<{ itemId: string; status: "no-candidates"; item: LibraryItem }>
  | Readonly<{ itemId: string; status: "missing" }>
  | Readonly<{ itemId: string; status: "failed"; code: string }>
  | Readonly<{ itemId: string; status: "canceled" }>;

export type BulkMetadataDiscoveryCounts = Readonly<
  Record<BulkMetadataDiscoveryOutcome["status"], number> & { total: number }
>;

export type BulkMetadataDiscoveryResult = Readonly<{
  outcomes: readonly BulkMetadataDiscoveryOutcome[];
  counts: BulkMetadataDiscoveryCounts;
}>;

type Dependencies = Readonly<{
  getItem: (id: string) => Promise<DesktopLibraryGetResult>;
  listCandidates: (request: {
    itemId: string;
    includeOnline: boolean;
  }) => Promise<DesktopMetadataCandidateListResult>;
  isCanceled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  discardCandidates?: (candidates: readonly MetadataCandidate[]) => Promise<void>;
}>;

export function countBulkMetadataDiscoveryOutcomes(
  outcomes: readonly BulkMetadataDiscoveryOutcome[],
): BulkMetadataDiscoveryCounts {
  const counts = {
    total: outcomes.length,
    ready: 0,
    "no-candidates": 0,
    missing: 0,
    failed: 0,
    canceled: 0,
  };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

async function discoverOne(
  itemId: string,
  includeOnline: boolean,
  dependencies: Dependencies,
): Promise<BulkMetadataDiscoveryOutcome> {
  try {
    const itemResult = await dependencies.getItem(itemId);
    if (!itemResult.ok) return { itemId, status: "failed", code: itemResult.error.code };
    if (!itemResult.value.item) return { itemId, status: "missing" };

    const listResult = await dependencies.listCandidates({ itemId, includeOnline });
    if (!listResult.ok) {
      return listResult.error.code === "item-not-found"
        ? { itemId, status: "missing" }
        : { itemId, status: "failed", code: listResult.error.code };
    }
    if (listResult.value.itemId !== itemId) {
      return { itemId, status: "failed", code: "protocol-error" };
    }
    const candidates = listResult.value.candidates.filter(
      (candidate) => candidate.provenance.itemId === itemId,
    );
    if (dependencies.isCanceled?.()) {
      await (dependencies.discardCandidates ?? discardMetadataCandidateCovers)(candidates);
      return { itemId, status: "canceled" };
    }
    return candidates.length === 0
      ? { itemId, status: "no-candidates", item: itemResult.value.item }
      : { itemId, status: "ready", item: itemResult.value.item, candidates };
  } catch {
    return { itemId, status: "failed", code: "unexpected-error" };
  }
}

export async function discoverBulkMetadataCandidates(
  request: Readonly<{ itemIds: readonly string[]; includeOnline: boolean }>,
  dependencies: Dependencies,
): Promise<BulkMetadataDiscoveryResult> {
  const outcomes: Array<BulkMetadataDiscoveryOutcome | undefined> = new Array(
    request.itemIds.length,
  );
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (dependencies.isCanceled?.()) return;
      const index = nextIndex;
      if (index >= request.itemIds.length) return;
      nextIndex += 1;
      outcomes[index] = await discoverOne(
        request.itemIds[index]!,
        request.includeOnline,
        dependencies,
      );
      completed += 1;
      dependencies.onProgress?.(completed, request.itemIds.length);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(BULK_METADATA_DISCOVERY_CONCURRENCY, request.itemIds.length) },
      () => worker(),
    ),
  );

  for (let index = 0; index < outcomes.length; index += 1) {
    if (!outcomes[index]) {
      outcomes[index] = { itemId: request.itemIds[index]!, status: "canceled" };
      completed += 1;
      dependencies.onProgress?.(completed, request.itemIds.length);
    }
  }

  const ordered = outcomes as BulkMetadataDiscoveryOutcome[];
  return { outcomes: ordered, counts: countBulkMetadataDiscoveryOutcomes(ordered) };
}
