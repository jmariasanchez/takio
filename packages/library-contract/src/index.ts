import type { FormatId, LibraryItem } from "@takio/core";

export const LIBRARY_STORE_ERROR_CODES = [
  "duplicate-id",
  "invalid-stored-data",
  "storage-unavailable",
  "incompatible-schema",
  "invalid-arguments",
  "duplicate-format",
  "last-format",
] as const;

export type LibraryStoreErrorCode = (typeof LIBRARY_STORE_ERROR_CODES)[number];

export interface LibraryStoreError {
  readonly code: LibraryStoreErrorCode;
}

export type LibraryStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LibraryStoreError };

export type LibraryStoreConfig = Readonly<Record<string, never>>;
export type OpenLibraryRequest = Readonly<{ config: LibraryStoreConfig }>;
export type ListLibraryItemsRequest = Readonly<Record<string, never>>;
export type GetLibraryItemRequest = Readonly<{ id: string }>;
export type AddLibraryItemRequest = Readonly<{ item: LibraryItem }>;
export type ImportLibraryItemRequest = Readonly<{ sourcePath: string; title?: string }>;
export type AttachLibraryFormatRequest = Readonly<{
  id: string;
  source:
    | Readonly<{ kind: "copy"; path: string }>
    | Readonly<{ kind: "reference"; path: string }>;
}>;
export type RemoveLibraryFormatRequest = Readonly<{ id: string; format: FormatId }>;
export type RemoveLibraryItemRequest = Readonly<{ id: string }>;
export type LibraryMetadataPatch = Readonly<{
  title?: string;
  author?: string | null;
  description?: string | null;
  tags: readonly string[];
}>;
export type UpdateLibraryItemRequest = Readonly<{
  id: string;
  patch: LibraryMetadataPatch;
}>;
export type SetLibraryCoverRequest = Readonly<{ id: string; sourcePath: string }>;
export type RemoveLibraryCoverRequest = Readonly<{ id: string }>;
export type SearchLibraryItemsRequest = Readonly<{ query: string }>;

export type OpenLibraryResult = LibraryStoreResult<null>;
export type ListLibraryItemsResult = LibraryStoreResult<readonly LibraryItem[]>;
export type GetLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type AddLibraryItemResult = LibraryStoreResult<LibraryItem>;
export type ImportLibraryItemResult = LibraryStoreResult<LibraryItem>;
export type AttachLibraryFormatResult = LibraryStoreResult<LibraryItem | null>;
export type RemoveLibraryFormatResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type RemoveLibraryItemResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type UpdateLibraryItemResult = LibraryStoreResult<LibraryItem | null>;
export type SetLibraryCoverResult = LibraryStoreResult<LibraryItem | null>;
export type RemoveLibraryCoverResult = LibraryStoreResult<LibraryItem | null>;
export type SearchLibraryItemsResult = LibraryStoreResult<readonly LibraryItem[]>;

export type LibraryListWireResult = LibraryStoreResult<{
  readonly items: readonly LibraryItem[];
}>;
export type LibraryImportWireResult = LibraryStoreResult<{ readonly item: LibraryItem }>;
export type LibraryRemoveWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
  readonly cleanupPending: boolean;
}>;
export type LibraryUpdateWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibraryCoverWireResult = LibraryStoreResult<{
  readonly item: LibraryItem | null;
}>;
export type LibrarySearchWireResult = LibraryStoreResult<{
  readonly items: readonly LibraryItem[];
}>;

export interface LibraryStore {
  open(request: OpenLibraryRequest): Promise<OpenLibraryResult>;
  list(request: ListLibraryItemsRequest): Promise<ListLibraryItemsResult>;
  get(request: GetLibraryItemRequest): Promise<GetLibraryItemResult>;
  add(request: AddLibraryItemRequest): Promise<AddLibraryItemResult>;
  import(request: ImportLibraryItemRequest): Promise<ImportLibraryItemResult>;
  attachFormat(request: AttachLibraryFormatRequest): Promise<AttachLibraryFormatResult>;
  removeFormat(request: RemoveLibraryFormatRequest): Promise<RemoveLibraryFormatResult>;
  update(request: UpdateLibraryItemRequest): Promise<UpdateLibraryItemResult>;
  setCover(request: SetLibraryCoverRequest): Promise<SetLibraryCoverResult>;
  removeCover(request: RemoveLibraryCoverRequest): Promise<RemoveLibraryCoverResult>;
  search(request: SearchLibraryItemsRequest): Promise<SearchLibraryItemsResult>;
  remove(request: RemoveLibraryItemRequest): Promise<RemoveLibraryItemResult>;
}
