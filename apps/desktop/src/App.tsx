import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import {
  FORMAT_CATALOG,
  sanitizeDestinationFileName,
  type BookFormat,
  type Destination,
  type LibraryItem,
} from "@takio/core";

import { DeviceControls } from "./components/DeviceControls";
import { JobsPanel } from "./components/JobsPanel";
import {
  LibraryWorkspace,
  conversionControlId,
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
  listLibraryItems,
  openLibraryItem,
  parseLibraryTags,
  removeLibraryCover,
  removeLibraryFormat,
  removeLibraryItem,
  searchLibraryItems,
  setLibraryCover,
  updateLibraryItem,
} from "./lib/library";
import "./styles.css";

const supportedExtensions = FORMAT_CATALOG.flatMap((format) =>
  format.extensions.map((extension) => extension.slice(1)),
);
const coverExtensions = ["png", "jpg", "jpeg", "webp", "gif"];

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
  const [libraryState, setLibraryState] = useState<LibraryState>("loading");
  const [notice, setNotice] = useState<Notice>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchPending, setSearchPending] = useState(false);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [conversionDraft, setConversionDraft] = useState<ConversionDraft | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<readonly Destination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [jobs, setJobs] = useState<readonly ConversionJob[]>([]);
  const [jobsState, setJobsState] = useState<JobsState>("loading");
  const [selectedDestinationId, setSelectedDestinationId] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const requestSequence = useRef(0);
  const destinationRequestSequence = useRef(0);
  const jobRequestSequence = useRef(0);
  const deviceMutationPending = useRef(false);
  const formatMutationPending = useRef(false);
  const importPending = useRef(false);
  const openPending = useRef(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef(items);
  const postRemoveFocusItemId = useRef<string | null | undefined>(undefined);
  const postFormatFocusControlId = useRef<string | undefined>(undefined);
  const postConversionFocusControlId = useRef<string | undefined>(undefined);
  const queryRef = useRef(query);
  const searchInput = useRef<HTMLInputElement>(null);
  const menuActionHandlers = useRef<MenuActionHandlers | null>(null);
  itemsRef.current = items;
  queryRef.current = query;

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

  const loadLibrary = useCallback(
    async (showLoading = true, searchQuery = ""): Promise<boolean> => {
      const request = ++requestSequence.current;
      if (showLoading) {
        setLibraryState("loading");
      } else {
        setSearchPending(true);
      }

      try {
        const result =
          searchQuery === "" ? await listLibraryItems() : await searchLibraryItems(searchQuery);
        if (request !== requestSequence.current) {
          return false;
        }
        if (!result.ok) {
          setLibraryState("error");
          setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
          return false;
        }

        setItems(result.value.items);
        setSelectedItemId((currentId) =>
          currentId && result.value.items.some((item) => item.id === currentId)
            ? currentId
            : null,
        );
        setLibraryState("ready");
        return true;
      } catch (error) {
        if (request !== requestSequence.current) {
          return false;
        }
        setLibraryState("error");
        setNotice({ kind: "error", text: describeUnexpectedLibraryError(error) });
        return false;
      } finally {
        if (request === requestSequence.current) {
          setSearchPending(false);
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
    void loadDestinations();
    void loadJobs();

    // ponytail: passive polling is enough for Calibre-style reader discovery;
    // replace it with mount events only if polling becomes measurably expensive.
    const destinationRefresh = window.setInterval(() => {
      if (!deviceMutationPending.current) {
        void loadDestinations(false);
      }
    }, 10_000);

    return () => window.clearInterval(destinationRefresh);
  }, [loadDestinations, loadJobs, loadLibrary]);

  function replaceItem(updated: LibraryItem): void {
    setItems((currentItems) =>
      currentItems.map((item) => (item.id === updated.id ? updated : item)),
    );
  }

  function supersedePendingLibraryRequest(): void {
    requestSequence.current += 1;
    setSearchPending(false);
    setLibraryState("ready");
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
    setSelectedItemId((currentId) => (currentId === item.id ? null : currentId));
  }

  function changeSearch(searchQuery: string): void {
    setQuery(searchQuery);
    void loadLibrary(false, searchQuery);
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

      const refreshed = await loadLibrary(false, queryRef.current);
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

  async function saveMetadata(event: FormEvent, item: LibraryItem) {
    event.preventDefault();
    if (!draft || draft.id !== item.id) {
      return;
    }

    const title = draft.title.trim();
    if (title === "") {
      setNotice({ kind: "error", text: "Title is required." });
      return;
    }

    let tags: readonly string[];
    try {
      tags = parseLibraryTags(draft.tags);
    } catch {
      setNotice({
        kind: "error",
        text: "Use unique, nonempty tags separated by commas.",
      });
      return;
    }

    setPendingAction(`edit:${item.id}`);
    setNotice(null);
    try {
      const result = await updateLibraryItem(item.id, {
        title,
        author: draft.author.trim() || null,
        description: draft.description.trim() || null,
        tags,
      });
      if (!result.ok) {
        setNotice({ kind: "error", text: describeLibraryError(result.error.code) });
        return;
      }
      if (!result.value.item) {
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setDraft(null);
      setNotice({ kind: "status", text: `Saved “${result.value.item.title}”.` });
      if (query !== "") {
        await loadLibrary(false, query);
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
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setNotice({ kind: "status", text: `Updated the cover for “${item.title}”.` });
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
        setNotice({ kind: "error", text: "That library item no longer exists." });
        return;
      }

      replaceItem(result.value.item);
      setNotice({ kind: "status", text: `Removed the cover for “${item.title}”.` });
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
        setSelectedItemId(updated.id);
        setNotice({
          kind: "status",
          text:
            mode === "copy"
              ? `Imported a managed ${label} copy for “${updated.title}”. The selected source file remains in place.`
              : `Attached a referenced ${label} file to “${updated.title}”. The original file remains in place.`,
        });
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
        setSelectedItemId(updated.id);
        setNotice({
          kind: "status",
          text: managed
            ? result.value.cleanupPending
              ? `Removed managed ${label} from “${updated.title}”. Cleanup could not be completed and will be retried.`
              : `Deleted Takio’s managed ${label} copy and removed the format from “${updated.title}”.`
            : `Detached referenced ${label} from “${updated.title}”. The original file was not changed.`,
        });
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
      setSelectedItemId((currentId) => (currentId === item.id ? null : currentId));
      setLibraryState("ready");
      setNotice({
        kind: "status",
        text: result.value.cleanupPending
          ? `Removed “${item.title}”. Some Takio-managed files could not be deleted; cleanup is pending.`
          : `Removed “${item.title}”.`,
      });
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
    setSelectedItemId(item.id);
    setPendingAction(`open:${item.id}:${bookFormat.format}`);
    setNotice(null);
    try {
      const result = await openLibraryItem(item.id, bookFormat.format);
      if (!result.ok) {
        const errorText = describeLibraryError(result.error.code);
        if (result.error.code === "format-not-found" || result.error.code === "not-found") {
          const refreshed = await loadLibrary(false, queryRef.current);
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
        completedJob ? loadLibrary(false, queryRef.current) : Promise.resolve(true),
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
    setSelectedItemId(item.id);
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
          await loadLibrary(false, queryRef.current);
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
  const selectedDestination =
    destinations.find((destination) => destination.id === selectedDestinationId) ?? null;
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? null;

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
    await sendItem(selectedItem, selectedItem.formats[0]);
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
          selectedDestination={selectedDestination}
          selectedDestinationId={selectedDestinationId}
          onEject={ejectSelectedDestination}
          onRefresh={refreshDestinations}
          onSelectDestination={setSelectedDestinationId}
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
          draft={draft}
          items={items}
          libraryState={libraryState}
          pendingAction={pendingAction}
          query={query}
          searchInput={searchInput}
          searchPending={searchPending}
          selectedDestination={selectedDestination}
          selectedItemId={selectedItemId}
          onAttachFormat={attachFormat}
          onChangeSearch={changeSearch}
          onChooseCover={chooseCover}
          onClearCover={clearCover}
          onEnqueueConversion={enqueueConversion}
          onOpenItem={openItem}
          onRemoveItem={removeItem}
          onRemoveFormat={removeFormat}
          onRetry={() => loadLibrary(true, query)}
          onSaveMetadata={saveMetadata}
          onSelectItem={setSelectedItemId}
          onSendItem={sendItem}
          onSetConversionDraft={setConversionDraft}
          onSetDraft={setDraft}
        />
      </section>
    </main>
  );
}
