PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
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

CREATE TABLE library_item_formats (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  source_path TEXT NOT NULL,
  added_at TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('managed', 'referenced')),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (library_item_id, format),
  UNIQUE (library_item_id, position)
) STRICT;

CREATE TABLE managed_file_cleanup (
  source_path TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format', 'cover'))
) STRICT;

INSERT INTO library_items (
  id,
  title,
  added_at,
  author,
  description,
  cover_path,
  updated_at
) VALUES
  (
    'book-v4-complete',
    'Parable of the Sower',
    '2026-07-12T08:00:00.000Z',
    'Octavia E. Butler',
    'The first Earthseed novel.',
    NULL,
    '2026-07-13T09:30:00.000Z'
  ),
  (
    'book-v4-minimal',
    'Kindred',
    '2026-07-11T07:00:00.000Z',
    NULL,
    NULL,
    NULL,
    NULL
  );

INSERT INTO library_item_formats (
  library_item_id,
  format,
  source_path,
  added_at,
  provenance,
  position
) VALUES
  (
    'book-v4-complete',
    'epub',
    'library/parable-of-the-sower.epub',
    '2026-07-12T08:05:00.000Z',
    'referenced',
    0
  ),
  (
    'book-v4-complete',
    'pdf',
    'library/parable-of-the-sower.pdf',
    '2026-07-12T08:10:00.000Z',
    'referenced',
    1
  ),
  (
    'book-v4-minimal',
    'mobi',
    'library/kindred.mobi',
    '2026-07-11T07:05:00.000Z',
    'referenced',
    0
  );

INSERT INTO tags (normalized_name, name) VALUES
  ('classic', 'Classic'),
  ('science fiction', 'Science Fiction');

INSERT INTO library_item_tags (
  library_item_id,
  tag_normalized_name,
  position
) VALUES
  ('book-v4-complete', 'science fiction', 0),
  ('book-v4-complete', 'classic', 1);

PRAGMA user_version = 4;

COMMIT;
