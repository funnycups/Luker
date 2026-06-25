-- MySQL 8 schema v1. Extracted verbatim from the original SCHEMA_V1 array in
-- mysql-schema.js. Dialect rationale (utf8mb4_bin, VARCHAR(128), GENERATED
-- STORED integrity, groups_table rename, no FK on preset_states) is preserved
-- in mysql-schema.js header comments.
CREATE TABLE IF NOT EXISTS chats (
    handle VARCHAR(128) NOT NULL,
    char_dir VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_group TINYINT NOT NULL DEFAULT 0,
    group_id VARCHAR(128) NOT NULL DEFAULT '',
    doc JSON NOT NULL,
    integrity VARCHAR(64) GENERATED ALWAYS AS
        (JSON_UNQUOTE(JSON_EXTRACT(doc, '$.header.chat_metadata.integrity'))) STORED,
    updated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE INDEX chats_updated ON chats(handle, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_states (
    handle VARCHAR(128) NOT NULL,
    char_dir VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    is_group TINYINT NOT NULL DEFAULT 0,
    group_id VARCHAR(128) NOT NULL DEFAULT '',
    namespace VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace),
    CONSTRAINT chat_states_fk_chats
        FOREIGN KEY (handle, char_dir, name, is_group, group_id)
        REFERENCES chats(handle, char_dir, name, is_group, group_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS settings (
    handle VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS presets (
    handle VARCHAR(128) NOT NULL,
    dir_key VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, dir_key, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS preset_states (
    handle VARCHAR(128) NOT NULL,
    dir_key VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    namespace VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    PRIMARY KEY (handle, dir_key, name, namespace)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS worlds (
    handle VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS named_docs (
    handle VARCHAR(128) NOT NULL,
    bucket VARCHAR(128) NOT NULL,
    name VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle, bucket, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS groups_table (
    handle VARCHAR(128) NOT NULL,
    id VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (handle, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS stats (
    handle VARCHAR(128) NOT NULL,
    doc JSON NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (handle)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
