# `@takio/library-contract`

Runtime-neutral application contract for Takio library storage.

`LibraryStore` provides asynchronous CRUD, managed import, format attachment and
removal, metadata update, owned-cover, and literal search operations using the
canonical `LibraryItem` from `@takio/core`. Every operation returns a JSON-safe
`LibraryStoreResult`.

`LibraryQueryStore` adds database-backed query pages of at most 100 items with
author, tag, series, language, and format facets and deterministic table
sorting. Query text remains a literal substring rather than a structured search
grammar. `SavedLibraryViewStore` persists versioned query, filter, and sort
definitions; names are trimmed, nonblank, and limited to 120 characters, while
paging is deliberately session state rather than part of a saved view.
`LibraryFormatReplacementStore` adds atomic format replacement. These
capabilities are separate from `LibraryStore` so existing adapters remain
compatible while runtimes adopt them.

`LibraryBatchImportStore` adds recursive multi-root import without changing the
single-file `LibraryStore.import` contract. Requests contain 1–256 nonblank root
paths. Roots are visited in caller order; directory entries are traversed depth
first in raw code-unit name order. Directories do not produce outcomes. Symbolic
links are never followed, including root symlinks, and are reported as skipped.
Unsupported regular formats and other unsupported file types are also skipped;
missing or unreadable roots and entries are reported as failures without stopping
their remaining siblings.

Each encountered entry has exactly one ordered `imported`, `skipped`, `duplicate`,
or `failed` outcome. Counts must equal both those outcome groups and the complete
outcome list. A duplicate is byte-identical content already managed by Takio or
encountered earlier in the same request; overlapping roots are therefore reported
rather than silently collapsed. Each imported entry is atomic, but the batch is
not: entry failures remain in a successful report, while the outer
`LibraryStoreResult` represents request- or store-level failure.

`LibraryExportStore` adds no-clobber bulk export without widening `LibraryStore`.
Requests contain 1–256 unique, nonblank active-item ids and one nonblank
destination path. Every attached format of each found item produces an ordered
per-format `exported`, `skipped`, or `failed` outcome; a missing item instead
produces one item-level `item-not-found` failure. Exported outcomes report bytes
and SHA-256, while every per-format outcome preserves the format's managed or
referenced provenance. Existing destinations are skipped rather than overwritten,
and exact exported, skipped, failed, and total counts are part of the report.

`LibraryItemTrashStore` adds an explicit reversible lifecycle. `listTrash`
provides bounded pages of at most 100 trashed items, ordered by newest trash
transition first and then by id for deterministic ties. `trash` moves an active
item out of normal `list`, `search`, and `LibraryQueryStore.query` results,
including query totals and facets. Repeating `trash` returns the already-trashed
item. `restore` returns the item to normal results, and repeating it returns the
already-active item. Either operation succeeds with `null` when the id is
missing or was already purged. Trashing preserves the item's identity, so its id
remains occupied.

`purge` is the only irreversible trash operation. It succeeds only for a
trashed item; attempting to purge an active item fails with `not-trashed`.
Successful purge returns `{ item, cleanupPending }`, using the same managed-file
cleanup reporting as existing removals. A retry after purge succeeds with
`{ item: null, cleanupPending: false }`.

`import` creates a managed library copy. `attachFormat` requires an explicit
`copy` or `reference` source: a copy becomes `managed`, while a reference remains
caller-owned. Every format in a returned `LibraryItem` therefore has explicit
`managed` or `referenced` provenance. `removeFormat` refuses to remove an item's
last format. `replaceFormat` atomically replaces one format only when its required
`expectedCurrent` source path, timestamp, and provenance still match. Managed
copies may also require an expected byte count and SHA-256 digest. A stale or
missing current format fails with `format-changed`.

Missing records are represented without exceptions. `get`, `attachFormat`,
`update`, `setCover`, and `removeCover` succeed with `value: null`.
`removeFormat` and whole-item `remove` instead succeed with
`value: { item: null, cleanupPending: false }`. For an existing item, both
removal operations return `{ item, cleanupPending }`; `cleanupPending: true`
means metadata removal committed but at least one Takio-owned file still awaits
cleanup.

Stable error codes are `duplicate-id`, `invalid-stored-data`,
`storage-unavailable`, `incompatible-schema`, `invalid-arguments`,
`duplicate-format`, `last-format`, and `format-changed`. Consumers should branch
on these codes, not driver messages. The trash capability additionally uses
`not-trashed` when an irreversible purge targets an active item.

`LibraryStoreConfig` is intentionally empty until a runtime adapter establishes
a real cross-runtime configuration need. Database paths, schema versions,
migrations, and runtime-specific desktop setup belong to adapters rather than
this contract.
