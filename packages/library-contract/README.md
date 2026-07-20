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
definitions; paging is deliberately session state rather than part of a saved
view. These capabilities are separate from `LibraryStore` so existing `list`
and literal `search` adapters remain compatible while runtimes adopt them.

`import` creates a managed library copy. `attachFormat` requires an explicit
`copy` or `reference` source: a copy becomes `managed`, while a reference remains
caller-owned. Every format in a returned `LibraryItem` therefore has explicit
`managed` or `referenced` provenance. `removeFormat` refuses to remove an item's
last format.

Missing records are represented without exceptions. `get`, `attachFormat`,
`update`, `setCover`, and `removeCover` succeed with `value: null`.
`removeFormat` and whole-item `remove` instead succeed with
`value: { item: null, cleanupPending: false }`. For an existing item, both
removal operations return `{ item, cleanupPending }`; `cleanupPending: true`
means metadata removal committed but at least one Takio-owned file still awaits
cleanup.

Stable error codes are `duplicate-id`, `invalid-stored-data`,
`storage-unavailable`, `incompatible-schema`, `invalid-arguments`,
`duplicate-format`, and `last-format`. Consumers should branch on these codes,
not driver messages.

`LibraryStoreConfig` is intentionally empty until a runtime adapter establishes
a real cross-runtime configuration need. Database paths, schema versions,
migrations, and Bun or Tauri setup belong to runtime adapters rather than this
contract.
