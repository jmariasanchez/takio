PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE library_items (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              source_path TEXT NOT NULL,
              format TEXT NOT NULL,
              added_at TEXT NOT NULL
            ) STRICT;

INSERT INTO library_items (id, title, source_path, format, added_at) VALUES
  ('fixture-book-managed', 'Fixture Book', 'library/fixture-book/fixture-book.epub', 'epub', '2026-01-02T03:04:05.000Z');

PRAGMA user_version = 1;
COMMIT;
