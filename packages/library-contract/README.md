# `@takio/library-contract`

Runtime-neutral application contract for Takio library storage.

`LibraryStore` provides asynchronous `open`, `list`, `get`, `add`, and `remove` operations using the canonical `LibraryItem` from `@takio/core`. Every operation returns a JSON-safe `LibraryStoreResult`; missing `get` and `remove` records are successful results with `value: null`.

Stable error codes are `duplicate-id`, `invalid-stored-data`, `storage-unavailable`, and `incompatible-schema`. Consumers should branch on these codes, not driver messages.

`LibraryStoreConfig` is intentionally empty until a runtime adapter establishes a real cross-runtime configuration need. Database paths, schema versions, migrations, and Bun or Tauri setup belong to later adapter packages.
