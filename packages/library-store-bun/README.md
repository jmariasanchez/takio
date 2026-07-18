# `@takio/library-store-bun`

Bun-only SQLite implementation of `LibraryStore`.

```ts
const store = new BunSqliteLibraryStore(databasePath);
await store.open({ config: {} });
await store.add({ item });
store.close();
```

The caller must supply the database path. `open` initializes an empty database with the v1 `library_items` table and safely reopens v1 databases; other schema versions return `incompatible-schema`. No production path or later migration policy is selected here.
