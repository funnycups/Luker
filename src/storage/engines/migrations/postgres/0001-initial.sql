-- Postgres 16 schema v1. Extracted verbatim from the original SCHEMA_V1 array
-- in postgres-schema.js. Dialect rationale (JSONB, #>> path extraction,
-- SMALLINT for is_group parity with MySQL, groups_table rename, no FK on
-- preset_states) is preserved in postgres-schema.js header comments.
CREATE TABLE IF NOT EXISTS chats (
    handle VARCHAR(128) NOT NULL,
    char_dir VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_group SMALLINT NOT NULL DEFAULT 0,
    group_id VARCHAR(128) NOT NULL DEFAULT '',
    doc JSONB NOT NULL,
    integrity TEXT GENERATED ALWAYS AS (doc #>> '{header,chat_metadata,integrity}') STORED,
    updated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id)
);

CREATE INDEX IF NOT EXISTS chats_updated ON chats(handle, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_states (
    handle VARCHAR(128) NOT NULL,
    char_dir VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_group SMALLINT NOT NULL DEFAULT 0,
    group_id VARCHAR(128) NOT NULL DEFAULT '',
    namespace VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
    CONSTRAINT chat_states_fk_chats
        FOREIGN KEY (handle, char_dir, name, is_group, group_id)
        REFERENCES chats(handle, char_dir, name, is_group, group_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    handle VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle)
);

CREATE TABLE IF NOT EXISTS presets (
    handle VARCHAR(128) NOT NULL,
    dir_key VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, dir_key, name)
);

CREATE TABLE IF NOT EXISTS preset_states (
    handle VARCHAR(128) NOT NULL,
    dir_key VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    namespace VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    PRIMARY KEY (handle, dir_key, name, namespace)
);

CREATE TABLE IF NOT EXISTS worlds (
    handle VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, name)
);

CREATE TABLE IF NOT EXISTS named_docs (
    handle VARCHAR(128) NOT NULL,
    bucket VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, bucket, name)
);

CREATE TABLE IF NOT EXISTS groups_table (
    handle VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (handle, id)
);

CREATE TABLE IF NOT EXISTS stats (
    handle VARCHAR(128) NOT NULL,
    doc JSONB NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle)
);
