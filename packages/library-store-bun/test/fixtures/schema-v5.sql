PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

CREATE TABLE library_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  added_at TEXT NOT NULL,
  author TEXT,
  series TEXT,
  series_index REAL,
  publisher TEXT,
  published_date TEXT,
  rating REAL CHECK (rating >= 0 AND rating <= 10),
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

CREATE TABLE library_item_authors (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_name TEXT,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (library_item_id, position)
) STRICT;

CREATE TABLE library_item_languages (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (library_item_id, position)
) STRICT;

CREATE TABLE library_item_identifiers (
  library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (library_item_id, scheme)
) STRICT;

CREATE TABLE saved_library_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE managed_file_cleanup (
  source_path TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format', 'cover'))
) STRICT;

CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE, id);
CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE, id);
CREATE INDEX library_items_by_series
  ON library_items(series COLLATE NOCASE, series_index, id);
CREATE INDEX library_items_by_published_date ON library_items(published_date, id);
CREATE INDEX library_items_by_rating ON library_items(rating, id);
CREATE INDEX library_items_by_added_at ON library_items(added_at, id);
CREATE INDEX library_items_by_updated_at ON library_items(updated_at, id);
CREATE INDEX library_item_tags_by_tag
  ON library_item_tags(tag_normalized_name, library_item_id);
CREATE INDEX library_item_formats_by_format
  ON library_item_formats(format, library_item_id);
CREATE INDEX library_item_authors_by_name
  ON library_item_authors(name COLLATE NOCASE, library_item_id);
CREATE INDEX library_item_languages_by_language
  ON library_item_languages(language COLLATE NOCASE, library_item_id);
CREATE INDEX saved_library_views_by_name
  ON saved_library_views(name COLLATE NOCASE, id);

INSERT INTO library_items (
  id, title, added_at, author, series, series_index, publisher,
  published_date, rating, description, cover_path, updated_at
) VALUES (
  'book-v5',
  'A Wizard of Earthsea',
  '2026-07-12T08:00:00.000Z',
  'Ursula K. Le Guin',
  'Earthsea Cycle',
  1,
  'Parnassus Press',
  '1968',
  9,
  'The first Earthsea novel.',
  NULL,
  '2026-07-13T09:30:00.000Z'
);

INSERT INTO library_item_formats (
  library_item_id, format, source_path, added_at, provenance, position
) VALUES (
  'book-v5',
  'epub',
  'library/a-wizard-of-earthsea.epub',
  '2026-07-12T08:05:00.000Z',
  'referenced',
  0
);

INSERT INTO library_item_authors (library_item_id, name, sort_name, position)
VALUES ('book-v5', 'Ursula K. Le Guin', 'Le Guin, Ursula K.', 0);

INSERT INTO library_item_languages (library_item_id, language, position)
VALUES ('book-v5', 'en', 0);

INSERT INTO library_item_identifiers (library_item_id, scheme, value)
VALUES ('book-v5', 'isbn', '9780547773742');

INSERT INTO tags (normalized_name, name) VALUES ('fantasy', 'Fantasy');
INSERT INTO library_item_tags (library_item_id, tag_normalized_name, position)
VALUES ('book-v5', 'fantasy', 0);

PRAGMA user_version = 5;

COMMIT;
