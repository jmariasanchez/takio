# Library-defined text columns v1

## Goal

Add a bounded library-level definition layer over the existing per-book `customMetadata` string map. This slice makes custom fields recognizable as named columns without claiming Calibre's typed, computed, multi-valued, or fully configurable column system.

## Definition

```json
{
  "key": "shelf",
  "label": "Shelf",
  "type": "text",
  "position": 0
}
```

Rules:

- Maximum 64 definitions per library.
- `key` matches `^[a-z][a-z0-9_]{0,63}$`, is immutable, and cannot be `takio_metadata_audit`.
- `label` is trimmed, nonempty, and at most 120 UTF-16 code units.
- `type` is always `text` in this version.
- `position` is store-assigned, unique, contiguous, and determines list/UI order.
- Duplicate labels are allowed because the stable key is the identity. UIs show the key alongside the label.
- Existing undeclared custom metadata remains valid legacy data and is never deleted implicitly.

## Public operations

- List definitions in position order.
- Create a definition by key and label. Creation appends it.
- Rename a definition by key and label. Keys remain immutable.
- Remove a definition by key. Removal keeps all per-book values as undeclared legacy metadata.
- Existing per-book `customMetadata` keep/replace/clear behavior remains unchanged for this slice.

Stable failures use existing `invalid-arguments`, `not-found`, `storage-unavailable`, and `incompatible-schema` envelopes. Every request is validated before mutation.

## Compatibility

- Rust schema v12 adds only the definition table. Existing value rows stay in `library_item_custom_metadata`.
- v11 to v12 migration creates an empty definition table and retains every value byte-for-byte.
- Backup, rollback, strict schema verification, and frozen legacy migration coverage remain mandatory.
- Calibre import creates text definitions from safe normalized custom-column labels while importing values. A normalized-key collision keeps the first deterministic definition and the existing bounded value behavior.
- Portable library v2 carries ordered definitions. Rebuild accepts v1 with no definitions and v2 with definitions. Invalid or duplicate definitions fail before destination publication.
- The Bun reference store mirrors definition CRUD and preservation semantics, but Rust remains migration authority.

## Desktop slice

- Load definitions through a fixed Electron bridge command.
- Show defined fields by label plus `#key` in the metadata editor and inspector. Undeclared legacy fields remain under a separate custom-fields presentation.
- Add a session-only chooser for at most one visible custom table column. Selecting another replaces it. The column is non-sortable in this slice, appears before Added, and renders `Not set` for missing values.
- Do not persist the visible-column choice, add facets, add custom sorting, or add a definition manager in this first desktop slice. Definition CRUD remains available through the CLI/service public interface.

## Acceptance mapping

1. Migrate a real v11 library and prove all existing custom values and audit bytes survive.
2. Create, list, rename, reopen, and remove definitions through both packaged Rust executables with one JSON envelope and empty stderr.
3. Prove invalid/reserved/duplicate keys and oversized labels do not mutate the library.
4. Import a Calibre library with custom columns and observe definitions plus values through public commands.
5. Portable-export and rebuild v2, and rebuild a legacy v1 export. Prove definitions round-trip only in v2 and values round-trip in both.
6. Exercise the desktop editor, inspector, chooser, keyboard/focus behavior, missing values, and session-only replacement through real DOM tests and a packaged build.
7. Re-run the 10,000-book packaged performance gate and keep p95 at or below 150 ms.

## Explicit non-goals

Typed values, multi-value columns, computed columns, custom-column sorting and facets, persistent table preferences, bulk delta editing, arbitrary templates, and Calibre metadata database export remain future slices.
