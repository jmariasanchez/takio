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
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (library_item_id, format),
  UNIQUE (library_item_id, position)
) STRICT;

INSERT INTO library_items (
  id,
  title,
  added_at,
  author,
  description,
  cover_path,
  updated_at
) VALUES (
  'book-v3-singleton',
  'A Wizard of Earthsea',
  '2026-07-14T08:00:00.000Z',
  'Ursula K. Le Guin',
  NULL,
  NULL,
  NULL
);

INSERT INTO library_items (
  id,
  title,
  added_at,
  author,
  description,
  cover_path,
  updated_at
) VALUES (
  'book-v3-multi',
  'The Fifth Season',
  '2026-07-15T09:30:00.000Z',
  'N. K. Jemisin',
  'The first Broken Earth novel.',
  'the-fifth-season.png',
  '2026-07-18T17:45:00.000Z'
);

INSERT INTO library_item_formats (
  library_item_id,
  format,
  source_path,
  added_at,
  position
) VALUES
  (
    'book-v3-singleton',
    'epub',
    '__LIBRARY_ROOT__/items/book-v3-singleton.epub',
    '2026-07-14T08:05:00.000Z',
    0
  ),
  (
    'book-v3-multi',
    'epub',
    '__EXTERNAL_ROOT__/the-fifth-season.epub',
    '2026-07-15T09:35:00.000Z',
    0
  ),
  (
    'book-v3-multi',
    'pdf',
    '__LIBRARY_ROOT__/items/book-v3-multi.pdf',
    '2026-07-16T11:20:00.000Z',
    1
  );

INSERT INTO tags (normalized_name, name) VALUES
  ('fantasy', 'Fantasy'),
  ('hugo winner', 'Hugo Winner');

INSERT INTO library_item_tags (
  library_item_id,
  tag_normalized_name,
  position
) VALUES
  ('book-v3-singleton', 'fantasy', 0),
  ('book-v3-multi', 'fantasy', 0),
  ('book-v3-multi', 'hugo winner', 1);

PRAGMA user_version = 3;

COMMIT;
