import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  FORMAT_CATALOG,
  type BookFormat,
  type Destination,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import type {
  DuplicateCandidate,
  KeepDuplicatePairRequest,
  LibraryFacetCounts,
  LibraryHealthLocation,
  LibraryIntegrityReport,
  LibraryImportReport,
  LibraryImportMode,
  LibraryMetadataPatch,
  LibraryQueryFilters,
  LibraryQuerySort,
  LibraryQuerySyntax,
  MergeDuplicatePairRequest,
  ReopenDuplicatePairRequest,
  SavedLibraryView,
} from "@takio/library-contract";
import {
  MAX_BULK_METADATA_CANDIDATE_ITEMS,
  MAX_LIBRARY_EXPORT_ITEMS,
  MAX_LIBRARY_IMPORT_ROOTS,
} from "@takio/library-contract";

import {
  DeviceControls,
  retainConnectedDeviceFormatPreferences,
  selectedDestinationAfterRefresh,
  setSessionDeviceFormatPreference,
  type SessionDeviceFormatPreferences,
} from "./components/DeviceControls";
import { RootedKindlePanel, type RootedKindlePanelDraft } from "./components/RootedKindlePanel";
import { JobsPanel } from "./components/JobsPanel";
import {
  backupDirectoryName,
  diagnosticsFileName,
  LibraryHealthDialog,
} from "./components/LibraryHealthDialog";
import {
  LibraryDuplicateReviewDialog,
  type DuplicateReviewDisposition,
  type DuplicateReviewPendingAction,
} from "./components/LibraryDuplicateReviewDialog";
import { LibraryImportDialog } from "./components/LibraryImportDialog";
import type { LibraryExportLayout } from "./components/LibraryExportDialog";
import {
  LibraryTrashDialog,
  type LibraryTrashPendingAction,
} from "./components/LibraryTrashDialog";
import {
  LibraryWorkspace,
  conversionControlId,
  resolveGeneralSend,
  type ConversionDraft,
  type LibraryWorkspaceBulkActions,
  type LibraryState,
  type MetadataDraft,
} from "./components/LibraryWorkspace";
import {
  clearActiveSavedViewId,
  readActiveSavedViewId,
  writeActiveSavedViewId,
} from "./lib/active-saved-view";
import {
  confirmDialog as confirm,
  droppedFilePath,
  joinPath,
  onMenuAction,
  openDialog as open,
} from "./lib/desktop";
import { reportLibraryUsable } from "./lib/startup";
import {
  applyBulkTagOperation,
  hydrateSelectedLibraryItems,
  planBulkDeviceSend,
  planBulkPdfConversion,
  summarizeBulkDeviceSendPlan,
  summarizeBulkPdfConversionPlan,
} from "./lib/library-bulk-actions";
import { createConversionOutputPath } from "./lib/conversion-output";
import {
  describeDestinationError,
  describeUnexpectedDestinationError,
  ejectDestination,
  inventoryDestination,
  listDestinations,
  reconcileDestination,
  removeDestinationDelivery,
  sendLibraryItem,
  type DestinationInventoryEntry,
} from "./lib/destinations";
import {
  cancelConversionJob,
  describeJobError,
  describeUnexpectedJobError,
  enqueueConversionJob,
  listConversionJobs,
  retryConversionJob,
  runNextConversionJob,
  type ConversionJob,
} from "./lib/jobs";
import {
  backUpLibrary,
  describeLibraryHealthError,
  exportLibraryDiagnostics,
  getLibraryHealthLocation,
  verifyLibraryHealth,
} from "./lib/library-health";
import {
  attachLibraryFormat,
  describeLibraryError,
  describeUnexpectedLibraryError,
  exportLibraryItems,
  getLibraryItem,
  importLibraryItems,
  keepDuplicatePair,
  listDuplicateCandidates,
  listLibraryTrash,
  listSavedLibraryViews,
  mergeDuplicatePair,
  openLibraryItem,
  purgeLibraryItem,
  queryLibraryItems,
  removeLibraryCover,
  removeLibraryFormat,
  removeSavedLibraryView,
  reopenDuplicatePair,
  restoreLibraryItem,
  saveSavedLibraryView,
  setLibraryCover,
  trashLibraryItem,
  updateLibraryItem,
} from "./lib/library";
import {
  applyLibraryQueryResponse,
  boundedLibraryPageOffset,
  createLibraryQueryState,
  DEFAULT_LIBRARY_QUERY_REQUEST,
  issueLibraryQueryRequest,
  libraryQueryStateReducer,
  type LibraryQueryState,
  type LibraryQueryStateAction,
} from "./lib/library-query-state";
import {
  createLibrarySelectionState,
  librarySelectionReducer,
} from "./lib/library-selection";
import "./styles.css";

const defaultRootedKindleDraft: RootedKindlePanelDraft = {
  enabled: false,
  host: "",
  user: "",
  remoteRoot: "",
  identityFile: "",
  port: "",
  timeoutMs: "",
  format: "",
};

const supportedExtensions = FORMAT_CATALOG.flatMap((format) =>
  format.extensions.map((extension) => extension.slice(1)),
);
const coverExtensions = ["png", "jpg", "jpeg", "webp", "gif"];
const emptyLibraryFacets: LibraryFacetCounts = {
  authors: [],
  tags: [],
  series: [],
  languages: [],
  formats: [],
};
const searchDebounceMilliseconds = 250;
const duplicatePageLimit = 20;
const trashPageLimit = 25;

type JobsState = "loading" | "ready" | "error";
type Notice = { readonly kind: "status" | "error"; readonly text: string } | null;
type MenuActionHandlers = {
  readonly libraryModalOpen: boolean;
  readonly openImport: () => void;
  readonly importPaths: (paths: readonly string[]) => Promise<void>;
  readonly openSelected: () => Promise<void>;
  readonly sendSelected: () => Promise<void>;
  readonly ejectSelected: () => Promise<void>;
  readonly find: () => void;
};

type LibraryModalState = {
  readonly saveView: boolean;
  readonly import: boolean;
  readonly trash: boolean;
  readonly duplicateReview: boolean;
  readonly bulkTags: boolean;
  readonly bulkMetadata: boolean;
  readonly bulkMetadataCandidates: boolean;
  readonly bulkExport: boolean;
  readonly health: boolean;
};

export function hasOpenLibraryModal(state: LibraryModalState): boolean {
  return Object.values(state).some(Boolean);
}

export function dispatchLibraryMenuAction(payload: string, handlers: MenuActionHandlers): void {
  if (handlers.libraryModalOpen) {
    return;
  }

  switch (payload) {
    case "import":
      handlers.openImport();
      break;
    case "open-selected":
      void handlers.openSelected();
      break;
    case "send-selected":
      void handlers.sendSelected();
      break;
    case "eject-selected":
      void handlers.ejectSelected();
      break;
    case "find":
      handlers.find();
      break;
  }
}

function uniqueImportPaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function importSummary(report: LibraryImportReport): string {
  const { imported, skipped, duplicates, failed } = report.counts;
  return `${imported} imported; ${skipped} skipped; ${duplicates} duplicates; ${failed} failed.`;
}

export default function App() {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [libraryQuery, setLibraryQuery] = useState<LibraryQueryState>(() =>
    createLibraryQueryState(),
  );
  const [librarySelection, dispatchLibrarySelection] = useReducer(
    librarySelectionReducer,
    createLibrarySelectionState(),
  );
  const [savedViews, setSavedViews] = useState<readonly SavedLibraryView[]>([]);
  const [currentSavedViewId, setCurrentSavedViewId] = useState<string | null>(null);
  const [saveViewDialogOpen, setSaveViewDialogOpen] = useState(false);
  const [saveViewDialogError, setSaveViewDialogError] = useState<string | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importRootPaths, setImportRootPaths] = useState<readonly string[]>([]);
  const [importReport, setImportReport] = useState<LibraryImportReport | null>(null);
  const [importDialogError, setImportDialogError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<LibraryImportMode>("copy");
  const [trashDialogOpen, setTrashDialogOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<readonly LibraryItem[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashPageOffset, setTrashPageOffset] = useState(0);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashPendingItemId, setTrashPendingItemId] = useState<string | null>(null);
  const [trashPendingAction, setTrashPendingAction] =
    useState<LibraryTrashPendingAction | null>(null);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateDisposition, setDuplicateDisposition] =
    useState<DuplicateReviewDisposition>("unreviewed");
  const [duplicateCandidates, setDuplicateCandidates] =
    useState<readonly DuplicateCandidate[]>([]);
  const [duplicateTotal, setDuplicateTotal] = useState(0);
  const [duplicatePageOffset, setDuplicatePageOffset] = useState(0);
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicatePendingReviewToken, setDuplicatePendingReviewToken] =
    useState<string | null>(null);
  const [duplicatePendingAction, setDuplicatePendingAction] =
    useState<DuplicateReviewPendingAction | null>(null);
  const [duplicateStaleReviewToken, setDuplicateStaleReviewToken] =
    useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [libraryState, setLibraryState] = useState<LibraryState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [bulkPendingAction, setBulkPendingAction] =
    useState<LibraryWorkspaceBulkActions["pendingAction"]>(null);
  const [bulkTagsDialogOpen, setBulkTagsDialogOpen] = useState(false);
  const [bulkTagsDialogError, setBulkTagsDialogError] = useState<string | null>(null);
  const [bulkMetadataDialogOpen, setBulkMetadataDialogOpen] = useState(false);
  const [bulkMetadataDialogError, setBulkMetadataDialogError] = useState<string | null>(null);
  const [bulkMetadataCandidateDialogOpen, setBulkMetadataCandidateDialogOpen] = useState(false);
  const [bulkMetadataCandidateItemIds, setBulkMetadataCandidateItemIds] = useState<readonly string[]>([]);
  const [bulkExportDialogOpen, setBulkExportDialogOpen] = useState(false);
  const [bulkExportItemIds, setBulkExportItemIds] = useState<readonly string[]>([]);
  const [healthDialogOpen, setHealthDialogOpen] = useState(false);
  const [healthLocation, setHealthLocation] = useState<LibraryHealthLocation | null>(null);
  const [healthLocationLoading, setHealthLocationLoading] = useState(false);
  const [lastHealthVerification, setLastHealthVerification] =
    useState<{ readonly checkedAt: string; readonly report: LibraryIntegrityReport } | null>(null);
  const [healthVerificationError, setHealthVerificationError] = useState<string | null>(null);
  const [healthBackupResult, setHealthBackupResult] =
    useState<{ readonly path: string; readonly report: LibraryIntegrityReport } | null>(null);
  const [healthBackupError, setHealthBackupError] = useState<string | null>(null);
  const [healthDiagnosticsResult, setHealthDiagnosticsResult] = useState<{
    readonly path: string;
    readonly bytes: number;
    readonly verificationStatus: "ok" | "failed";
  } | null>(null);
  const [healthDiagnosticsError, setHealthDiagnosticsError] = useState<string | null>(null);
  const [healthPendingAction, setHealthPendingAction] =
    useState<"verify" | "backup" | "diagnostics" | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [conversionDraft, setConversionDraft] = useState<ConversionDraft | null>(null);
  const [destinations, setDestinations] = useState<readonly Destination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [jobs, setJobs] = useState<readonly ConversionJob[]>([]);
  const [jobsState, setJobsState] = useState<JobsState>("loading");
  const [conversionRunning, setConversionRunning] = useState(false);
  const [selectedDestinationId, setSelectedDestinationId] = useState<string | null>(null);
  const [destinationInventoryEntries, setDestinationInventoryEntries] = useState<readonly DestinationInventoryEntry[]>([]);
  const [destinationInventoryLoading, setDestinationInventoryLoading] = useState(false);
  const [preferredFormatsByDestinationPath, setPreferredFormatsByDestinationPath] =
    useState<SessionDeviceFormatPreferences>({});
  const [convertIfNeeded, setConvertIfNeeded] = useState(true);
  const [rootedKindleDraft, setRootedKindleDraft] = useState<RootedKindlePanelDraft>(defaultRootedKindleDraft);
  const [dropActive, setDropActive] = useState(false);
  const libraryModalOpen = hasOpenLibraryModal({
    saveView: saveViewDialogOpen,
    import: importDialogOpen,
    trash: trashDialogOpen,
    duplicateReview: duplicateDialogOpen,
    bulkTags: bulkTagsDialogOpen,
    bulkMetadata: bulkMetadataDialogOpen,
    bulkMetadataCandidates: bulkMetadataCandidateDialogOpen,
    bulkExport: bulkExportDialogOpen,
    health: healthDialogOpen,
  });
  const savedViewsRequestSequence = useRef(0);
  const trashRequestSequence = useRef(0);
  const trashPageOffsetRef = useRef(0);
  const duplicateRequestSequence = useRef(0);
  const duplicatePageOffsetRef = useRef(0);
  const destinationRequestSequence = useRef(0);
  const destinationInventoryRequestSequence = useRef(0);
  const jobRequestSequence = useRef(0);
  const autoDrainBlocked = useRef(false);
  const conversionWorkerPending = useRef(false);
  const deviceMutationPending = useRef(false);
  const formatMutationPending = useRef(false);
  const bulkMutationPending = useRef(false);
  const duplicateMutationPending = useRef(false);
  const postBulkFocusPending = useRef(false);
  const importPending = useRef(false);
  const openPending = useRef(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef(items);
  const libraryQueryRef = useRef(libraryQuery);
  const currentSavedViewIdRef = useRef<string | null>(null);
  const libraryUsableReported = useRef(false);
  const postRemoveFocusItemId = useRef<string | null | undefined>(undefined);
  const postFormatFocusControlId = useRef<string | undefined>(undefined);
  const postConversionFocusControlId = useRef<string | undefined>(undefined);
  const searchDebounce = useRef<number | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const menuActionHandlers = useRef<MenuActionHandlers | null>(null);
  itemsRef.current = items;
  libraryQueryRef.current = libraryQuery;

  useEffect(() => {
    if (pendingAction !== null || postRemoveFocusItemId.current === undefined) {
      return;
    }

    const itemId = postRemoveFocusItemId.current;
    postRemoveFocusItemId.current = undefined;
    const target =
      itemId === null ? importButton.current : document.getElementById(`library-item-${itemId}`);
    (target ?? importButton.current)?.focus();
  }, [items, pendingAction]);

  useEffect(() => {
    if (
      pendingAction !== null ||
      conversionDraft !== null ||
      postConversionFocusControlId.current === undefined
    ) {
      return;
    }

    const controlId = postConversionFocusControlId.current;
    postConversionFocusControlId.current = undefined;
    (document.getElementById(controlId) ?? importButton.current)?.focus();
  }, [conversionDraft, pendingAction]);

  useEffect(() => {
    if (pendingAction !== null || postFormatFocusControlId.current === undefined) {
      return;
    }

    const controlId = postFormatFocusControlId.current;
    postFormatFocusControlId.current = undefined;
    (document.getElementById(controlId) ?? importButton.current)?.focus();
  }, [items, pendingAction]);

  useEffect(() => {
    if (
      !postBulkFocusPending.current ||
      pendingAction !== null ||
      bulkExportDialogOpen ||
      bulkTagsDialogOpen ||
      bulkMetadataDialogOpen ||
      bulkMetadataCandidateDialogOpen ||
      librarySelection.selectedItemIds.length > 0
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      postBulkFocusPending.current = false;
      searchInput.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    bulkExportDialogOpen,
    bulkMetadataDialogOpen,
    bulkMetadataCandidateDialogOpen,
    bulkTagsDialogOpen,
    librarySelection.selectedItemIds.length,
    pendingAction,
  ]);


  const commitLibraryQuery = useCallback((next: LibraryQueryState): void => {
    libraryQueryRef.current = next;
    setLibraryQuery(next);
  }, []);

  const commitCurrentSavedViewId = useCallback((id: string | null): void => {
    currentSavedViewIdRef.current = id;
    setCurrentSavedViewId(id);
    if (id === null) {
      clearActiveSavedViewId();
    } else {
      writeActiveSavedViewId(id);
    }
  }, []);

  const reduceLibraryQuery = useCallback(
    (action: LibraryQueryStateAction): LibraryQueryState => {
      const next = libraryQueryStateReducer(libraryQueryRef.current, action);
      commitLibraryQuery(next);
      return next;
    },
    [commitLibraryQuery],
  );

  const loadLibrary = useCallback(
    async (showLoading = true): Promise<boolean> => {
      if (showLoading) {
        setLibraryState("loading");
      } else {
        setSearchPending(true);
      }

      while (true) {
        const issued = issueLibraryQueryRequest(libraryQueryRef.current);
        commitLibraryQuery(issued.state);

        try {
          const result = await queryLibraryItems(issued.request.request);
          if (libraryQueryRef.current.pendingRequestToken !== issued.request.token) {
            return false;
          }
          if (!result.ok) {
            setLibraryState("error");
            setSearchPending(false);
            setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
            return false;
          }

          const next = applyLibraryQueryResponse(
            libraryQueryRef.current,
            issued.request.token,
            result.value,
          );
          commitLibraryQuery(next);
          if (
            next.page === null &&
            next.request.page.offset !== issued.request.request.page.offset
          ) {
            continue;
          }

          setItems(next.page?.items ?? []);
          setLibraryState("ready");
          setSearchPending(false);
          return true;
        } catch (error) {
          if (libraryQueryRef.current.pendingRequestToken !== issued.request.token) {
            return false;
          }
          setLibraryState("error");
          setSearchPending(false);
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
          return false;
        }
      }
    },
    [commitLibraryQuery],
  );

  const loadSavedViews = useCallback(async (): Promise<readonly SavedLibraryView[] | null> => {
    const request = ++savedViewsRequestSequence.current;
    try {
      const result = await listSavedLibraryViews();
      if (request !== savedViewsRequestSequence.current) {
        return null;
      }
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return null;
      }

      setSavedViews(result.value.views);
      const currentId = currentSavedViewIdRef.current;
      if (currentId && !result.value.views.some(({ id }) => id === currentId)) {
        commitCurrentSavedViewId(null);
      }
      return result.value.views;
    } catch (error) {
      if (request !== savedViewsRequestSequence.current) {
        return null;
      }
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return null;
    }
  }, [commitCurrentSavedViewId]);

  const loadTrash = useCallback(async (initialOffset: number): Promise<boolean> => {
    const request = ++trashRequestSequence.current;
    let offset = initialOffset;
    setTrashLoading(true);
    setTrashError(null);

    try {
      while (true) {
        const result = await listLibraryTrash({
          page: { offset, limit: trashPageLimit },
        });
        if (request !== trashRequestSequence.current) {
          return false;
        }
        if (!result.ok) {
          setTrashError(describeLibraryError(result.error.code));
          return false;
        }

        const boundedOffset =
          result.value.total === 0
            ? 0
            : Math.min(
                offset,
                Math.floor((result.value.total - 1) / trashPageLimit) * trashPageLimit,
              );
        if (boundedOffset !== offset) {
          offset = boundedOffset;
          trashPageOffsetRef.current = boundedOffset;
          setTrashPageOffset(boundedOffset);
          setTrashItems([]);
          continue;
        }

        trashPageOffsetRef.current = offset;
        setTrashPageOffset(offset);
        setTrashItems(result.value.items);
        setTrashTotal(result.value.total);
        return true;
      }
    } catch (error) {
      if (request !== trashRequestSequence.current) {
        return false;
      }
      setTrashError(describeUnexpectedLibraryError(error));
      return false;
    } finally {
      if (request === trashRequestSequence.current) {
        setTrashLoading(false);
      }
    }
  }, []);

  const loadDuplicateReviewPage = useCallback(
    async (
      initialOffset: number,
      disposition: DuplicateReviewDisposition,
    ): Promise<boolean> => {
      const request = ++duplicateRequestSequence.current;
      let offset = initialOffset;
      setDuplicateLoading(true);
      setDuplicateError(null);

      try {
        while (true) {
          const result = await listDuplicateCandidates({
            page: { offset, limit: duplicatePageLimit },
            disposition,
          });
          if (request !== duplicateRequestSequence.current) {
            return false;
          }
          if (!result.ok) {
            setDuplicateError(describeLibraryError(result.error.code));
            return false;
          }

          const boundedOffset = boundedLibraryPageOffset(
            offset,
            result.value.total,
            duplicatePageLimit,
          );
          if (boundedOffset !== offset) {
            offset = boundedOffset;
            duplicatePageOffsetRef.current = boundedOffset;
            setDuplicatePageOffset(boundedOffset);
            setDuplicateCandidates([]);
            continue;
          }

          duplicatePageOffsetRef.current = offset;
          setDuplicatePageOffset(offset);
          setDuplicateCandidates(result.value.candidates);
          setDuplicateTotal(result.value.total);
          return true;
        }
      } catch (error) {
        if (request !== duplicateRequestSequence.current) {
          return false;
        }
        setDuplicateError(describeUnexpectedLibraryError(error));
        return false;
      } finally {
        if (request === duplicateRequestSequence.current) {
          setDuplicateLoading(false);
        }
      }
    },
    [],
  );

  const loadDestinations = useCallback(async (showLoading = true): Promise<boolean> => {
    const request = ++destinationRequestSequence.current;
    if (showLoading) {
      setDestinationsLoading(true);
    }
    try {
      const result = await listDestinations();
      if (request !== destinationRequestSequence.current) {
        return false;
      }
      if (!result.ok) {
        setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
        return false;
      }

      setDestinations(result.value.destinations);
      setPreferredFormatsByDestinationPath((currentPreferences) =>
        retainConnectedDeviceFormatPreferences(
          currentPreferences,
          result.value.destinations,
        ),
      );
      setSelectedDestinationId((currentId) =>
        selectedDestinationAfterRefresh(currentId, result.value.destinations),
      );
      return true;
    } catch (error) {
      if (request !== destinationRequestSequence.current) {
        return false;
      }
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
      return false;
    } finally {
      if (request === destinationRequestSequence.current) {
        setDestinationsLoading(false);
      }
    }
  }, []);

  const loadDestinationInventory = useCallback(
    async (destination: Destination, mode: "inventory" | "reconcile" = "inventory"): Promise<boolean> => {
      const request = ++destinationInventoryRequestSequence.current;
      setDestinationInventoryEntries([]);
      setDestinationInventoryLoading(true);
      try {
        const result = mode === "reconcile"
          ? await reconcileDestination(destination.path)
          : await inventoryDestination(destination.path);
        if (request !== destinationInventoryRequestSequence.current) {
          return false;
        }
        if (!result.ok) {
          setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
          return false;
        }
        if (result.value.destinationId !== destination.id) {
          setNotice({ kind: "error", text: describeDestinationError("protocol-error") });
          return false;
        }
        setDestinationInventoryEntries(result.value.entries);
        return true;
      } catch (error) {
        if (request !== destinationInventoryRequestSequence.current) {
          return false;
        }
        setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
        return false;
      } finally {
        if (request === destinationInventoryRequestSequence.current) {
          setDestinationInventoryLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const destination = destinations.find(({ id }) => id === selectedDestinationId);
    if (!destination) {
      destinationInventoryRequestSequence.current += 1;
      setDestinationInventoryEntries([]);
      setDestinationInventoryLoading(false);
      return;
    }
    void loadDestinationInventory(destination);
  }, [destinations, loadDestinationInventory, selectedDestinationId]);

  const loadJobs = useCallback(async (showLoading = true): Promise<boolean> => {
    const request = ++jobRequestSequence.current;
    if (showLoading) {
      setJobsState("loading");
    }
    try {
      const result = await listConversionJobs();
      if (request !== jobRequestSequence.current) {
        return false;
      }
      if (!result.ok) {
        setJobsState("error");
        setNotice({ kind: "error", text: describeJobError(result.error.code) });
        return false;
      }

      autoDrainBlocked.current = false;
      setJobs(result.value.jobs);
      setJobsState("ready");
      return true;
    } catch (error) {
      if (request !== jobRequestSequence.current) {
        return false;
      }
      setJobsState("error");
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
      return false;
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const views = await loadSavedViews();
      if (disposed) {
        return;
      }

      const persistedId = readActiveSavedViewId();
      const persistedView = views?.find(({ id }) => id === persistedId);
      if (persistedView) {
        commitCurrentSavedViewId(persistedView.id);
        reduceLibraryQuery({
          type: "apply-saved-view",
          id: persistedView.id,
          definition: persistedView.definition,
        });
      } else if (views !== null && persistedId !== null) {
        commitCurrentSavedViewId(null);
      }
      const libraryLoaded = await loadLibrary();
      if (!disposed && libraryLoaded && !libraryUsableReported.current) {
        libraryUsableReported.current = true;
        void reportLibraryUsable().catch(() => {
          // Startup reporting is benchmark-only and must not block the library.
        });
      }
    })();
    void loadDestinations();
    void loadJobs();

    // ponytail: passive polling is enough for Calibre-style reader discovery;
    // replace it with mount events only if polling becomes measurably expensive.
    const destinationRefresh = window.setInterval(() => {
      if (!deviceMutationPending.current) {
        void loadDestinations(false);
      }
    }, 10_000);

    return () => {
      disposed = true;
      window.clearInterval(destinationRefresh);
      trashRequestSequence.current += 1;
      duplicateRequestSequence.current += 1;
      if (searchDebounce.current !== null) {
        window.clearTimeout(searchDebounce.current);
      }
    };
  }, [
    commitCurrentSavedViewId,
    loadDestinations,
    loadJobs,
    loadLibrary,
    loadSavedViews,
    reduceLibraryQuery,
  ]);

  function replaceItem(updated: LibraryItem): void {
    setItems((currentItems) =>
      currentItems.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  function supersedePendingLibraryRequest(): void {
    reduceLibraryQuery({
      type: "set-page",
      page: libraryQueryRef.current.request.page,
    });
    setSearchPending(false);
    setLibraryState("ready");
  }

  function selectLibraryItem(id: string | null): void {
    reduceLibraryQuery({ type: "select-item", id });
  }

  function discardMissingItem(item: LibraryItem): void {
    const staleIndex = itemsRef.current.findIndex((candidate) => candidate.id === item.id);
    const remainingItems = itemsRef.current.filter((candidate) => candidate.id !== item.id);
    const focusItem =
      staleIndex < 0
        ? remainingItems[0]
        : (remainingItems[staleIndex] ?? remainingItems[staleIndex - 1]);
    postFormatFocusControlId.current = undefined;
    postRemoveFocusItemId.current = focusItem?.id ?? null;
    setItems(remainingItems);
    setDraft((currentDraft) => (currentDraft?.id === item.id ? null : currentDraft));
    setConversionDraft((currentDraft) =>
      currentDraft?.id === item.id ? null : currentDraft,
    );
    if (libraryQueryRef.current.selectedItemId === item.id) {
      selectLibraryItem(null);
    }
  }

  function changeSearch(searchQuery: string): void {
    dispatchLibrarySelection({ type: "query-changed" });
    reduceLibraryQuery({ type: "set-query", query: searchQuery });
    setSearchPending(true);
    if (searchDebounce.current !== null) {
      window.clearTimeout(searchDebounce.current);
    }
    searchDebounce.current = window.setTimeout(() => {
      searchDebounce.current = null;
      void loadLibrary(false);
    }, searchDebounceMilliseconds);
  }

  function changeSearchSyntax(querySyntax: LibraryQuerySyntax): void {
    dispatchLibrarySelection({ type: "query-changed" });
    runImmediateLibraryQuery({ type: "set-query-syntax", querySyntax });
  }

  function runImmediateLibraryQuery(action: LibraryQueryStateAction): void {
    if (searchDebounce.current !== null) {
      window.clearTimeout(searchDebounce.current);
      searchDebounce.current = null;
    }
    reduceLibraryQuery(action);
    setSearchPending(true);
    void loadLibrary(false);
  }

  function changeFilters(filters: LibraryQueryFilters): void {
    dispatchLibrarySelection({ type: "query-changed" });
    runImmediateLibraryQuery({ type: "set-filters", filters });
  }

  function changeSort(sort: LibraryQuerySort): void {
    dispatchLibrarySelection({ type: "sort-changed" });
    runImmediateLibraryQuery({ type: "set-sort", sort });
  }

  function changePage(offset: number): void {
    dispatchLibrarySelection({ type: "page-changed" });
    runImmediateLibraryQuery({
      type: "set-page",
      page: { ...libraryQueryRef.current.request.page, offset },
    });
  }

  function clearLibraryQuery(): void {
    dispatchLibrarySelection({ type: "query-changed" });
    commitCurrentSavedViewId(null);
    runImmediateLibraryQuery({
      type: "apply-saved-view",
      id: null,
      definition: {
        version: 1,
        query: DEFAULT_LIBRARY_QUERY_REQUEST.query,
        filters: DEFAULT_LIBRARY_QUERY_REQUEST.filters,
        sort: DEFAULT_LIBRARY_QUERY_REQUEST.sort,
      },
    });
  }

  function applySavedView(id: string): void {
    const view = savedViews.find((candidate) => candidate.id === id);
    if (!view) {
      commitCurrentSavedViewId(null);
      setNotice({ kind: "error", text: "That virtual library is no longer available." });
      void loadSavedViews();
      return;
    }

    dispatchLibrarySelection({ type: "query-changed" });
    commitCurrentSavedViewId(view.id);
    runImmediateLibraryQuery({
      type: "apply-saved-view",
      id: view.id,
      definition: view.definition,
    });
  }

  function toggleSelectedLibraryItem(id: string): void {
    dispatchLibrarySelection({ type: "toggle-item", id });
    selectLibraryItem(id);
  }

  function selectLibraryItemRange(
    id: string,
    pageItemIds: readonly string[],
  ): void {
    dispatchLibrarySelection({ type: "select-range", id, pageItemIds });
    selectLibraryItem(id);
  }

  function toggleLibraryPageSelection(pageItemIds: readonly string[]): void {
    dispatchLibrarySelection({ type: "toggle-page", pageItemIds });
  }

  function openSaveViewDialog(): void {
    if (currentSavedViewIdRef.current !== null) {
      setNotice({
        kind: "error",
        text: "Switch to All books before saving a new virtual library.",
      });
      return;
    }
    setSaveViewDialogError(null);
    setSaveViewDialogOpen(true);
  }

  function cancelSaveViewDialog(): void {
    if (pendingAction === "saved-view-save") {
      return;
    }
    setSaveViewDialogError(null);
    setSaveViewDialogOpen(false);
  }

  async function saveCurrentView(name: string): Promise<void> {
    if (pendingAction !== null) {
      return;
    }

    const request = libraryQueryRef.current.request;
    setPendingAction("saved-view-save");
    setSaveViewDialogError(null);
    try {
      const result = await saveSavedLibraryView({
        id: crypto.randomUUID(),
        name,
        definition: {
          version: 1,
          querySyntax: request.querySyntax ?? "literal",
          query: request.query,
          filters: request.filters,
          sort: request.sort,
        },
      });
      if (!result.ok) {
        setSaveViewDialogError(describeLibraryError(result.error.code));
        return;
      }
      if (!result.value.view) {
        setSaveViewDialogError("The virtual library could not be returned by the library.");
        return;
      }

      const savedView = result.value.view;
      setSavedViews((current) => [...current.filter(({ id }) => id !== savedView.id), savedView]);
      commitCurrentSavedViewId(savedView.id);
      setSaveViewDialogOpen(false);
      setNotice({ kind: "status", text: `Saved virtual library “${savedView.name}”.` });
    } catch (error) {
      setSaveViewDialogError(describeUnexpectedLibraryError(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function removeSavedView(id: string): Promise<void> {
    if (pendingAction !== null) {
      return;
    }

    const view = savedViews.find((candidate) => candidate.id === id);
    setPendingAction(`saved-view-remove:${id}`);
    setNotice(null);
    try {
      const result = await removeSavedLibraryView({ id });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      setSavedViews((current) => current.filter((candidate) => candidate.id !== id));
      if (currentSavedViewId === id) {
        clearLibraryQuery();
      }
      setNotice({
        kind: "status",
        text: view
          ? `Removed virtual library “${view.name}”.`
          : "Removed the virtual library.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  function openDuplicateReview(disposition: DuplicateReviewDisposition): void {
    if (
      pendingAction !== null ||
      duplicateMutationPending.current ||
      importDialogOpen
    ) {
      return;
    }
    duplicatePageOffsetRef.current = 0;
    setDuplicateDisposition(disposition);
    setDuplicatePageOffset(0);
    setDuplicateCandidates([]);
    setDuplicateTotal(0);
    setDuplicateStaleReviewToken(null);
    setDuplicateError(null);
    setDuplicateDialogOpen(true);
    void loadDuplicateReviewPage(0, disposition);
  }

  function closeDuplicateReview(): void {
    if (duplicateMutationPending.current) {
      return;
    }
    duplicateRequestSequence.current += 1;
    setDuplicateLoading(false);
    setDuplicateStaleReviewToken(null);
    setDuplicateError(null);
    setDuplicateDialogOpen(false);
  }

  function changeDuplicateReviewPage(offset: number): void {
    if (duplicateLoading || duplicateMutationPending.current) {
      return;
    }
    duplicatePageOffsetRef.current = offset;
    setDuplicatePageOffset(offset);
    setDuplicateCandidates([]);
    setDuplicateStaleReviewToken(null);
    setDuplicateError(null);
    void loadDuplicateReviewPage(offset, duplicateDisposition);
  }

  function findDuplicateCandidate(reviewToken: string): DuplicateCandidate | null {
    return (
      duplicateCandidates.find((candidate) => candidate.reviewToken === reviewToken) ??
      null
    );
  }

  function reportDuplicateMutationError(code: string, reviewToken: string): void {
    setDuplicateError(describeLibraryError(code));
    if (code === "stale-review") {
      setDuplicateStaleReviewToken(reviewToken);
    }
  }

  async function keepDuplicateReviewPair(
    request: KeepDuplicatePairRequest,
  ): Promise<void> {
    if (pendingAction !== null || duplicateMutationPending.current) {
      return;
    }
    const candidate = findDuplicateCandidate(request.reviewToken);
    if (!candidate) {
      return;
    }

    duplicateMutationPending.current = true;
    setPendingAction(`duplicate-keep:${request.reviewToken}`);
    setDuplicatePendingReviewToken(request.reviewToken);
    setDuplicatePendingAction("keep");
    setDuplicateError(null);
    setNotice(null);
    try {
      const result = await keepDuplicatePair(request);
      if (!result.ok) {
        reportDuplicateMutationError(result.error.code, request.reviewToken);
        return;
      }

      setDuplicateCandidates([]);
      if (await loadDuplicateReviewPage(duplicatePageOffsetRef.current, duplicateDisposition)) {
        setNotice({
          kind: "status",
          text: `Kept “${candidate.left.title}” and “${candidate.right.title}” as separate books.`,
        });
      } else {
        setNotice({
          kind: "error",
          text: "Kept the pair separate, but duplicate candidates could not be refreshed.",
        });
      }
    } catch (error) {
      setDuplicateError(describeUnexpectedLibraryError(error));
    } finally {
      duplicateMutationPending.current = false;
      setDuplicatePendingReviewToken(null);
      setDuplicatePendingAction(null);
      setPendingAction(null);
    }
  }

  async function reopenDuplicateReviewPair(
    request: ReopenDuplicatePairRequest,
  ): Promise<void> {
    if (pendingAction !== null || duplicateMutationPending.current) {
      return;
    }
    const candidate = findDuplicateCandidate(request.reviewToken);
    if (!candidate) {
      return;
    }

    duplicateMutationPending.current = true;
    setPendingAction(`duplicate-reopen:${request.reviewToken}`);
    setDuplicatePendingReviewToken(request.reviewToken);
    setDuplicatePendingAction("reopen");
    setDuplicateError(null);
    setNotice(null);
    try {
      const result = await reopenDuplicatePair(request);
      if (!result.ok) {
        reportDuplicateMutationError(result.error.code, request.reviewToken);
        return;
      }

      setDuplicateCandidates([]);
      if (await loadDuplicateReviewPage(duplicatePageOffsetRef.current, duplicateDisposition)) {
        setNotice({
          kind: "status",
          text: `Reopened “${candidate.left.title}” and “${candidate.right.title}” for duplicate review.`,
        });
      } else {
        setNotice({
          kind: "error",
          text: "Reopened the pair, but duplicate candidates could not be refreshed.",
        });
      }
    } catch (error) {
      setDuplicateError(describeUnexpectedLibraryError(error));
    } finally {
      duplicateMutationPending.current = false;
      setDuplicatePendingReviewToken(null);
      setDuplicatePendingAction(null);
      setPendingAction(null);
    }
  }

  async function mergeDuplicateReviewPair(
    request: MergeDuplicatePairRequest,
  ): Promise<void> {
    if (pendingAction !== null || duplicateMutationPending.current) {
      return;
    }
    const candidate = findDuplicateCandidate(request.reviewToken);
    if (!candidate) {
      return;
    }

    duplicateMutationPending.current = true;
    setPendingAction(`duplicate-merge:${request.reviewToken}`);
    setDuplicatePendingReviewToken(request.reviewToken);
    setDuplicatePendingAction("merge");
    setDuplicateError(null);
    setNotice(null);
    try {
      const result = await mergeDuplicatePair(request);
      if (!result.ok) {
        reportDuplicateMutationError(result.error.code, request.reviewToken);
        return;
      }

      const pairIds = new Set([candidate.left.id, candidate.right.id]);
      dispatchLibrarySelection({ type: "remove-items", ids: [request.sourceId] });
      setDraft((currentDraft) =>
        currentDraft && pairIds.has(currentDraft.id) ? null : currentDraft,
      );
      setConversionDraft((currentDraft) =>
        currentDraft && pairIds.has(currentDraft.id) ? null : currentDraft,
      );
      setDuplicateCandidates([]);

      const [libraryLoaded, duplicatesLoaded] = await Promise.all([
        loadLibrary(false),
        loadDuplicateReviewPage(duplicatePageOffsetRef.current, duplicateDisposition),
      ]);
      if (
        libraryLoaded &&
        libraryQueryRef.current.page?.items.some(
          ({ id }) => id === result.value.target.id,
        )
      ) {
        selectLibraryItem(result.value.target.id);
      }
      if (!libraryLoaded || !duplicatesLoaded) {
        setNotice({
          kind: "error",
          text: "The books were merged, but the library or duplicate candidates could not be refreshed.",
        });
        return;
      }
      setNotice({
        kind: "status",
        text: `Merged “${result.value.trashedSource.title}” into “${result.value.target.title}” and moved the source to Trash.${
          result.value.cleanupPending
            ? " Some Takio-managed files could not be deleted; cleanup is pending."
            : ""
        }`,
      });
    } catch (error) {
      setDuplicateError(describeUnexpectedLibraryError(error));
    } finally {
      duplicateMutationPending.current = false;
      setDuplicatePendingReviewToken(null);
      setDuplicatePendingAction(null);
      setPendingAction(null);
    }
  }

  function openTrash(): void {
    if (pendingAction !== null) {
      return;
    }
    trashPageOffsetRef.current = 0;
    setTrashPageOffset(0);
    setTrashItems([]);
    setTrashTotal(0);
    setTrashError(null);
    setTrashDialogOpen(true);
    void loadTrash(0);
  }

  function closeTrash(): void {
    if (trashPendingAction !== null) {
      return;
    }
    trashRequestSequence.current += 1;
    setTrashLoading(false);
    setTrashError(null);
    setTrashDialogOpen(false);
  }

  function changeTrashPage(offset: number): void {
    if (trashLoading || trashPendingAction !== null) {
      return;
    }
    trashPageOffsetRef.current = offset;
    setTrashPageOffset(offset);
    setTrashItems([]);
    void loadTrash(offset);
  }

  async function restoreTrashItem(item: LibraryItem): Promise<void> {
    if (pendingAction !== null) {
      return;
    }

    setPendingAction(`trash-restore:${item.id}`);
    setTrashPendingItemId(item.id);
    setTrashPendingAction("restore");
    setTrashError(null);
    setNotice(null);
    try {
      const result = await restoreLibraryItem({ id: item.id });
      if (!result.ok) {
        setTrashError(describeLibraryError(result.error.code));
        return;
      }

      const [libraryLoaded] = await Promise.all([
        loadLibrary(false),
        loadTrash(trashPageOffsetRef.current),
      ]);
      if (libraryLoaded) {
        setNotice({
          kind: "status",
          text: result.value.item
            ? `Restored “${item.title}” to the library.`
            : `“${item.title}” is no longer in Trash.`,
        });
      }
    } catch (error) {
      setTrashError(describeUnexpectedLibraryError(error));
    } finally {
      setTrashPendingItemId(null);
      setTrashPendingAction(null);
      setPendingAction(null);
    }
  }

  async function purgeTrashItem(item: LibraryItem): Promise<void> {
    if (pendingAction !== null) {
      return;
    }

    setPendingAction(`trash-purge:${item.id}`);
    setTrashPendingItemId(item.id);
    setTrashPendingAction("purge");
    setTrashError(null);
    setNotice(null);
    try {
      const result = await purgeLibraryItem({ id: item.id });
      if (!result.ok) {
        setTrashError(describeLibraryError(result.error.code));
        return;
      }

      const trashLoaded = await loadTrash(trashPageOffsetRef.current);
      if (trashLoaded) {
        setNotice({
          kind: "status",
          text: result.value.item
            ? result.value.cleanupPending
              ? `Permanently deleted “${item.title}”. Some Takio-managed files could not be deleted; cleanup is pending.`
              : `Permanently deleted “${item.title}”.`
            : `“${item.title}” is no longer in Trash.`,
        });
      }
    } catch (error) {
      setTrashError(describeUnexpectedLibraryError(error));
    } finally {
      setTrashPendingItemId(null);
      setTrashPendingAction(null);
      setPendingAction(null);
    }
  }

  async function retryLibrary(): Promise<boolean> {
    const [libraryLoaded] = await Promise.all([
      loadLibrary(true),
      loadSavedViews(),
    ]);
    return libraryLoaded;
  }

  function openImportDialog(): void {
    if (pendingAction !== null || importPending.current || libraryModalOpen) {
      return;
    }
    setImportRootPaths([]);
    setImportReport(null);
    setImportDialogError(null);
    setImportDialogOpen(true);
  }

  function closeImportDialog(): void {
    if (!importPending.current) {
      setImportDialogOpen(false);
    }
  }

  function addImportRoots(paths: readonly string[]): void {
    const combinedPaths = uniqueImportPaths([...importRootPaths, ...paths]);
    setImportReport(null);
    if (combinedPaths.length > MAX_LIBRARY_IMPORT_ROOTS) {
      setImportDialogError(
        `Choose no more than ${MAX_LIBRARY_IMPORT_ROOTS} files or folders in one import.`,
      );
      return;
    }
    setImportRootPaths(combinedPaths);
    setImportDialogError(null);
  }

  async function chooseImportFiles(): Promise<void> {
    if (pendingAction !== null || importPending.current) {
      return;
    }
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: true,
        filters: [{ name: "Supported books and documents", extensions: supportedExtensions }],
      });
    } catch (error) {
      setImportDialogError(describeUnexpectedLibraryError(error));
      return;
    }

    if (selection !== null) {
      addImportRoots(typeof selection === "string" ? [selection] : selection);
    }
  }

  async function chooseImportFolders(): Promise<void> {
    if (pendingAction !== null || importPending.current) {
      return;
    }
    let selection: string | string[] | null;
    try {
      selection = await open({ directory: true, multiple: true });
    } catch (error) {
      setImportDialogError(describeUnexpectedLibraryError(error));
      return;
    }

    if (selection !== null) {
      addImportRoots(typeof selection === "string" ? [selection] : selection);
    }
  }

  const importPaths = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      const roots = uniqueImportPaths(paths);
      if (pendingAction !== null || importPending.current || duplicateDialogOpen) {
        return;
      }
      if (roots.length < 1 || roots.length > MAX_LIBRARY_IMPORT_ROOTS) {
        setImportDialogError(
          `Choose between 1 and ${MAX_LIBRARY_IMPORT_ROOTS} files or folders.`,
        );
        return;
      }

      importPending.current = true;
      setPendingAction("import");
      setImportReport(null);
      setImportDialogError(null);
      setNotice(null);
      try {
        const result = await importLibraryItems(roots, importMode);
        if (!result.ok) {
          const error = describeLibraryError(result.error.code);
          setImportDialogError(error);
          setNotice({ kind: "error", text: error });
          return;
        }

        setImportReport(result.value);
        const refreshed = await loadLibrary(false);
        const failed = result.value.counts.failed;
        const details = [importSummary(result.value)];
        if (!refreshed) {
          details.push("The import completed, but the library could not be refreshed.");
        }
        setImportDialogError(
          [
            failed > 0
              ? `${failed} ${failed === 1 ? "file" : "files"} failed to import. Review the report for exact paths and error codes.`
              : null,
            !refreshed ? "The library could not be refreshed." : null,
          ]
            .filter((detail): detail is string => detail !== null)
            .join(" ") || null,
        );
        setNotice({
          kind: failed > 0 || !refreshed ? "error" : "status",
          text: details.join(" "),
        });
      } catch (error) {
        const message = describeUnexpectedLibraryError(error);
        setImportDialogError(message);
        setNotice({ kind: "error", text: message });
      } finally {
        importPending.current = false;
        setPendingAction(null);
      }
    },
    [duplicateDialogOpen, importMode, loadLibrary, pendingAction],
  );

  async function importDroppedPaths(paths: readonly string[]): Promise<void> {
    if (pendingAction !== null || importPending.current || libraryModalOpen) {
      return;
    }
    const roots = uniqueImportPaths(paths);
    setImportRootPaths(roots.length <= MAX_LIBRARY_IMPORT_ROOTS ? roots : []);
    setImportReport(null);
    setImportDialogError(null);
    setImportDialogOpen(true);
  }

  async function saveMetadata(item: LibraryItem, patch: LibraryMetadataPatch) {
    setPendingAction(`edit:${item.id}`);
    setNotice(null);
    try {
      const result = await updateLibraryItem(item.id, patch);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        await loadLibrary(false);
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setDraft(null);
      if (await loadLibrary(false)) {
        setNotice({ kind: "status", text: `Saved “${result.value.item.title}”.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  function metadataCandidateApplied(item: LibraryItem) {
    replaceItem(item);
    setNotice({ kind: "status", text: `Applied selected metadata to “${item.title}”.` });
  }

  async function chooseCover(item: LibraryItem) {
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: false,
        filters: [{ name: "Cover images", extensions: coverExtensions }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }
    if (typeof selection !== "string") {
      return;
    }

    setPendingAction(`cover:${item.id}`);
    setNotice(null);
    try {
      const result = await setLibraryCover(item.id, selection);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        await loadLibrary(false);
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      if (await loadLibrary(false)) {
        setNotice({ kind: "status", text: `Updated the cover for “${item.title}”.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function clearCover(item: LibraryItem) {
    setPendingAction(`cover:${item.id}`);
    setNotice(null);
    try {
      const result = await removeLibraryCover(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        await loadLibrary(false);
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      if (await loadLibrary(false)) {
        setNotice({ kind: "status", text: `Removed the cover for “${item.title}”.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function attachFormat(
    item: LibraryItem,
    mode: "copy" | "reference",
    focusControlId: string,
  ): Promise<void> {
    if (formatMutationPending.current) {
      return;
    }
    formatMutationPending.current = true;

    try {
      let selection: string | string[] | null;
      try {
        selection = await open({
          multiple: false,
          filters: [{ name: "Supported books and documents", extensions: supportedExtensions }],
        });
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        document.getElementById(focusControlId)?.focus();
        return;
      }

      if (typeof selection !== "string") {
        document.getElementById(focusControlId)?.focus();
        return;
      }

      postFormatFocusControlId.current = focusControlId;
      setPendingAction(`format-attach:${item.id}:${mode}`);
      setNotice(null);
      try {
        const result = await attachLibraryFormat(item.id, selection, mode);
        if (result.ok) {
          supersedePendingLibraryRequest();
        }
        if (!result.ok) {
          setNotice({
            kind: "error",
            text:
              result.error.code === "duplicate-format"
                ? "That format is already attached to this library item."
                : describeLibraryError(result.error.code),
          });
          return;
        }

        const updated = result.value.item;
        if (!updated) {
          discardMissingItem(item);
          await loadLibrary(false);
          setNotice({ kind: "error", text: "That library item no longer exists." });
          return;
        }
        const addedFormat = updated.formats.find(
          ({ format }) => !item.formats.some((current) => current.format === format),
        );
        const label = addedFormat
          ? FORMAT_CATALOG.find((definition) => definition.id === addedFormat.format)!.label
          : "format";
        replaceItem(updated);
        selectLibraryItem(updated.id);
        if (await loadLibrary(false)) {
          setNotice({
            kind: "status",
            text:
              mode === "copy"
                ? `Imported a managed ${label} copy for “${updated.title}”. The selected source file remains in place.`
                : `Attached a referenced ${label} file to “${updated.title}”. The original file remains in place.`,
          });
        }
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      } finally {
        setPendingAction(null);
      }
    } finally {
      formatMutationPending.current = false;
    }
  }

  async function removeFormat(
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ): Promise<void> {
    if (formatMutationPending.current) {
      return;
    }
    formatMutationPending.current = true;

    try {
      if (item.formats.length === 1) {
        setNotice({ kind: "error", text: "Add another format before removing this one." });
        return;
      }

      const removedIndex = item.formats.findIndex(
        (candidate) => candidate.format === bookFormat.format,
      );
      const label = FORMAT_CATALOG.find(
        (definition) => definition.id === bookFormat.format,
      )!.label;
      const nextPrimary = removedIndex === 0 ? item.formats[1] : undefined;
      const nextPrimaryLabel = nextPrimary
        ? FORMAT_CATALOG.find((definition) => definition.id === nextPrimary.format)!.label
        : null;
      const primaryConsequence = nextPrimaryLabel
        ? ` ${nextPrimaryLabel} will become the primary format used by Open, Send, and Convert.`
        : "";
      const managed = bookFormat.provenance === "managed";

      let approved: boolean;
      try {
        approved = await confirm(
          managed
            ? `Remove ${label} from “${item.title}” and permanently delete Takio’s managed copy? This cannot be undone. Files outside Takio will not be changed.${primaryConsequence}`
            : `Remove the ${label} reference from “${item.title}”? The original file will stay on your Mac.${primaryConsequence}`,
          {
            title: managed ? `Delete managed ${label}?` : `Detach referenced ${label}?`,
            kind: "warning",
            okLabel: managed ? "Delete managed copy" : "Detach reference",
            cancelLabel: "Cancel",
          },
        );
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        document.getElementById(focusControlId)?.focus();
        return;
      }

      if (!approved) {
        document.getElementById(focusControlId)?.focus();
        return;
      }

      setPendingAction(`format-remove:${item.id}:${bookFormat.format}`);
      setNotice(null);
      try {
        const result = await removeLibraryFormat(item.id, bookFormat.format);
        if (result.ok) {
          supersedePendingLibraryRequest();
        }
        if (!result.ok) {
          postFormatFocusControlId.current = focusControlId;
          setNotice({
            kind: "error",
            text:
              result.error.code === "last-format"
                ? "Add another format before removing this one."
                : describeLibraryError(result.error.code),
          });
          return;
        }

        if (!result.value.item) {
          discardMissingItem(item);
          await loadLibrary(false);
          setNotice({ kind: "error", text: "That library item no longer exists." });
          return;
        }

        const updated = result.value.item;
        const focusFormat = updated.formats[removedIndex] ?? updated.formats[removedIndex - 1];
        postFormatFocusControlId.current =
          updated.formats.length > 1 && focusFormat
            ? `format-remove-${updated.id}-${focusFormat.format}`
            : `format-import-copy-${updated.id}`;
        replaceItem(updated);
        selectLibraryItem(updated.id);
        if (await loadLibrary(false)) {
          setNotice({
            kind: "status",
            text: managed
              ? result.value.cleanupPending
                ? `Removed managed ${label} from “${updated.title}”. Cleanup could not be completed and will be retried.`
                : `Deleted Takio’s managed ${label} copy and removed the format from “${updated.title}”.`
              : `Detached referenced ${label} from “${updated.title}”. The original file was not changed.`,
          });
        }
      } catch (error) {
        postFormatFocusControlId.current = focusControlId;
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      } finally {
        setPendingAction(null);
      }
    } finally {
      formatMutationPending.current = false;
    }
  }

  async function removeItem(item: LibraryItem) {
    let approved: boolean;
    try {
      approved = await confirm(
        `Move “${item.title}” to Trash? You can restore it later.`,
        {
          title: "Move to Trash",
          kind: "warning",
          okLabel: "Move to Trash",
          cancelLabel: "Cancel",
        },
      );
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }

    if (!approved) {
      return;
    }

    setPendingAction(`remove:${item.id}`);
    setNotice(null);
    try {
      const result = await trashLibraryItem({ id: item.id });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      if (!result.value.item) {
        discardMissingItem(item);
        const [libraryLoaded] = await Promise.all([
          loadLibrary(false),
          trashDialogOpen
            ? loadTrash(trashPageOffsetRef.current)
            : Promise.resolve(true),
        ]);
        if (libraryLoaded) {
          postRemoveFocusItemId.current = libraryQueryRef.current.selectedItemId;
        }
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      const removedIndex = itemsRef.current.findIndex((candidate) => candidate.id === item.id);
      const remainingItems = itemsRef.current.filter((candidate) => candidate.id !== item.id);
      const focusItem =
        removedIndex < 0
          ? remainingItems[0]
          : (remainingItems[removedIndex] ?? remainingItems[removedIndex - 1]);
      postRemoveFocusItemId.current = focusItem?.id ?? null;
      setItems(remainingItems);
      setDraft((currentDraft) => (currentDraft?.id === item.id ? null : currentDraft));
      setConversionDraft((currentDraft) =>
        currentDraft?.id === item.id ? null : currentDraft,
      );
      if (libraryQueryRef.current.selectedItemId === item.id) {
        selectLibraryItem(focusItem?.id ?? null);
      }
      setLibraryState("ready");
      const [libraryLoaded] = await Promise.all([
        loadLibrary(false),
        trashDialogOpen
          ? loadTrash(trashPageOffsetRef.current)
          : Promise.resolve(true),
      ]);
      if (libraryLoaded) {
        postRemoveFocusItemId.current = libraryQueryRef.current.selectedItemId;
        setNotice({
          kind: "status",
          text: `Moved “${item.title}” to Trash.`,
        });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function openItem(
    item: LibraryItem,
    bookFormat: BookFormat,
    focusControlId: string,
  ): Promise<void> {
    if (bulkMutationPending.current || openPending.current) {
      return;
    }

    openPending.current = true;
    postFormatFocusControlId.current = focusControlId;
    selectLibraryItem(item.id);
    setPendingAction(`open:${item.id}:${bookFormat.format}`);
    setNotice(null);
    try {
      const result = await openLibraryItem(item.id, bookFormat.format);
      if (!result.ok) {
        const errorText = describeLibraryError(result.error.code);
        if (result.error.code === "format-not-found" || result.error.code === "not-found") {
          const refreshed = await loadLibrary(false);
          if (result.error.code === "format-not-found" && refreshed) {
            postFormatFocusControlId.current = `library-primary-open-${item.id}`;
          }
        }
        setNotice({ kind: "error", text: errorText });
        return;
      }

      const label = FORMAT_CATALOG.find(
        (definition) => definition.id === bookFormat.format,
      )!.label;
      setNotice({ kind: "status", text: `Opened ${label} for “${item.title}”.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      openPending.current = false;
      setPendingAction(null);
    }
  }

  async function refreshDestinations() {
    setNotice(null);
    destinationInventoryRequestSequence.current += 1;
    setDestinationInventoryEntries([]);
    setDestinationInventoryLoading(false);
    if (await loadDestinations()) {
      setNotice({ kind: "status", text: "Reader list refreshed." });
    }
  }

  async function reconcileSelectedDestination() {
    if (!selectedDestination) return;
    setNotice(null);
    if (await loadDestinationInventory(selectedDestination, "reconcile")) {
      setNotice({ kind: "status", text: "Delivery status refreshed." });
    }
  }

  async function removeTrackedDelivery(entry: DestinationInventoryEntry) {
    if (!selectedDestination || entry.status !== "present") return;
    let approved: boolean;
    try {
      approved = await confirm(
        `Remove the unchanged Takio-tracked copy “${entry.relativePath}” from ${selectedDestination.name}?`,
        {
          title: "Remove reader copy",
          kind: "warning",
          okLabel: "Remove copy",
          cancelLabel: "Cancel",
        },
      );
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
      return;
    }
    if (!approved) return;

    setPendingAction(`reader-remove:${entry.itemId}`);
    setNotice(null);
    try {
      const result = await removeDestinationDelivery(
        selectedDestination.path,
        entry.itemId,
      );
      if (!result.ok) {
        setNotice({
          kind: "error",
          text: result.error.code === "verification-failed"
            ? "Takio did not remove the reader file because it changed after delivery."
            : describeDestinationError(result.error.code),
        });
        await loadDestinationInventory(selectedDestination);
        return;
      }
      if (
        result.value.destinationId !== selectedDestination.id ||
        result.value.removed.relativePath !== entry.relativePath
      ) {
        setNotice({ kind: "error", text: describeDestinationError("protocol-error") });
        await loadDestinationInventory(selectedDestination);
        return;
      }
      await loadDestinationInventory(selectedDestination);
      setNotice({ kind: "status", text: `Removed “${entry.relativePath}” from ${selectedDestination.name}.` });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function enqueueConversion(event: FormEvent, item: LibraryItem): Promise<void> {
    event.preventDefault();
    const requested = conversionDraft;
    if (
      requested?.id !== item.id ||
      requested.source.format !== "epub" ||
      requested.target !== "pdf" ||
      item.formats.some(({ format }) => format === requested.target) ||
      !item.formats.some(
        ({ format, sourcePath }) =>
          format === requested.source.format && sourcePath === requested.source.sourcePath,
      )
    ) {
      return;
    }

    setPendingAction(`job-enqueue:${item.id}`);
    setNotice(null);
    try {
      const output = await createConversionOutputPath();
      const result = await enqueueConversionJob({
        libraryItemId: item.id,
        inputFormat: requested.source.format,
        outputFormat: requested.target,
        outputPath: output,
      });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeJobError(result.error.code) });
        return;
      }

      postConversionFocusControlId.current = conversionControlId(
        item.id,
        requested.source,
        requested.target,
      );
      setConversionDraft(null);
      if (await loadJobs(false)) {
        setNotice({ kind: "status", text: `Queued “${item.title}” for PDF conversion.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function refreshJobs(): Promise<void> {
    setNotice(null);
    if (await loadJobs()) {
      setNotice({ kind: "status", text: "Conversion list refreshed." });
    }
  }

  const runNextJob = useCallback(async (drainQueue = false): Promise<void> => {
    if (conversionWorkerPending.current) {
      return;
    }
    conversionWorkerPending.current = true;
    setConversionRunning(true);
    setNotice(null);
    try {
      do {
        const result = await runNextConversionJob();
        if (!result.ok) {
          autoDrainBlocked.current = true;
          setNotice({ kind: "error", text: describeJobError(result.error.code) });
          break;
        }

        const completedJob = result.value.job?.status === "completed" ? result.value.job : null;
        const [jobsLoaded, libraryLoaded] = await Promise.all([
          loadJobs(false),
          completedJob ? loadLibrary(false) : Promise.resolve(true),
        ]);
        if (!jobsLoaded || !libraryLoaded) {
          break;
        }
        if (result.value.job === null) {
          if (!drainQueue) {
            setNotice({ kind: "status", text: "No queued conversions." });
          }
          break;
        } else if (result.value.job.status === "completed") {
          const completed = result.value.job;
          const title = completed.libraryItemId
            ? itemsRef.current.find(({ id }) => id === completed.libraryItemId)?.title
            : undefined;
          const subject = title ? ` for “${title}”` : "";
          if (completed.attachment?.status === "pending") {
            setNotice({
              kind: "status",
              text: `Conversion completed${subject}; PDF attachment is pending.`,
            });
          } else if (completed.attachment?.status === "attached") {
            setNotice({
              kind: "status",
              text: `Conversion completed${subject}; PDF was attached to the library item.`,
            });
          } else if (completed.attachment?.status === "failed") {
            setNotice({
              kind: "error",
              text: `Conversion completed${subject}, but PDF attachment failed (${completed.attachment.errorCode}).`,
            });
          } else {
            setNotice({
              kind: "status",
              text: `Conversion completed: ${completed.outputPath}`,
            });
          }
        } else if (result.value.job.status === "failed") {
          setNotice({
            kind: "error",
            text: describeJobError(result.value.job.errorCode ?? "conversion-failed"),
          });
        } else {
          setNotice({ kind: "status", text: "Conversion list updated." });
        }
      } while (drainQueue);
    } catch (error) {
      autoDrainBlocked.current = true;
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
    } finally {
      conversionWorkerPending.current = false;
      setConversionRunning(false);
    }
  }, [loadJobs, loadLibrary]);

  useEffect(() => {
    if (
      jobsState === "ready" &&
      !conversionRunning &&
      jobs.some(({ status }) => status === "queued") &&
      !autoDrainBlocked.current &&
      !conversionWorkerPending.current
    ) {
      void runNextJob(true);
    }
  }, [conversionRunning, jobs, jobsState, runNextJob]);

  async function retryJob(job: ConversionJob): Promise<void> {
    if (job.status !== "failed" && job.status !== "canceled") {
      return;
    }
    setPendingAction(`job-retry:${job.id}`);
    setNotice(null);
    try {
      const result = await retryConversionJob(job.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeJobError(result.error.code) });
        return;
      }

      if (await loadJobs(false)) {
        setNotice({ kind: "status", text: `Queued conversion retry to ${job.outputPath}.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function cancelJob(job: ConversionJob): Promise<void> {
    if (job.status !== "queued") {
      return;
    }
    setPendingAction(`job-cancel:${job.id}`);
    setNotice(null);
    try {
      const result = await cancelConversionJob(job.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeJobError(result.error.code) });
        return;
      }

      if (await loadJobs(false)) {
        setNotice({ kind: "status", text: `Canceled conversion to ${job.outputPath}.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
    } finally {
      setPendingAction(null);
    }
  }

  async function sendItem(item: LibraryItem, bookFormat: BookFormat) {
    if (bulkMutationPending.current || deviceMutationPending.current) {
      return;
    }
    selectLibraryItem(item.id);
    if (!selectedDestination) {
      setNotice({ kind: "error", text: "Choose a reader before sending." });
      return;
    }

    deviceMutationPending.current = true;
    setPendingAction(`send:${item.id}:${bookFormat.format}`);
    setNotice(null);
    try {
      const result = await sendLibraryItem(
        item.id,
        bookFormat.format,
        selectedDestination.path,
        convertIfNeeded,
      );
      if (!result.ok) {
        const errorText = describeDestinationError(result.error.code);
        if (result.error.code === "format-not-found" || result.error.code === "unknown-item") {
          await loadLibrary(false);
        }
        setNotice({ kind: "error", text: errorText });
        return;
      }

      const label = FORMAT_CATALOG.find(
        (definition) => definition.id === bookFormat.format,
      )!.label;
      setNotice({
        kind: "status",
        text: `Sent ${label} to ${result.value.path} · ${result.value.bytes.toLocaleString()} bytes · SHA-256 ${result.value.sha256}`,
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
    } finally {
      deviceMutationPending.current = false;
      setPendingAction(null);
    }
  }

  async function ejectSelectedDestination() {
    if (bulkMutationPending.current || deviceMutationPending.current) {
      return;
    }
    if (!selectedDestination) {
      setNotice({ kind: "error", text: "Choose a reader before ejecting." });
      return;
    }

    const destination = selectedDestination;
    deviceMutationPending.current = true;
    setPendingAction("eject");
    setNotice(null);
    try {
      const result = await ejectDestination(destination.path);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeDestinationError(result.error.code) });
        return;
      }

      setSelectedDestinationId(null);
      if (await loadDestinations()) {
        setNotice({ kind: "status", text: `Ejected ${destination.name}.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedDestinationError(error) });
    } finally {
      deviceMutationPending.current = false;
      setPendingAction(null);
    }
  }

  const actionsPending = pendingAction !== null;
  const query = libraryQuery.request.query;
  const selectedItemId = libraryQuery.selectedItemId;
  const cataloguePage = libraryQuery.page;
  const catalogueItems = cataloguePage === null ? [] : items;
  const selectedDestination =
    destinations.find((destination) => destination.id === selectedDestinationId) ?? null;
  const preferredDeviceFormat = selectedDestination
    ? (preferredFormatsByDestinationPath[selectedDestination.path] ?? null)
    : null;
  const selectedItem = catalogueItems.find((item) => item.id === selectedItemId) ?? null;

  function restoreFocusIfBulkSelectionCleared(
    selectedIds: readonly string[],
    removedIds: readonly string[],
  ): void {
    const removed = new Set(removedIds);
    if (selectedIds.length === 0 || selectedIds.some((id) => !removed.has(id))) {
      return;
    }

    postBulkFocusPending.current = true;
  }

  async function hydrateBulkTargets(
    selectedIds: readonly string[],
    reportDialogError = false,
  ): Promise<
    | {
        readonly items: readonly LibraryItem[];
        readonly missingIds: readonly string[];
      }
    | null
  > {
    const hydration = await hydrateSelectedLibraryItems(selectedIds, getLibraryItem);
    const missingIds = hydration.outcomes
      .filter(({ status }) => status === "missing")
      .map(({ id }) => id);
    if (missingIds.length > 0) {
      dispatchLibrarySelection({ type: "remove-items", ids: missingIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, missingIds);
    }

    if (hydration.counts.failed > 0) {
      const libraryLoaded = await loadLibrary(false);
      const summary = `No changes made: ${hydration.counts.failed} lookups failed (${hydration.counts.found} found, ${hydration.counts.missing} missing of ${hydration.counts.total} selected).${libraryLoaded ? "" : " Library refresh failed."}`;
      setNotice({ kind: "error", text: summary });
      if (reportDialogError) {
        setBulkTagsDialogError(summary);
      }
      return null;
    }

    return {
      items: hydration.outcomes.flatMap((outcome) =>
        outcome.status === "found" ? [outcome.item] : [],
      ),
      missingIds,
    };
  }

  function openBulkTagsDialog(): void {
    if (
      pendingAction !== null ||
      bulkMutationPending.current ||
      bulkExportDialogOpen ||
      bulkMetadataDialogOpen ||
      bulkMetadataCandidateDialogOpen ||
      librarySelection.selectedItemIds.length === 0
    ) {
      return;
    }
    setBulkTagsDialogError(null);
    setBulkTagsDialogOpen(true);
  }

  function closeBulkTagsDialog(): void {
    if (!bulkMutationPending.current) {
      setBulkTagsDialogError(null);
      setBulkTagsDialogOpen(false);
    }
  }

  function openBulkMetadataDialog(): void {
    if (
      pendingAction !== null ||
      bulkMutationPending.current ||
      bulkExportDialogOpen ||
      bulkTagsDialogOpen ||
      saveViewDialogOpen ||
      importDialogOpen ||
      trashDialogOpen ||
      duplicateDialogOpen ||
      librarySelection.selectedItemIds.length === 0
    ) {
      return;
    }
    setBulkMetadataDialogError(null);
    setBulkMetadataDialogOpen(true);
  }

  function closeBulkMetadataDialog(): void {
    if (!bulkMutationPending.current) {
      setBulkMetadataDialogError(null);
      setBulkMetadataDialogOpen(false);
    }
  }

  function openBulkMetadataCandidateDialog(): void {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current ||
      libraryModalOpen
    ) {
      return;
    }
    if (selectedIds.length > MAX_BULK_METADATA_CANDIDATE_ITEMS) {
      setNotice({
        kind: "error",
        text: `Choose no more than ${MAX_BULK_METADATA_CANDIDATE_ITEMS} books to review metadata.`,
      });
      return;
    }
    setBulkMetadataCandidateItemIds(selectedIds);
    setBulkMetadataCandidateDialogOpen(true);
  }

  function closeBulkMetadataCandidateDialog(): void {
    setBulkMetadataCandidateDialogOpen(false);
    setBulkMetadataCandidateItemIds([]);
  }

  function bulkMetadataCandidateApplied(item: LibraryItem): void {
    replaceItem(item);
    dispatchLibrarySelection({ type: "remove-items", ids: [item.id] });
    void loadLibrary(false);
  }

  function openBulkExportDialog(): void {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current ||
      saveViewDialogOpen ||
      importDialogOpen ||
      trashDialogOpen ||
      duplicateDialogOpen ||
      bulkTagsDialogOpen ||
      bulkMetadataDialogOpen ||
      bulkMetadataCandidateDialogOpen ||
      bulkExportDialogOpen
    ) {
      return;
    }
    if (selectedIds.length > MAX_LIBRARY_EXPORT_ITEMS) {
      setNotice({
        kind: "error",
        text: `Choose no more than ${MAX_LIBRARY_EXPORT_ITEMS} books to save to disk.`,
      });
      return;
    }

    setBulkExportItemIds(selectedIds);
    setBulkExportDialogOpen(true);
  }

  function closeBulkExportDialog(): void {
    if (!bulkMutationPending.current) {
      setBulkExportDialogOpen(false);
      setBulkExportItemIds([]);
    }
  }

  async function applyBulkMetadata(patch: LibraryMetadataPatch): Promise<void> {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current ||
      !bulkMetadataDialogOpen
    ) {
      return;
    }

    bulkMutationPending.current = true;
    setBulkPendingAction("metadata");
    setPendingAction("bulk-metadata");
    setBulkMetadataDialogError(null);
    setNotice(null);
    try {
      const hydration = await hydrateSelectedLibraryItems(selectedIds, getLibraryItem);
      let updated = 0;
      let missing = hydration.counts.missing;
      let failed = hydration.counts.failed;
      const completedIds: string[] = [];

      for (const outcome of hydration.outcomes) {
        if (outcome.status !== "found") {
          continue;
        }
        try {
          const result = await updateLibraryItem(outcome.id, patch);
          if (!result.ok) {
            failed += 1;
          } else if (!result.value.item) {
            missing += 1;
          } else {
            updated += 1;
            completedIds.push(outcome.id);
          }
        } catch {
          failed += 1;
        }
      }

      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);
      const libraryLoaded = await loadLibrary(false);
      const summary = `${updated} updated; ${missing} missing; ${failed} failed.${libraryLoaded ? "" : " Library refresh failed."}`;
      const hasErrors = missing > 0 || failed > 0 || !libraryLoaded;
      setNotice({ kind: hasErrors ? "error" : "status", text: summary });
      if (hasErrors) {
        setBulkMetadataDialogError(summary);
      } else {
        setBulkMetadataDialogOpen(false);
      }
    } catch (error) {
      const message = describeUnexpectedLibraryError(error);
      setBulkMetadataDialogError(message);
      setNotice({ kind: "error", text: message });
    } finally {
      bulkMutationPending.current = false;
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  async function applyBulkTags(
    operation: Parameters<LibraryWorkspaceBulkActions["onApplyTags"]>[0],
    tags: readonly string[],
  ): Promise<void> {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current
    ) {
      return;
    }

    bulkMutationPending.current = true;
    setBulkPendingAction("tags");
    setPendingAction("bulk-tags");
    setBulkTagsDialogError(null);
    setNotice(null);
    try {
      const hydrated = await hydrateBulkTargets(selectedIds, true);
      if (!hydrated) {
        return;
      }

      let updated = 0;
      let missing = hydrated.missingIds.length;
      let failed = 0;
      const completedIds = [...hydrated.missingIds];
      for (const item of hydrated.items) {
        try {
          const result = await updateLibraryItem(item.id, {
            tags: applyBulkTagOperation(item.tags ?? [], operation, tags),
          });
          if (!result.ok) {
            failed += 1;
          } else if (!result.value.item) {
            missing += 1;
            completedIds.push(item.id);
          } else {
            updated += 1;
            completedIds.push(item.id);
          }
        } catch {
          failed += 1;
        }
      }

      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);
      const libraryLoaded = await loadLibrary(false);
      const summary = `${updated} updated; ${missing} missing; ${failed} failed.${libraryLoaded ? "" : " Library refresh failed."}`;
      setNotice({ kind: failed > 0 || !libraryLoaded ? "error" : "status", text: summary });
      if (failed > 0) {
        setBulkTagsDialogError(summary);
      } else {
        setBulkTagsDialogOpen(false);
      }
    } finally {
      bulkMutationPending.current = false;
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  async function moveBulkSelectionToTrash(): Promise<void> {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current
    ) {
      return;
    }

    bulkMutationPending.current = true;
    setBulkPendingAction("trash");
    setPendingAction("bulk-trash");
    setNotice(null);
    try {
      const hydrated = await hydrateBulkTargets(selectedIds);
      if (!hydrated) {
        return;
      }

      if (hydrated.items.length > 0) {
        let approved: boolean;
        try {
          approved = await confirm(
            `Move ${hydrated.items.length} selected ${hydrated.items.length === 1 ? "book" : "books"} to Trash? You can restore them later.`,
            {
              title: "Move selected books to Trash",
              kind: "warning",
              okLabel: "Move to Trash",
              cancelLabel: "Cancel",
            },
          );
        } catch (error) {
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
          return;
        }
        if (!approved) {
          return;
        }
      }

      let moved = 0;
      let missing = hydrated.missingIds.length;
      let failed = 0;
      const completedIds = [...hydrated.missingIds];
      for (const item of hydrated.items) {
        try {
          const result = await trashLibraryItem({ id: item.id });
          if (!result.ok) {
            failed += 1;
          } else if (!result.value.item) {
            missing += 1;
            completedIds.push(item.id);
          } else {
            moved += 1;
            completedIds.push(item.id);
          }
        } catch {
          failed += 1;
        }
      }

      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);
      setDraft((current) =>
        current && completedIds.includes(current.id) ? null : current,
      );
      setConversionDraft((current) =>
        current && completedIds.includes(current.id) ? null : current,
      );
      const [libraryLoaded, trashLoaded] = await Promise.all([
        loadLibrary(false),
        trashDialogOpen
          ? loadTrash(trashPageOffsetRef.current)
          : Promise.resolve(true),
      ]);
      const summary = `${moved} moved to Trash; ${missing} missing; ${failed} failed.${libraryLoaded ? "" : " Library refresh failed."}${trashLoaded ? "" : " Trash refresh failed."}`;
      setNotice({
        kind: failed > 0 || !libraryLoaded || !trashLoaded ? "error" : "status",
        text: summary,
      });
    } finally {
      bulkMutationPending.current = false;
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  async function saveBulkSelectionToDisk({
    fileNameTemplate,
    directoryTemplate,
  }: LibraryExportLayout): Promise<void> {
    const selectedIds = [...bulkExportItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current ||
      !bulkExportDialogOpen
    ) {
      return;
    }

    bulkMutationPending.current = true;
    setBulkExportDialogOpen(false);
    setBulkPendingAction("export");
    setPendingAction("bulk-export");
    try {
      let selection: string | string[] | null;
      try {
        selection = await open({
          directory: true,
          multiple: false,
          title: "Choose a folder for exported books",
        });
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        return;
      }
      if (typeof selection !== "string") {
        return;
      }

      setNotice(null);
      const result = await exportLibraryItems({
        ids: selectedIds,
        destinationPath: selection,
        fileNameTemplate,
        directoryTemplate,
      });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }

      const failedItemIds = new Set(
        result.value.outcomes.flatMap((outcome) =>
          outcome.status === "failed" && outcome.code !== "item-not-found"
            ? [outcome.itemId]
            : [],
        ),
      );
      const reportedItemIds = new Set(
        result.value.outcomes.map((outcome) => outcome.itemId),
      );
      const completedIds = selectedIds.filter(
        (id) => reportedItemIds.has(id) && !failedItemIds.has(id),
      );
      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);

      const collisionCount = result.value.outcomes.filter(
        (outcome) =>
          outcome.status === "skipped" && outcome.reason === "destination-exists",
      ).length;
      const missingCount = result.value.outcomes.filter(
        (outcome) => outcome.status === "failed" && outcome.code === "item-not-found",
      ).length;
      const otherFailureCount = result.value.counts.failed - missingCount;
      const summary = `${result.value.counts.exported} exported; ${collisionCount} already existed; ${missingCount} missing; ${otherFailureCount} failed.`;
      setNotice({
        kind: result.value.counts.failed > 0 ? "error" : "status",
        text: summary,
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
      bulkMutationPending.current = false;
      setBulkExportItemIds([]);
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  async function convertBulkSelectionToPdf(): Promise<void> {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current
    ) {
      return;
    }

    bulkMutationPending.current = true;
    setBulkPendingAction("convert");
    setPendingAction("bulk-convert");
    setNotice(null);
    try {
      const hydrated = await hydrateBulkTargets(selectedIds);
      if (!hydrated) {
        return;
      }

      const plan = planBulkPdfConversion(hydrated.items);
      const planned = summarizeBulkPdfConversionPlan(plan);
      const eligible = plan.flatMap((entry) =>
        entry.status === "eligible" ? [entry] : [],
      );
      const outputPaths: string[] = [];
      try {
        for (const _entry of eligible) {
          outputPaths.push(await createConversionOutputPath());
        }
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
        return;
      }

      let queued = 0;
      let failed = 0;
      const completedIds = [
        ...hydrated.missingIds,
        ...plan.flatMap((entry) => (entry.status === "skipped" ? [entry.item.id] : [])),
      ];
      for (const [index, entry] of eligible.entries()) {
        try {
          const result = await enqueueConversionJob({
            libraryItemId: entry.item.id,
            inputFormat: entry.source.format,
            outputFormat: entry.target,
            outputPath: outputPaths[index]!,
          });
          if (!result.ok) {
            failed += 1;
          } else {
            queued += 1;
            completedIds.push(entry.item.id);
          }
        } catch {
          failed += 1;
        }
      }

      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);
      const [jobsLoaded, libraryLoaded] = await Promise.all([
        loadJobs(false),
        loadLibrary(false),
      ]);
      const summary = `${queued} queued; ${planned.pdfAlreadyAttached} already had PDF; ${planned.epubSourceUnavailable} lacked EPUB; ${hydrated.missingIds.length} missing; ${failed} failed.${jobsLoaded ? "" : " Conversion list refresh failed."}${libraryLoaded ? "" : " Library refresh failed."}`;
      setNotice({
        kind: failed > 0 || !jobsLoaded || !libraryLoaded ? "error" : "status",
        text: summary,
      });
    } finally {
      bulkMutationPending.current = false;
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  async function sendBulkSelection(): Promise<void> {
    const selectedIds = [...librarySelection.selectedItemIds];
    if (
      selectedIds.length === 0 ||
      pendingAction !== null ||
      bulkMutationPending.current
    ) {
      return;
    }
    if (!selectedDestination || !preferredDeviceFormat) {
      setNotice({
        kind: "error",
        text: "Choose a reader and send format before sending selected books.",
      });
      return;
    }

    const destination = selectedDestination;
    const preferred = preferredDeviceFormat;
    bulkMutationPending.current = true;
    deviceMutationPending.current = true;
    setBulkPendingAction("send");
    setPendingAction("bulk-send");
    setNotice(null);
    try {
      const hydrated = await hydrateBulkTargets(selectedIds);
      if (!hydrated) {
        return;
      }

      const plan = planBulkDeviceSend(hydrated.items, preferred, convertIfNeeded);
      const planned = summarizeBulkDeviceSendPlan(plan);
      const sendable = plan.flatMap((entry) =>
        entry.status === "eligible" || entry.status === "convertible" ? [entry] : [],
      );
      let sent = 0;
      let converted = 0;
      let failed = 0;
      const completedIds = [
        ...hydrated.missingIds,
        ...plan.flatMap((entry) =>
          entry.status === "eligible" || entry.status === "convertible" ? [] : [entry.item.id],
        ),
      ];
      for (const entry of sendable) {
        try {
          const result = await sendLibraryItem(
            entry.item.id,
            entry.status === "eligible" ? entry.bookFormat.format : entry.target,
            destination.path,
            entry.status === "convertible",
          );
          if (!result.ok) {
            failed += 1;
          } else {
            if (result.value.converted) {
              converted += 1;
            } else {
              sent += 1;
            }
            completedIds.push(entry.item.id);
          }
        } catch {
          failed += 1;
        }
      }

      dispatchLibrarySelection({ type: "remove-items", ids: completedIds });
      restoreFocusIfBulkSelectionCleared(selectedIds, completedIds);
      const libraryLoaded = await loadLibrary(false);
      const summary = `${sent} sent; ${converted} converted and sent; ${planned.unavailable} unavailable; ${hydrated.missingIds.length} missing; ${failed} failed.${libraryLoaded ? "" : " Library refresh failed."}`;
      setNotice({ kind: failed > 0 || !libraryLoaded ? "error" : "status", text: summary });
    } finally {
      deviceMutationPending.current = false;
      bulkMutationPending.current = false;
      setBulkPendingAction(null);
      setPendingAction(null);
    }
  }

  function selectPreferredDeviceFormat(format: FormatId | null): void {
    if (!selectedDestination) {
      return;
    }

    const destinationPath = selectedDestination.path;
    setPreferredFormatsByDestinationPath((currentPreferences) =>
      setSessionDeviceFormatPreference(currentPreferences, destinationPath, format),
    );
  }

  async function openSelectedItem(): Promise<void> {
    if (bulkMutationPending.current) {
      return;
    }
    if (!selectedItem) {
      setNotice({ kind: "error", text: "Choose a library item before opening." });
      return;
    }
    await openItem(
      selectedItem,
      selectedItem.formats[0],
      `library-primary-open-${selectedItem.id}`,
    );
  }

  async function sendSelectedItem(): Promise<void> {
    if (bulkMutationPending.current) {
      return;
    }
    if (!selectedItem) {
      setNotice({ kind: "error", text: "Choose a library item before sending." });
      return;
    }
    if (!selectedDestination) {
      setNotice({ kind: "error", text: "Choose a reader before sending." });
      return;
    }
    const resolution = resolveGeneralSend(selectedItem.formats, preferredDeviceFormat);
    if (resolution.kind === "no-preference") {
      setNotice({
        kind: "error",
        text: "Choose a send format for this reader session before sending.",
      });
      return;
    }
    if (resolution.kind === "attached") {
      await sendItem(selectedItem, resolution.bookFormat);
      return;
    }

    const resolvedPreferredFormat =
      resolution.kind === "convertible" ? resolution.target : resolution.preferred;
    const preferredLabel = FORMAT_CATALOG.find(
      (definition) => definition.id === resolvedPreferredFormat,
    )!.label;
    if (resolution.kind === "convertible") {
      setDraft(null);
      setConversionDraft({
        id: selectedItem.id,
        source: resolution.source,
        target: resolution.target,
      });
      window.requestAnimationFrame(() =>
        document.getElementById(`conversion-format-${selectedItem.id}`)?.focus(),
      );
      setNotice({
        kind: "status",
        text: `Choose an output location to convert “${selectedItem.title}” to ${preferredLabel}. Sending will remain a separate action.`,
      });
      return;
    }

    setNotice({
      kind: "error",
      text: `${preferredLabel} is not attached to “${selectedItem.title}”, and no supported conversion is available.`,
    });
  }

  async function loadHealthLocation(): Promise<void> {
    setHealthLocationLoading(true);
    try {
      const result = await getLibraryHealthLocation();
      if (result.ok) {
        setHealthLocation(result.value);
      } else {
        setHealthVerificationError(describeLibraryHealthError(result.error.code));
      }
    } catch (error) {
      setHealthVerificationError(describeUnexpectedLibraryError(error));
    } finally {
      setHealthLocationLoading(false);
    }
  }

  async function verifyHealthNow(): Promise<void> {
    if (healthPendingAction) return;
    setHealthPendingAction("verify");
    setHealthVerificationError(null);
    setHealthBackupError(null);
    try {
      const result = await verifyLibraryHealth();
      if (result.ok) {
        setLastHealthVerification({ checkedAt: new Date().toISOString(), report: result.value.report });
        setNotice({ kind: "status", text: "Library integrity verified." });
      } else {
        setHealthVerificationError(describeLibraryHealthError(result.error.code));
      }
    } catch (error) {
      setHealthVerificationError(describeUnexpectedLibraryError(error));
    } finally {
      setHealthPendingAction(null);
    }
  }

  async function backUpHealthNow(): Promise<void> {
    if (healthPendingAction) return;
    setHealthBackupError(null);
    setHealthVerificationError(null);
    const parent = await open({
      title: "Choose where to create the Takio library backup",
      directory: true,
    });
    if (typeof parent !== "string") return;

    setHealthPendingAction("backup");
    try {
      const destinationPath = await joinPath(parent, backupDirectoryName());
      const result = await backUpLibrary({ destinationPath });
      if (result.ok) {
        setHealthBackupResult(result.value.backup);
        setLastHealthVerification({
          checkedAt: new Date().toISOString(),
          report: result.value.backup.report,
        });
        setNotice({ kind: "status", text: `Library backup created at ${result.value.backup.path}.` });
      } else {
        setHealthBackupError(describeLibraryHealthError(result.error.code));
      }
    } catch (error) {
      setHealthBackupError(describeUnexpectedLibraryError(error));
    } finally {
      setHealthPendingAction(null);
    }
  }

  async function exportHealthDiagnostics(): Promise<void> {
    if (healthPendingAction) return;
    setHealthDiagnosticsError(null);
    setHealthDiagnosticsResult(null);
    const parent = await open({
      title: "Choose where to create the Takio diagnostic bundle",
      directory: true,
    });
    if (typeof parent !== "string") return;

    setHealthPendingAction("diagnostics");
    try {
      const destinationPath = await joinPath(parent, diagnosticsFileName());
      const result = await exportLibraryDiagnostics({ destinationPath });
      if (result.ok) {
        setHealthDiagnosticsResult(result.value.diagnostics);
        setNotice({
          kind: "status",
          text: `Diagnostic bundle created at ${result.value.diagnostics.path}.`,
        });
      } else {
        setHealthDiagnosticsError(describeLibraryHealthError(result.error.code));
      }
    } catch (error) {
      setHealthDiagnosticsError(describeUnexpectedLibraryError(error));
    } finally {
      setHealthPendingAction(null);
    }
  }

  useEffect(() => {
    if (healthDialogOpen && !healthLocation && !healthLocationLoading) {
      void loadHealthLocation();
    }
  }, [healthDialogOpen, healthLocation, healthLocationLoading]);

  menuActionHandlers.current = {
    libraryModalOpen,
    openImport: openImportDialog,
    importPaths: importDroppedPaths,
    openSelected: openSelectedItem,
    sendSelected: sendSelectedItem,
    ejectSelected: ejectSelectedDestination,
    find: () => {
      if (!libraryModalOpen) {
        searchInput.current?.focus();
      }
    },
  };

  useEffect(() => {
    try {
      return onMenuAction((payload) => {
        const handlers = menuActionHandlers.current;
        if (handlers) {
          dispatchLibraryMenuAction(payload, handlers);
        }
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return undefined;
    }
  }, []);

  useEffect(() => {
    const showDropTarget = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer?.types.includes("Files")) {
        setDropActive(true);
      }
    };
    const hideDropTarget = (event: DragEvent) => {
      event.preventDefault();
      if (event.relatedTarget === null) {
        setDropActive(false);
      }
    };
    const importDrop = (event: DragEvent) => {
      event.preventDefault();
      setDropActive(false);
      try {
        const paths = [...(event.dataTransfer?.files ?? [])]
          .map(droppedFilePath)
          .filter((path) => path.length > 0);
        if (paths.length > 0) {
          void menuActionHandlers.current?.importPaths(paths);
        }
      } catch (error) {
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      }
    };

    window.addEventListener("dragenter", showDropTarget);
    window.addEventListener("dragover", showDropTarget);
    window.addEventListener("dragleave", hideDropTarget);
    window.addEventListener("drop", importDrop);
    return () => {
      window.removeEventListener("dragenter", showDropTarget);
      window.removeEventListener("dragover", showDropTarget);
      window.removeEventListener("dragleave", hideDropTarget);
      window.removeEventListener("drop", importDrop);
    };
  }, []);

  const activityCount =
    destinations.length + jobs.filter(({ status }) => status === "queued").length;

  return (
    <main className={`app-shell${dropActive ? " drop-active" : ""}`}>
      {dropActive && (
        <div className="drop-affordance" role="status">
          <span className="drop-affordance__icon" aria-hidden="true">+</span>
          <strong>Drop to add to your library</strong>
          <span>Takio will recognize and organize the books for you.</span>
        </div>
      )}

      <header className="app-header">
        <div className="brand" aria-label="Takio personal library">
          <span className="brand-mark" aria-hidden="true">T</span>
          <span>
            <strong>Takio</strong>
            <small>{cataloguePage?.total ?? 0} books · stored on this device</small>
          </span>
        </div>

        <div className="app-header__actions">
          <span className="drop-hint">Drop books anywhere to add them</span>
          <details className="utility-menu">
            <summary>
              <span>Devices &amp; activity</span>
              {activityCount > 0 ? (
                <span className="utility-menu__status" aria-hidden="true">
                  {activityCount}
                </span>
              ) : null}
            </summary>
            <div className="utility-menu__panel">
              <section id="library-health">
                <h2>Library</h2>
                <button
                  type="button"
                  className="secondary-button"
                  aria-haspopup="dialog"
                  aria-expanded={healthDialogOpen}
                  onClick={() => setHealthDialogOpen(true)}
                >
                  Library Health
                </button>
              </section>
              <section id="readers">
                <DeviceControls
                  actionsPending={actionsPending}
                  destinations={destinations}
                  destinationsLoading={destinationsLoading}
                  convertIfNeeded={convertIfNeeded}
                  pendingAction={pendingAction}
                  preferredFormat={preferredDeviceFormat}
                  inventoryEntries={destinationInventoryEntries}
                  inventoryLoading={destinationInventoryLoading}
                  selectedDestination={selectedDestination}
                  selectedDestinationId={selectedDestinationId}
                  onToggleConvertIfNeeded={setConvertIfNeeded}
                  onEject={ejectSelectedDestination}
                  onRefresh={refreshDestinations}
                  onReconcile={reconcileSelectedDestination}
                  onRemoveDelivery={removeTrackedDelivery}
                  onSelectDestination={(id) => {
                    destinationInventoryRequestSequence.current += 1;
                    setDestinationInventoryEntries([]);
                    setDestinationInventoryLoading(false);
                    setSelectedDestinationId(id);
                  }}
                  onSelectPreferredFormat={selectPreferredDeviceFormat}
                />
                <RootedKindlePanel
                  selectedItem={selectedItem}
                  draft={rootedKindleDraft}
                  pending={actionsPending}
                  onDraftChange={setRootedKindleDraft}
                  onNotice={(kind, text) => setNotice({ kind, text })}
                />
              </section>
              <section id="conversions">
                <JobsPanel
                  actionsPending={actionsPending}
                  items={items}
                  jobs={jobs}
                  jobsState={jobsState}
                  conversionRunning={conversionRunning}
                  pendingAction={pendingAction}
                  onCancel={cancelJob}
                  onRefresh={refreshJobs}
                  onRetry={retryJob}
                  onRunNext={runNextJob}
                />
              </section>
            </div>
          </details>
          <button
            ref={importButton}
            className="primary-button topbar-import"
            disabled={actionsPending}
            aria-haspopup="dialog"
            aria-expanded={importDialogOpen}
            onClick={openImportDialog}
          >
            {pendingAction === "import" ? "Adding…" : "Add books"}
          </button>
        </div>
      </header>

      <section className="content" id="library">
        <LibraryWorkspace
          actionsPending={actionsPending}
          bulkActions={{
            pendingAction: bulkPendingAction,
            canConvert: librarySelection.selectedItemIds.length > 0,
            canSend:
              librarySelection.selectedItemIds.length > 0 &&
              selectedDestination !== null &&
              preferredDeviceFormat !== null,
            exportDialogOpen: bulkExportDialogOpen,
            exportSelectedCount: bulkExportItemIds.length,
            tagsDialogOpen: bulkTagsDialogOpen,
            tagsDialogError: bulkTagsDialogError,
            metadataDialogOpen: bulkMetadataDialogOpen,
            metadataDialogError: bulkMetadataDialogError,
            metadataCandidateDialogOpen: bulkMetadataCandidateDialogOpen,
            metadataCandidateItemIds: bulkMetadataCandidateItemIds,
            onExport: openBulkExportDialog,
            onEditTags: openBulkTagsDialog,
            onEditMetadata: openBulkMetadataDialog,
            onReviewMetadata: openBulkMetadataCandidateDialog,
            onConvert: () => void convertBulkSelectionToPdf(),
            onSend: () => void sendBulkSelection(),
            onMoveToTrash: () => void moveBulkSelectionToTrash(),
            onClearSelection: () => {
              const selectedIds = [...librarySelection.selectedItemIds];
              dispatchLibrarySelection({ type: "clear-selection" });
              restoreFocusIfBulkSelectionCleared(selectedIds, selectedIds);
            },
            onCloseTagsDialog: closeBulkTagsDialog,
            onCloseMetadataDialog: closeBulkMetadataDialog,
            onCloseMetadataCandidateDialog: closeBulkMetadataCandidateDialog,
            onCloseExportDialog: closeBulkExportDialog,
            onConfirmExport: (template) => void saveBulkSelectionToDisk(template),
            onApplyTags: (operation, tags) => void applyBulkTags(operation, tags),
            onApplyMetadata: (patch) => void applyBulkMetadata(patch),
            onMetadataCandidateApplied: bulkMetadataCandidateApplied,
          }}
          conversionDraft={conversionDraft}
          currentSavedViewId={currentSavedViewId}
          draft={draft}
          facets={cataloguePage?.facets ?? emptyLibraryFacets}
          filters={libraryQuery.request.filters}
          items={catalogueItems}
          libraryState={libraryState}
          pageLimit={libraryQuery.request.page.limit}
          pageOffset={libraryQuery.request.page.offset}
          pendingAction={pendingAction}
          preferredDeviceFormat={preferredDeviceFormat}
          query={query}
          querySyntax={libraryQuery.request.querySyntax ?? "literal"}
          savedViews={savedViews}
          saveViewDialogBusy={pendingAction === "saved-view-save"}
          saveViewDialogError={saveViewDialogError}
          saveViewDialogOpen={saveViewDialogOpen}
          saveViewSuggestedName={
            savedViews.find(({ id }) => id === currentSavedViewId)?.name ??
            "Current library view"
          }
          searchInput={searchInput}
          searchPending={searchPending}
          selectedDestination={selectedDestination}
          selectedItemId={selectedItemId}
          selectedItemIds={librarySelection.selectedItemIds}
          sort={libraryQuery.request.sort}
          total={cataloguePage?.total ?? 0}
          onApplySavedView={applySavedView}
          onAttachFormat={attachFormat}
          onCancelSaveView={cancelSaveViewDialog}
          onChangeFilters={changeFilters}
          onChangePage={changePage}
          onChangeSearch={changeSearch}
          onChangeSearchSyntax={changeSearchSyntax}
          onChangeSort={changeSort}
          onChooseCover={chooseCover}
          onClearAll={clearLibraryQuery}
          onClearCover={clearCover}
          onEnqueueConversion={enqueueConversion}
          onOpenDuplicateReview={openDuplicateReview}
          onOpenSaveView={openSaveViewDialog}
          onOpenTrash={openTrash}
          onOpenItem={openItem}
          onMetadataCandidateApplied={metadataCandidateApplied}
          onRemoveItem={removeItem}
          onRemoveFormat={removeFormat}
          onRemoveSavedView={removeSavedView}
          onRetry={retryLibrary}
          onSaveMetadata={saveMetadata}
          onSaveView={saveCurrentView}
          onSelectItem={selectLibraryItem}
          onSelectItemRange={selectLibraryItemRange}
          onSendItem={sendItem}
          onSetConversionDraft={setConversionDraft}
          onSetDraft={setDraft}
          onTogglePageSelection={toggleLibraryPageSelection}
          onToggleSelectedItem={toggleSelectedLibraryItem}
        />

        {notice ? (
          <p
            className={`notice ${notice.kind}`}
            role={notice.kind === "error" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}

        <LibraryDuplicateReviewDialog
          open={duplicateDialogOpen}
          candidates={duplicateCandidates}
          total={duplicateTotal}
          pageOffset={duplicatePageOffset}
          pageLimit={duplicatePageLimit}
          disposition={duplicateDisposition}
          loading={duplicateLoading}
          pendingReviewToken={duplicatePendingReviewToken}
          pendingAction={duplicatePendingAction}
          staleReviewToken={duplicateStaleReviewToken}
          error={duplicateError}
          onClose={closeDuplicateReview}
          onChangePage={changeDuplicateReviewPage}
          onKeepSeparate={(request) => void keepDuplicateReviewPair(request)}
          onReopen={(request) => void reopenDuplicateReviewPair(request)}
          onMerge={(request) => void mergeDuplicateReviewPair(request)}
        />

        <LibraryTrashDialog
          open={trashDialogOpen}
          items={trashItems}
          total={trashTotal}
          pageOffset={trashPageOffset}
          pageLimit={trashPageLimit}
          loading={trashLoading}
          pendingItemId={trashPendingItemId}
          pendingAction={trashPendingAction}
          error={trashError}
          onClose={closeTrash}
          onChangePage={changeTrashPage}
          onRestore={restoreTrashItem}
          onPurge={purgeTrashItem}
        />

        <LibraryImportDialog
          open={importDialogOpen}
          selectedRootPaths={importRootPaths}
          pending={pendingAction === "import"}
          mode={importMode}
          report={importReport}
          error={importDialogError}
          onClose={closeImportDialog}
          onChooseFiles={chooseImportFiles}
          onChooseFolders={chooseImportFolders}
          onImport={() => void importPaths(importRootPaths)}
          onModeChange={setImportMode}
        />
      </section>

      <LibraryHealthDialog
        open={healthDialogOpen}
        location={healthLocation}
        loadingLocation={healthLocationLoading}
        lastVerification={lastHealthVerification}
        verificationError={healthVerificationError}
        backupResult={healthBackupResult}
        backupError={healthBackupError}
        diagnosticsResult={healthDiagnosticsResult}
        diagnosticsError={healthDiagnosticsError}
        pendingAction={healthPendingAction}
        onClose={() => setHealthDialogOpen(false)}
        onVerify={verifyHealthNow}
        onBackup={backUpHealthNow}
        onDiagnostics={exportHealthDiagnostics}
      />
    </main>
  );
}
