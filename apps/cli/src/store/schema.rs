//! Current catalogue schema creation and nonempty-database detection.
//! Historical upgrades and compatibility checks remain in migration.
use crate::error::AppResult;
use rusqlite::Connection;

pub(super) fn create_schema(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE library_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, added_at TEXT NOT NULL,
           author TEXT, series TEXT, series_index REAL, publisher TEXT, published_date TEXT,
           rating REAL CHECK (rating >= 0 AND rating <= 10), description TEXT, cover_path TEXT,
           updated_at TEXT, trashed_at TEXT) STRICT;
         CREATE TABLE tags (normalized_name TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
         CREATE TABLE library_item_tags (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           tag_normalized_name TEXT NOT NULL REFERENCES tags(normalized_name) ON DELETE CASCADE,
           position INTEGER NOT NULL, PRIMARY KEY(library_item_id,tag_normalized_name), UNIQUE(library_item_id,position)) STRICT;
         CREATE TABLE library_item_formats (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           format TEXT NOT NULL, source_path TEXT NOT NULL, added_at TEXT NOT NULL,
           provenance TEXT NOT NULL CHECK(provenance IN ('managed','referenced')), position INTEGER NOT NULL CHECK(position>=0),
           content_bytes INTEGER, content_sha256 TEXT,
           CHECK((provenance='managed' AND content_bytes IS NOT NULL AND content_bytes>=0 AND content_sha256 IS NOT NULL
             AND length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*') OR
             (provenance='referenced' AND content_bytes IS NULL AND content_sha256 IS NULL)),
           PRIMARY KEY(library_item_id,format), UNIQUE(library_item_id,position)) STRICT;
         CREATE TABLE library_item_authors (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           name TEXT NOT NULL, sort_name TEXT, position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(library_item_id,position)) STRICT;
         CREATE TABLE library_item_languages (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           language TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(library_item_id,position)) STRICT;
         CREATE TABLE library_item_identifiers (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           scheme TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,scheme)) STRICT;
         CREATE TABLE library_item_custom_metadata (library_item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(library_item_id,name)) STRICT;
         CREATE TABLE library_custom_column_definitions (
           key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
           label TEXT NOT NULL CHECK(length(label)>0),
           type TEXT NOT NULL CHECK(type='text'),
           position INTEGER NOT NULL UNIQUE CHECK(position>=0)) STRICT;
         CREATE TABLE saved_library_views (id TEXT PRIMARY KEY, name TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
         CREATE TABLE duplicate_pair_reviews (left_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           right_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
           review_token TEXT NOT NULL CHECK(length(review_token)=64 AND review_token NOT GLOB '*[^0-9a-f]*'),
           reviewed_at TEXT NOT NULL CHECK(length(reviewed_at)>0), PRIMARY KEY(left_id,right_id), CHECK(left_id<right_id)) STRICT;
         CREATE TABLE library_adoptions (id TEXT PRIMARY KEY CHECK(length(id)>0),
           library_item_id TEXT NOT NULL UNIQUE CHECK(length(library_item_id)>0), title TEXT NOT NULL CHECK(length(title)>0),
           source_path TEXT NOT NULL CHECK(length(source_path)>0), target_path TEXT NOT NULL UNIQUE CHECK(length(target_path)>0),
           format TEXT NOT NULL CHECK(format IN ('kepub','epub','pdf','mobi','azw3','docx','html','txt','cbz')),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
           state TEXT NOT NULL CHECK(state IN ('pending-rename','renamed','finalizing')),
           created_at TEXT NOT NULL CHECK(length(created_at)>0), updated_at TEXT NOT NULL CHECK(length(updated_at)>0),
           CHECK(source_path<>target_path)) STRICT;
         CREATE TABLE managed_file_cleanup (source_path TEXT PRIMARY KEY,
           kind TEXT NOT NULL DEFAULT 'format' CHECK(kind IN ('format','cover'))) STRICT;
         CREATE TABLE source_file_cleanup (source_path TEXT PRIMARY KEY CHECK(length(source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*')) STRICT;
         CREATE TABLE import_watch_observations (
           canonical_source_path TEXT PRIMARY KEY CHECK(length(canonical_source_path)>0),
           content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
           content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
           outcome TEXT NOT NULL CHECK(outcome IN ('imported','duplicate','unsupported','failed')),
           accounted_at TEXT NOT NULL CHECK(length(accounted_at)>0)) STRICT;
         CREATE INDEX library_items_by_title ON library_items(title COLLATE NOCASE,id);
         CREATE INDEX library_items_by_author ON library_items(author COLLATE NOCASE,id);
         CREATE INDEX library_items_by_series ON library_items(series COLLATE NOCASE,series_index,id);
         CREATE INDEX library_items_by_published_date ON library_items(published_date,id);
         CREATE INDEX library_items_by_rating ON library_items(rating,id);
         CREATE INDEX library_items_by_added_at ON library_items(added_at,id);
         CREATE INDEX library_items_by_updated_at ON library_items(updated_at,id);
         CREATE INDEX library_items_by_trashed_at
           ON library_items(trashed_at DESC,id ASC) WHERE trashed_at IS NOT NULL;
         CREATE INDEX library_item_formats_by_format ON library_item_formats(format,library_item_id);
         CREATE INDEX library_item_formats_by_fingerprint ON library_item_formats(content_bytes,content_sha256,library_item_id,position)
           WHERE provenance='managed';
         CREATE INDEX library_item_authors_by_name ON library_item_authors(name COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_languages_by_language ON library_item_languages(language COLLATE NOCASE,library_item_id);
         CREATE INDEX library_item_tags_by_tag ON library_item_tags(tag_normalized_name,library_item_id);
         CREATE INDEX saved_library_views_by_name ON saved_library_views(name COLLATE NOCASE,id);
         CREATE INDEX library_adoptions_by_state ON library_adoptions(state,updated_at,id);
         CREATE INDEX import_watch_observations_by_accounted_at
           ON import_watch_observations(accounted_at,canonical_source_path);
         CREATE INDEX import_watch_observations_by_fingerprint
           ON import_watch_observations(content_bytes,content_sha256,canonical_source_path);
         PRAGMA user_version=12;
         COMMIT;"
    )?;
    Ok(())
}

pub(super) fn has_schema(connection: &Connection) -> AppResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}
