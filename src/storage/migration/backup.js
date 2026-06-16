import fs from 'node:fs';
import path from 'node:path';

/**
 * Snapshot a user's directory tree into <backupRoot>/<timestamp>-<handle>/.
 * Returns the absolute backup path.
 *
 * The snapshot is a verbatim recursive copy of the user's per-handle directory.
 * For SQLite users this copies the .sqlite file too (better-sqlite3 keeps it
 * consistent on close, but during normal operation the WAL/SHM files coexist —
 * cpSync copies all of them, which is fine because a restore is "rm new dir,
 * mv backup back").
 *
 * The timestamp uses ISO-8601 with `:` and `.` replaced by `-` so it's both
 * filename-safe and lexicographically sortable.
 */
export function snapshotUser({ handle, userRoot, backupRoot }) {
    if (!handle) throw new Error('snapshotUser: handle is required');
    if (!userRoot) throw new Error('snapshotUser: userRoot is required');
    if (!backupRoot) throw new Error('snapshotUser: backupRoot is required');
    if (!fs.existsSync(userRoot)) {
        throw new Error(`snapshotUser: source userRoot does not exist: ${userRoot}`);
    }
    fs.mkdirSync(backupRoot, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupRoot, `${timestamp}-${handle}`);
    fs.cpSync(userRoot, dest, { recursive: true });
    return dest;
}
