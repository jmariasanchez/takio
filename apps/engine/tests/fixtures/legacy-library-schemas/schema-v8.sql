PRAGMA foreign_keys = ON;
BEGIN;

CREATE TABLE duplicate_pair_reviews (
      left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      review_token TEXT NOT NULL CHECK (
        length(review_token) = 64 AND review_token NOT GLOB '*[^0-9a-f]*'
      ),
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (left_id, right_id)
    ) STRICT;

CREATE TABLE library_item_authors (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_name TEXT,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (library_item_id, position)
    ) STRICT;

CREATE TABLE library_item_formats (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      format TEXT NOT NULL,
      source_path TEXT NOT NULL,
      added_at TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('managed', 'referenced')),
      position INTEGER NOT NULL CHECK (position >= 0),
      content_bytes INTEGER,
      content_sha256 TEXT,
      CHECK (
        (provenance = 'managed'
          AND content_bytes IS NOT NULL
          AND content_bytes >= 0
          AND content_sha256 IS NOT NULL
          AND length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^0-9a-f]*')
        OR
        (provenance = 'referenced' AND content_bytes IS NULL AND content_sha256 IS NULL)
      ),
      PRIMARY KEY (library_item_id, format),
      UNIQUE (library_item_id, position)
    ) STRICT;

CREATE TABLE library_item_identifiers (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      scheme TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (library_item_id, scheme)
    ) STRICT;

CREATE TABLE library_item_languages (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (library_item_id, position)
    ) STRICT;

CREATE TABLE library_item_tags (
      library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
      tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (library_item_id, tag_normalized_name),
      UNIQUE (library_item_id, position)
    ) STRICT;

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
              updated_at TEXT,
              trashed_at TEXT
            ) STRICT;

CREATE TABLE managed_file_cleanup (
      source_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'format' CHECK (kind IN ('format', 'cover'))
    ) STRICT;

CREATE TABLE saved_library_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE tags (
      normalized_name TEXT PRIMARY KEY,
      name TEXT NOT NULL
    ) STRICT;

CREATE INDEX library_item_authors_by_name
      ON library_item_authors(name COLLATE NOCASE, library_item_id);

CREATE INDEX library_item_formats_by_fingerprint
    ON library_item_formats(content_bytes, content_sha256, library_item_id, position)
    WHERE provenance = 'managed';

CREATE INDEX library_item_formats_by_format
      ON library_item_formats(format, library_item_id);

CREATE INDEX library_item_languages_by_language
      ON library_item_languages(language COLLATE NOCASE, library_item_id);

CREATE INDEX library_item_tags_by_tag
      ON library_item_tags(tag_normalized_name, library_item_id);

CREATE INDEX library_items_by_added_at ON library_items(added_at, id);

CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE, id);

CREATE INDEX library_items_by_published_date ON library_items(published_date, id);

CREATE INDEX library_items_by_rating ON library_items(rating, id);

CREATE INDEX library_items_by_series
      ON library_items(series COLLATE NOCASE, series_index, id);

CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE, id);

CREATE INDEX library_items_by_trashed_at
    ON library_items(trashed_at DESC, id ASC)
    WHERE trashed_at IS NOT NULL;

CREATE INDEX library_items_by_updated_at ON library_items(updated_at, id);

CREATE INDEX saved_library_views_by_name
      ON saved_library_views(name COLLATE NOCASE, id);

INSERT INTO library_items (id, title, added_at, author, series, series_index, publisher, published_date, rating, description, cover_path, updated_at, trashed_at) VALUES
  ('fixture-book-managed', 'Fixture Book', '2026-01-02T03:04:05.000Z', 'Ada Example', 'Fixture Series', 1.0, 'Fixture Press', '2025-12-01', 8.5, 'Deterministic managed fixture book.', 'library/fixture-book/cover.jpg', '2026-01-03T04:05:06.000Z', NULL),
  ('fixture-book-trashed', 'Fixture Book Duplicate', '2026-01-02T03:04:06.000Z', 'Ada Example', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-01-03T04:05:07.000Z', '2026-01-04T05:06:07.000Z');
INSERT INTO library_item_formats (library_item_id, format, source_path, added_at, provenance, position, content_bytes, content_sha256) VALUES
  ('fixture-book-managed', 'epub', 'library/fixture-book/fixture-book.epub', '2026-01-02T03:04:05.000Z', 'managed', 0, 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('fixture-book-managed', 'pdf', '/fixtures/source/fixture-book.pdf', '2026-01-02T03:05:05.000Z', 'referenced', 1, NULL, NULL),
  ('fixture-book-trashed', 'epub', 'library/fixture-book-duplicate/fixture-book-duplicate.epub', '2026-01-02T03:04:06.000Z', 'managed', 0, 1234, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
INSERT INTO library_item_authors VALUES ('fixture-book-managed', 'Ada Example', 'Example, Ada', 0);
INSERT INTO library_item_identifiers VALUES ('fixture-book-managed', 'isbn', '9780000000002');
INSERT INTO library_item_languages VALUES ('fixture-book-managed', 'en', 0);
INSERT INTO tags VALUES ('rust', 'Rust');
INSERT INTO library_item_tags VALUES ('fixture-book-managed', 'rust', 0);
INSERT INTO saved_library_views VALUES ('fixture-view', 'Fixture View', '{"tags":["rust"]}', '2026-01-02T03:04:05.000Z', '2026-01-03T04:05:06.000Z');
INSERT INTO managed_file_cleanup VALUES ('library/orphan.epub', 'format');
INSERT INTO duplicate_pair_reviews VALUES ('fixture-book-managed', 'fixture-book-trashed', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-01-05T06:07:08.000Z');

PRAGMA user_version = 8;
COMMIT;
