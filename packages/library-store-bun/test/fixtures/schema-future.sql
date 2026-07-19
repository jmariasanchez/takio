BEGIN IMMEDIATE;

CREATE TABLE future_library_records (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
) STRICT;

INSERT INTO future_library_records (id, payload)
VALUES ('future-record', 'must remain byte-for-byte unchanged');

PRAGMA user_version = 999;

COMMIT;
