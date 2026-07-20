# `@takio/library-store-bun`

Bun-only SQLite implementation of `LibraryStore`.

```ts
const store = new BunSqliteLibraryStore(databasePath);
await store.open({ config: {} });
await store.add({ item });
store.close();
```

The caller must supply the database path. `open` initializes an empty database
at schema v5, reopens v5 databases, and atomically migrates v1 through v4 after
retaining a verified backup named for the source schema:
`<database>.v1.backup`, `<database>.v2.backup`,
`<database>.v3.backup`, or `<database>.v4.backup`. Other schema versions return
`incompatible-schema`; no production database location is selected here.

Schema v4 records provenance for each stored book format. `managed` means Takio
owns the managed copy; `referenced` means the file remains owned by its caller.
All formats migrated from v1 through v3 are marked `referenced`, even when a
legacy path appears to be inside the library's managed items directory. Those
schemas recorded a location, not ownership, so treating the path as proof of
ownership could authorize deletion of a caller-owned file. Consequently,
managed-looking legacy files are intentionally not deleted automatically and
may require manual cleanup.

Schema v5 adds ordered authors and languages, identifiers, series and
publication fields, ratings, saved-library-view storage, and catalogue query
indexes. Migration does not infer rich metadata from the legacy scalar author,
so v1 through v4 records retain their exact public shape.

## Managed format lifecycle

The managed root is the `items` directory beside the database. Managed format
records store a generated file name within that root; callers receive the
resolved path. The store rejects nested, traversal, symlink, non-file, and
wrong-extension managed entries before treating them as owned files.

`import` copies the source into the managed root, records the new format as
`managed`, and leaves the source untouched. `attachFormat` makes the ownership
choice explicit: a `copy` source is copied into the managed root and recorded
as `managed`, while a `reference` source is recorded as `referenced` without
being copied. A referenced file is never deleted by format or item removal,
even if its path is inside the managed root.

`removeFormat` refuses to remove the last format. Removing another format
promotes the next stored format when necessary and updates the legacy primary
aliases. `removeFormat` schedules only the removed format when it is `managed`.
Whole-item `remove` tombstones every `managed` ebook format and the Takio-owned
cover. Referenced ebook files never enter the cleanup queue.

## Deferred cleanup

Schema v4 introduced the `managed_file_cleanup` table as a durable cleanup tombstone
for Takio-owned format and cover files. Before installing a managed copy, the
store records its generated file name; the tombstone is cleared in the
transaction that publishes the format. Before removing owned-file metadata, the
same transaction records tombstones for the affected managed formats and, on
whole-item removal, the owned cover. A committed removal therefore cannot
silently lose the cleanup obligation.

After committing a removal, the store immediately tries to delete each queued
owned file. `cleanupPending: false` means that removal required no owned-file
cleanup or that its immediate cleanup completed, including when a file was
already absent. `cleanupPending: true` means the metadata removal committed but
at least one Takio-owned file could not be deleted and its tombstone remains.
This flag describes that removal attempt; it is not a count of every tombstone
in the database. Each later `open` retries all retained tombstones and clears
each one only after deletion succeeds or the file is already absent. Before
deleting a queued format file, the store rechecks whether any current
`referenced` record uses it; if so, the tombstone is cleared without deleting
the file.

A migration backup contains database metadata, not referenced files or
Takio-owned book and cover files. The database and its sibling `items` and
`covers` directories must therefore be preserved together to recover a v5
library's owned files. To recover a migration backup, close every process using
the library, preserve the current database and both owned-file roots, copy the
matching versioned backup to a separate recovery path, and open that copy with
the current application so it can migrate again. Restoring a backup discards
database changes made after it was created and can leave newer owned files
orphaned. Legacy migration backups do not contain cleanup tombstones, while
opening a v5 database retries the format and cover tombstones that database
already records.

There is no in-place downgrade from v5. Older binaries reject a v5 database
rather than dropping rich metadata or changing ownership semantics. Downgrading
requires explicitly restoring a compatible versioned backup, with the loss of
database changes made since that backup.
