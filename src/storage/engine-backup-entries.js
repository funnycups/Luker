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
