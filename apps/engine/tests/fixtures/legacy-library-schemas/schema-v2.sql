PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_path TEXT NOT NULL,
  format TEXT NOT NULL,
  added_at TEXT NOT NULL,
  author TEXT,
  description TEXT,
  cover_path TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE tags (
  normalized_name TEXT PRIMARY KEY,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE library_item_tags (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (library_item_id, tag_normalized_name),
  UNIQUE (library_item_id, position)
) STRICT;

INSERT INTO library_items (
  id,
  title,
  source_path,
  format,
  added_at,
  author,
  description,
  cover_path,
  updated_at
) VALUES (
  'book-v2-complete',
  'The Dispossessed',
  'library/the-dispossessed.epub',
  'epub',
  '2026-07-17T10:15:00.000Z',
  'Ursula K. Le Guin',
  'An ambiguous utopia.',
  'the-dispossessed.png',
  '2026-07-18T09:30:00.000Z'
);

INSERT INTO library_items (
  id,
  title,
  source_path,
  format,
  added_at,
  author,
  description,
  cover_path,
  updated_at
) VALUES (
  'book-v2-minimal',
  'Kindred',
  'library/kindred.mobi',
  'mobi',
  '2026-07-16T08:00:00.000Z',
  NULL,
  NULL,
  NULL,
  NULL
);

INSERT INTO tags (normalized_name, name) VALUES
  ('science fiction', 'Science Fiction'),
  ('classic', 'Classic');

INSERT INTO library_item_tags (
  library_item_id,
  tag_normalized_name,
  position
) VALUES
  ('book-v2-complete', 'science fiction', 0),
  ('book-v2-complete', 'classic', 1);

PRAGMA user_version = 2;

COMMIT;
