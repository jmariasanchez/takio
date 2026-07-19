# `@takio/library-store-bun`

Bun-only SQLite implementation of `LibraryStore`.

```ts
const store = new BunSqliteLibraryStore(databasePath);
await store.open({ config: {} });
await store.add({ item });
store.close();
```

The caller must supply the database path. `open` initializes an empty database
at schema v3, reopens v3 databases, and atomically migrates v1 or v2 after
retaining a verified `<database>.v1.backup` or `<database>.v2.backup`. Other
schema versions return `incompatible-schema`; no production database location
is selected here.
