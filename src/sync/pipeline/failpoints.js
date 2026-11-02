import fs from 'node:fs';
import path from 'node:path';

import { syncError } from '../errors.js';

/**
 * Test-only crash injection. When `LUKER_SYNC_FAILPOINT` names a point,
 * reaching it kills the process with SIGKILL, so crash tests can stop a
 * sync at an exact step and check what the next start recovers. SIGKILL
 * skips exit handlers, so temp-file cleanup and other `exit` listeners do
 * not run, as in a real crash. Optional LUKER_SYNC_FAILPOINT_ARM names a
 * fixture-owned file consumed once before the marker and kill. Without
 * that setting the selected point always fires, preserving child fixtures.
 */
export const FAILPOINTS = Object.freeze({
    S3_UPLOAD_AFTER_FIRST_CHUNK: 's3-upload-after-first-chunk',
    S3_DOWNLOAD_AFTER_FIRST_CHUNK: 's3-download-after-first-chunk',
    S3_PACK_INSTALLED_BEFORE_INDEX: 's3-pack-installed-before-index',
    S3_INDEXED_BEFORE_LEDGER: 's3-indexed-before-ledger',
    SNAPSHOT_BEFORE_COMMIT: 'snapshot-before-commit',
    RECONCILE_AFTER_FIRST_WRITE: 'reconcile-after-first-write',
    FETCH_AFTER_FIRST_OBJECT: 'fetch-after-first-object',
    PUSH_BEFORE_CAS: 'push-before-cas',
    SEED_RECORDS_BEFORE_JOURNAL: 'seed-records-before-journal',
    SEED_RECORDS_AFTER_JOURNAL: 'seed-records-after-journal',
    BACKUP_TAG_BEFORE_TARGET: 'backup-tag-before-target',
    LOCAL_EDIT_BEFORE_JOURNAL: 'local-edit-before-journal',
    LOCAL_EDIT_AFTER_JOURNAL: 'local-edit-after-journal',
    CHAT_PUBLICATION_BEFORE_LINK: 'chat-publication-before-link',
});

/**
 * The line a failpoint writes to stderr before the kill, so a test can
 * tell which point fired.
 *
 * @param {string} name
 * @returns {string}
 */
export function failpointMarker(name) {
    return `luker-sync-failpoint: ${name}\n`;
}

/**
 * @param {string} name
 */
export function failpoint(name) {
    if (process.env.LUKER_SYNC_FAILPOINT !== name) return;
    const arm = process.env.LUKER_SYNC_FAILPOINT_ARM;
    if (arm) {
        try { fs.unlinkSync(arm); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
    // A synchronous write: stderr on a pipe is asynchronous on some
    // platforms and would be lost to the kill.
    fs.writeSync(2, failpointMarker(name));
    process.kill(process.pid, 'SIGKILL');
}

/**
 * Test-only pause injection. A pausepoint named by `LUKER_SYNC_PAUSEPOINT`
 * pauses once per `<LUKER_SYNC_PAUSE_DIR>/<name>.arm` file: it consumes the
 * arm file, writes `<name>.reached`, waits for `<name>.release`, then
 * removes both. A test arms the point right before the action it pauses,
 * so earlier cycles of the same process pass through.
 */
export const PAUSEPOINTS = Object.freeze({
    AFTER_SNAPSHOT: 'after-snapshot',
    INSIDE_SNAPSHOT_LOCK: 'inside-snapshot-lock',
    AFTER_REMOTE_HEAD: 'after-remote-head',
    SESSION_REF_BEFORE_LOCK: 'session-ref-before-lock',
    LOCAL_EDIT_BEFORE_RECONCILE: 'local-edit-before-reconcile',
    CONFLICT_CHOICES_AFTER_READ: 'conflict-choices-after-read',
    OFFER_BEFORE_ADMISSION: 'offer-before-admission',
    OFFER_AFTER_ADMISSION: 'offer-after-admission',
    UNDO_BEFORE_CLEANUP: 'undo-before-cleanup',
});

async function waitForFile(dir, name) {
    const file = path.join(dir, name);
    // Directory-watch events can be coalesced across a rapid re-arm on
    // macOS. This test-only barrier observes the file itself instead.
    while (!fs.existsSync(file)) await new Promise(resolve => setImmediate(resolve));
}

/**
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function pausepoint(name, scope = null) {
    if (process.env.LUKER_SYNC_PAUSEPOINT !== name) return;
    const root = process.env.LUKER_SYNC_PAUSE_DIR;
    const dir = root && scope ? path.join(root, path.basename(scope)) : root;
    if (!dir) return;
    const arm = path.join(dir, `${name}.arm`);
    if (!fs.existsSync(arm)) return;
    fs.rmSync(arm, { force: true });
    const reached = path.join(dir, `${name}.reached`);
    fs.writeFileSync(reached, '');
    await waitForFile(dir, `${name}.release`);
    fs.rmSync(reached, { force: true });
    fs.rmSync(path.join(dir, `${name}.release`), { force: true });
}

/**
 * Test-only error injection. A throwpoint named by `LUKER_SYNC_THROWPOINT`
 * throws instead of killing, so a test can observe a failed reconcile
 * inside a running server. `LUKER_SYNC_THROWPOINT_MATCH` limits it to
 * details containing that text.
 */
export const THROWPOINTS = Object.freeze({
    RECONCILE_WRITE: 'reconcile-write',
});

/**
 * @param {string} name
 * @param {string} detail
 */
export function throwpoint(name, detail) {
    if (process.env.LUKER_SYNC_THROWPOINT !== name) return;
    const match = process.env.LUKER_SYNC_THROWPOINT_MATCH;
    if (match !== undefined && !detail.includes(match)) return;
    throw syncError('THROWPOINT', `luker-sync-throwpoint: ${name} ${detail}`);
}
