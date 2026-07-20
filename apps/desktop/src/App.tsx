import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  FORMAT_CATALOG,
  sanitizeDestinationFileName,
  type BookFormat,
  type Destination,
  type FormatId,
  type LibraryItem,
} from "@takio/core";
import type {
  LibraryFacetCounts,
  LibraryMetadataPatch,
  LibraryQueryFilters,
  LibraryQuerySort,
  SavedLibraryView,
} from "@takio/library-contract";

import {
  DeviceControls,
  retainConnectedDeviceFormatPreferences,
  setSessionDeviceFormatPreference,
  type SessionDeviceFormatPreferences,
} from "./components/DeviceControls";
import { JobsPanel } from "./components/JobsPanel";
import {
  LibraryWorkspace,
  conversionControlId,
  resolveGeneralSend,
  type ConversionDraft,
  type LibraryState,
  type MetadataDraft,
} from "./components/LibraryWorkspace";
import {
  describeDestinationError,
  describeUnexpectedDestinationError,
  ejectDestination,
  listDestinations,
  sendLibraryItem,
} from "./lib/destinations";
import {
  cancelConversionJob,
  describeJobError,
  describeUnexpectedJobError,
  enqueueConversionJob,
  listConversionJobs,
  runNextConversionJob,
  type ConversionJob,
} from "./lib/jobs";
import {
  attachLibraryFormat,
  describeLibraryError,
  describeUnexpectedLibraryError,
  importLibraryItem,
  listSavedLibraryViews,
  openLibraryItem,
  queryLibraryItems,
  removeLibraryCover,
  removeLibraryFormat,
  removeLibraryItem,
  removeSavedLibraryView,
  saveSavedLibraryView,
  setLibraryCover,
  updateLibraryItem,
} from "./lib/library";
import {
  applyLibraryQueryResponse,
  createLibraryQueryState,
  DEFAULT_LIBRARY_QUERY_REQUEST,
  issueLibraryQueryRequest,
  libraryQueryStateReducer,
  type LibraryQueryState,
  type LibraryQueryStateAction,
} from "./lib/library-query-state";
import "./styles.css";

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

type JobsState = "loading" | "ready" | "error";
type Notice = { readonly kind: "status" | "error"; readonly text: string } | null;
type MenuActionHandlers = {
  readonly importFiles: () => Promise<void>;
  readonly importPaths: (paths: readonly string[]) => Promise<void>;
  readonly openSelected: () => Promise<void>;
  readonly sendSelected: () => Promise<void>;
  readonly ejectSelected: () => Promise<void>;
  readonly find: () => void;
};

export default function App() {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [libraryQuery, setLibraryQuery] = useState<LibraryQueryState>(() =>
    createLibraryQueryState(),
  );
  const [savedViews, setSavedViews] = useState<readonly SavedLibraryView[]>([]);
  const [currentSavedViewId, setCurrentSavedViewId] = useState<string | null>(null);
  const [saveViewDialogOpen, setSaveViewDialogOpen] = useState(false);
  const [saveViewDialogError, setSaveViewDialogError] = useState<string | null>(null);
  const [libraryState, setLibraryState] = useState<LibraryState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [conversionDraft, setConversionDraft] = useState<ConversionDraft | null>(null);
  const [destinations, setDestinations] = useState<readonly Destination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [jobs, setJobs] = useState<readonly ConversionJob[]>([]);
  const [jobsState, setJobsState] = useState<JobsState>("loading");
  const [selectedDestinationId, setSelectedDestinationId] = useState<string | null>(null);
  const [preferredFormatsByDestinationPath, setPreferredFormatsByDestinationPath] =
    useState<SessionDeviceFormatPreferences>({});
  const [dropActive, setDropActive] = useState(false);
  const savedViewsRequestSequence = useRef(0);
  const destinationRequestSequence = useRef(0);
  const jobRequestSequence = useRef(0);
  const deviceMutationPending = useRef(false);
  const formatMutationPending = useRef(false);
  const importPending = useRef(false);
  const openPending = useRef(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef(items);
  const libraryQueryRef = useRef(libraryQuery);
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

  const commitLibraryQuery = useCallback((next: LibraryQueryState): void => {
    libraryQueryRef.current = next;
    setLibraryQuery(next);
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

  const loadSavedViews = useCallback(async (): Promise<boolean> => {
    const request = ++savedViewsRequestSequence.current;
    try {
      const result = await listSavedLibraryViews();
      if (request !== savedViewsRequestSequence.current) {
        return false;
      }
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return false;
      }

      setSavedViews(result.value.views);
      setCurrentSavedViewId((currentId) =>
        currentId && result.value.views.some(({ id }) => id === currentId)
          ? currentId
          : null,
      );
      return true;
    } catch (error) {
      if (request !== savedViewsRequestSequence.current) {
        return false;
      }
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return false;
    }
  }, []);

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
        currentId &&
        result.value.destinations.some((destination) => destination.id === currentId)
          ? currentId
          : null,
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
    void loadLibrary();
    void loadSavedViews();
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
      window.clearInterval(destinationRefresh);
      if (searchDebounce.current !== null) {
        window.clearTimeout(searchDebounce.current);
      }
    };
  }, [loadDestinations, loadJobs, loadLibrary, loadSavedViews]);

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
    reduceLibraryQuery({ type: "set-query", query: searchQuery });
    setCurrentSavedViewId(null);
    setSearchPending(true);
    if (searchDebounce.current !== null) {
      window.clearTimeout(searchDebounce.current);
    }
    searchDebounce.current = window.setTimeout(() => {
      searchDebounce.current = null;
      void loadLibrary(false);
    }, searchDebounceMilliseconds);
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
    setCurrentSavedViewId(null);
    runImmediateLibraryQuery({ type: "set-filters", filters });
  }

  function changeSort(sort: LibraryQuerySort): void {
    setCurrentSavedViewId(null);
    runImmediateLibraryQuery({ type: "set-sort", sort });
  }

  function changePage(offset: number): void {
    runImmediateLibraryQuery({
      type: "set-page",
      page: { ...libraryQueryRef.current.request.page, offset },
    });
  }

  function clearLibraryQuery(): void {
    setCurrentSavedViewId(null);
    runImmediateLibraryQuery({
      type: "apply-saved-view",
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
      setNotice({ kind: "error", text: "That saved view is no longer available." });
      void loadSavedViews();
      return;
    }

    setCurrentSavedViewId(view.id);
    runImmediateLibraryQuery({ type: "apply-saved-view", definition: view.definition });
  }

  function openSaveViewDialog(): void {
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
        setSaveViewDialogError("The saved view could not be returned by the library.");
        return;
      }

      const savedView = result.value.view;
      setSavedViews((current) => [...current.filter(({ id }) => id !== savedView.id), savedView]);
      setCurrentSavedViewId(savedView.id);
      setSaveViewDialogOpen(false);
      setNotice({ kind: "status", text: `Saved view “${savedView.name}”.` });
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
        setCurrentSavedViewId(null);
      }
      setNotice({
        kind: "status",
        text: view ? `Removed saved view “${view.name}”.` : "Removed the saved view.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
    } finally {
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

  const importPaths = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0 || importPending.current) {
        return;
      }

      importPending.current = true;
      setPendingAction("import");
      setNotice(null);

      let imported = 0;
      const rejected: string[] = [];
      for (const path of paths) {
        try {
          const result = await importLibraryItem(path);
          if (result.ok) {
            imported += 1;
          } else {
            rejected.push(`${path}: ${describeLibraryError(result.error.code)}`);
          }
        } catch (error) {
          rejected.push(`${path}: ${describeUnexpectedLibraryError(error)}`);
        }
      }

      const refreshed = await loadLibrary(false);
      const summary = `${imported} ${imported === 1 ? "item" : "items"} imported; ${rejected.length} rejected.`;
      const details = rejected.map((error) => `• ${error}`);
      if (!refreshed) {
        details.push("• The library could not be refreshed.");
      }
      setNotice({
        kind: rejected.length > 0 || !refreshed ? "error" : "status",
        text: [summary, ...details].join("\n"),
      });
      importPending.current = false;
      setPendingAction(null);
    },
    [loadLibrary],
  );

  async function importFile(): Promise<void> {
    let selection: string | string[] | null;
    try {
      selection = await open({
        multiple: true,
        filters: [{ name: "Supported books and documents", extensions: supportedExtensions }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
      return;
    }

    if (selection === null) {
      return;
    }

    await importPaths(typeof selection === "string" ? [selection] : selection);
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
        `Remove “${item.title}” from your Takio library? Takio will remove managed copies. External files will not be deleted.`,
        {
          title: "Remove from library",
          kind: "warning",
          okLabel: "Remove from library",
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
      const result = await removeLibraryItem(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
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
        selectLibraryItem(null);
      }
      setLibraryState("ready");
      if (await loadLibrary(false)) {
        setNotice({
          kind: "status",
          text: result.value.cleanupPending
            ? `Removed “${item.title}”. Some Takio-managed files could not be deleted; cleanup is pending.`
            : `Removed “${item.title}”.`,
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
    if (openPending.current) {
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
    if (await loadDestinations()) {
      setNotice({ kind: "status", text: "Reader list refreshed." });
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

    let output: string | null;
    try {
      output = await save({
        title: `Convert “${item.title}” to PDF`,
        defaultPath: sanitizeDestinationFileName(`${item.title}.pdf`) ?? "converted.pdf",
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
      });
    } catch (error) {
      setNotice({ kind: "error", text: describeUnexpectedJobError(error) });
      return;
    }
    if (output === null) {
      return;
    }

    setPendingAction(`job-enqueue:${item.id}`);
    setNotice(null);
    try {
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

  async function runNextJob(): Promise<void> {
    setPendingAction("job-run-next");
    setNotice(null);
    try {
      const result = await runNextConversionJob();
      if (!result.ok) {
        setNotice({ kind: "error", text: describeJobError(result.error.code) });
        return;
      }

      const completedJob = result.value.job?.status === "completed" ? result.value.job : null;
      const [jobsLoaded, libraryLoaded] = await Promise.all([
        loadJobs(false),
        completedJob ? loadLibrary(false) : Promise.resolve(true),
      ]);
      if (!jobsLoaded || !libraryLoaded) {
        return;
      }
      if (result.value.job === null) {
        setNotice({ kind: "status", text: "No queued conversions." });
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
    if (deviceMutationPending.current) {
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
    if (deviceMutationPending.current) {
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
  const selectedDestination =
    destinations.find((destination) => destination.id === selectedDestinationId) ?? null;
  const preferredDeviceFormat = selectedDestination
    ? (preferredFormatsByDestinationPath[selectedDestination.path] ?? null)
    : null;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

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

  menuActionHandlers.current = {
    importFiles: importFile,
    importPaths,
    openSelected: openSelectedItem,
    sendSelected: sendSelectedItem,
    ejectSelected: ejectSelectedDestination,
    find: () => searchInput.current?.focus(),
  };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<string>(
      "takio://menu-action",
      ({ payload }) => {
        const handlers = menuActionHandlers.current;
        if (!handlers) {
          return;
        }

        switch (payload) {
          case "import":
            void handlers.importFiles();
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
      },
      { target: { kind: "WebviewWindow", label: "main" } },
    )
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void getCurrentWindow()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") {
          setDropActive(true);
          return;
        }

        setDropActive(false);
        if (payload.type === "drop") {
          void menuActionHandlers.current?.importPaths(payload.paths);
        }
      })
      .then((stopListening) => {
        if (disposed) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <main className={`app-shell${dropActive ? " drop-active" : ""}`}>
      {dropActive && (
        <div className="drop-affordance" role="status">
          Drop files to import
        </div>
      )}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <span>takio</span>
        </div>
        <nav aria-label="Main navigation">
          <span className="nav-item active"><span aria-hidden="true">⌘</span>Library</span>
        </nav>
        <div className="sidebar-footer">Stored locally on this device</div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">LIBRARY</p>
            <h1>Your local library.</h1>
          </div>
        </header>

        <section className="hero-card" aria-labelledby="import-heading">
          <div>
            <p className="eyebrow">IMPORT</p>
            <h2 id="import-heading">Add a book or document</h2>
            <p>Add a supported file to your local Takio library.</p>
          </div>
          <button
            ref={importButton}
            className="primary-button"
            disabled={actionsPending}
            onClick={importFile}
          >
            {pendingAction === "import" ? "Importing…" : "Choose file"}
          </button>
        </section>

        <DeviceControls
          actionsPending={actionsPending}
          destinations={destinations}
          destinationsLoading={destinationsLoading}
          pendingAction={pendingAction}
          preferredFormat={preferredDeviceFormat}
          selectedDestination={selectedDestination}
          selectedDestinationId={selectedDestinationId}
          onEject={ejectSelectedDestination}
          onRefresh={refreshDestinations}
          onSelectDestination={setSelectedDestinationId}
          onSelectPreferredFormat={selectPreferredDeviceFormat}
        />

        <JobsPanel
          actionsPending={actionsPending}
          items={items}
          jobs={jobs}
          jobsState={jobsState}
          pendingAction={pendingAction}
          onCancel={cancelJob}
          onRefresh={refreshJobs}
          onRunNext={runNextJob}
        />

        {notice ? (
          <p className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
            {notice.text}
          </p>
        ) : <div className="notice" aria-hidden="true" />}

        <LibraryWorkspace
          actionsPending={actionsPending}
          conversionDraft={conversionDraft}
          currentSavedViewId={currentSavedViewId}
          draft={draft}
          facets={cataloguePage?.facets ?? emptyLibraryFacets}
          filters={libraryQuery.request.filters}
          items={items}
          libraryState={libraryState}
          pageLimit={libraryQuery.request.page.limit}
          pageOffset={libraryQuery.request.page.offset}
          pendingAction={pendingAction}
          preferredDeviceFormat={preferredDeviceFormat}
          query={query}
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
          sort={libraryQuery.request.sort}
          total={cataloguePage?.total ?? 0}
          onApplySavedView={applySavedView}
          onAttachFormat={attachFormat}
          onCancelSaveView={cancelSaveViewDialog}
          onChangeFilters={changeFilters}
          onChangePage={changePage}
          onChangeSearch={changeSearch}
          onChangeSort={changeSort}
          onChooseCover={chooseCover}
          onClearAll={clearLibraryQuery}
          onClearCover={clearCover}
          onEnqueueConversion={enqueueConversion}
          onOpenSaveView={openSaveViewDialog}
          onOpenItem={openItem}
          onRemoveItem={removeItem}
          onRemoveFormat={removeFormat}
          onRemoveSavedView={removeSavedView}
          onRetry={retryLibrary}
          onSaveMetadata={saveMetadata}
          onSaveView={saveCurrentView}
          onSelectItem={selectLibraryItem}
          onSendItem={sendItem}
          onSetConversionDraft={setConversionDraft}
          onSetDraft={setDraft}
        />
      </section>
    </main>
  );
}
