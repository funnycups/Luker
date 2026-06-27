/**
 * Filenames used in backup ZIPs and migration snapshots to carry an
 * engine-side dump in db modes. The reader (restoreUserBackupArchive,
 * restoreFromSnapshot) detects these names; the writer (createBackupArchive,
 * snapshotUser) emits them.
 *
 * Hoisted so the writer side and the reader side cannot drift on a rename —
 * before Stage 5 Task 5 the meta/dump names lived as bare string literals in
 * users.js + backup.js while users-private.js declared them as local
 * constants, and changing one without the other would silently break restore.
 */
export const ENGINE_META_ENTRY = '_engine_meta.json';
export const ENGINE_DUMP_ENTRY = '_engine_dump.bin';

/**
 * Reserved handle prefix the cross-mode restore orchestrator uses for the
 * transient source engine's scratch handle. The leading underscore
 * guarantees no collision with real user handles (Luker handle validation
 * rejects names beginning with `_` or `.`).
 *
 * Used in three places that MUST agree on the same prefix:
 * 1. cross-mode-restore.js — generates `_xrestore_<16-byte hex>` per call.
 * 2. gc-scratch.js — sweeps `_storage-migrations/_xrestore_*` dirs older
 *    than the configured TTL on server boot.
 * 3. transient-source.js — propagates the prefix into mysql/pg scratch DB
 *    cleanup queries (`DELETE … WHERE handle LIKE '_xrestore_%'`) that
 *    operators document for manual cleanup.
 */
export const SCRATCH_HANDLE_PREFIX = '_xrestore_';
