-- SQLite schema v1. Extracted verbatim from the original SCHEMA_V1 array in
-- sqlite-schema.js. Dialect rationale (TEXT columns, json_extract GENERATED
-- STORED integrity, groups_table rename, no FK on preset_states) is preserved
-- in sqlite-schema.js comments.
CREATE TABLE IF NOT EXISTS chats (
    handle TEXT NOT NULL,
    char_dir TEXT NOT NULL,
    name TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    group_id TEXT NOT NULL DEFAULT '',
    doc TEXT NOT NULL,
    integrity TEXT GENERATED ALWAYS AS (json_extract(doc, '$.header.chat_metadata.integrity')) STORED,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id)
);

CREATE INDEX IF NOT EXISTS chats_updated ON chats(handle, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_states (
    handle TEXT NOT NULL,
    char_dir TEXT NOT NULL,
    name TEXT NOT NULL,
    is_group INTEGER NOT NULL DEFAULT 0,
    group_id TEXT NOT NULL DEFAULT '',
    namespace TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
    FOREIGN KEY (handle, char_dir, name, is_group, group_id)
        REFERENCES chats(handle, char_dir, name, is_group, group_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    handle TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
    handle TEXT NOT NULL,
    dir_key TEXT NOT NULL,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (handle, dir_key, name)
);

CREATE TABLE IF NOT EXISTS preset_states (
    handle TEXT NOT NULL,
    dir_key TEXT NOT NULL,
    name TEXT NOT NULL,
    namespace TEXT NOT NULL,
    doc TEXT NOT NULL,
    PRIMARY KEY (handle, dir_key, name, namespace)
);

CREATE TABLE IF NOT EXISTS worlds (
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (handle, name)
);

CREATE TABLE IF NOT EXISTS named_docs (
    handle TEXT NOT NULL,
    bucket TEXT NOT NULL,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (handle, bucket, name)
);

CREATE TABLE IF NOT EXISTS groups_table (
    handle TEXT NOT NULL,
    id TEXT NOT NULL,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (handle, id)
);

CREATE TABLE IF NOT EXISTS stats (
    handle TEXT PRIMARY KEY,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
