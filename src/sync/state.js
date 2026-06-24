import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { assertSafePeerId, getShadowPaths } from './shadow.js';

/**
 * Resolve the on-disk path of the per-user sync state file.
 *
 * Kept standalone (rather than delegating to `getShadowPaths` from
 * `./shadow.js`) because that helper requires a `peerId` argument, whereas
 * this file is the cross-peer registry that the rest of the sync subsystem
 * reads to *discover* peers in the first place. If the convention in
 * `getShadowPaths` ever changes, update this function in lockstep.
 *
 * @param {string} userRoot
 * @returns {string}
 */
function statePathFor(userRoot) {
    return path.join(userRoot, '.sync', 'state.json');
}

/**
 * Read the per-user sync state file. Returns an empty registry on missing
 * input; logs and returns an empty registry on parse-error or shape-mismatch
 * so corruption surfaces in the server log without breaking the caller (who
 * is allowed to treat "no peers known" as the natural starting state).
 *
 * Reads intentionally do not validate individual peerIds — legacy state files
 * may contain ids that wouldn't pass today's safety rules, and reading is
 * observation, not writing. The write helpers (`recordPeer`,
 * `recordSyncCompletion`, `removePeer`) are where unsafe ids are rejected.
 *
 * @param {{ userRoot: string }} args
 * @returns {{ peers: Record<string, object> }}
 */
export function readSyncState({ userRoot }) {
    const p = statePathFor(userRoot);
    if (!fs.existsSync(p)) return { peers: {} };
    try {
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.peers !== 'object' || Array.isArray(parsed.peers)) {
            console.warn(`[sync] ${p} has unexpected shape; treating as empty registry`);
            return { peers: {} };
        }
        return parsed;
    } catch (err) {
        console.warn(`[sync] failed to read ${p}: ${err.message}; treating as empty registry`);
        return { peers: {} };
    }
}

/**
 * Persist `state` to disk. Uses `write-file-atomic` so a mid-write crash
 * never leaves a half-written `state.json` behind — the rename either
 * completes or doesn't, and readers always see either the prior state or the
 * new one.
 *
 * File mode is fixed to 0600 because the registry may hold basic-auth
 * credentials in plaintext (see `recordPeer.peerAuth`); narrowing perms to
 * owner-only keeps other local users on a shared box from reading them.
 * Stronger at-rest encryption (per-handle key derivation, etc.) is a v2
 * problem — owner-only file mode is the minimum acceptable today.
 *
 * @param {{ userRoot: string, state: { peers: Record<string, object> } }} args
 */
async function writeSyncState({ userRoot, state }) {
    const p = statePathFor(userRoot);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    writeFileAtomicSync(p, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Add or refresh a peer entry. Idempotent: re-calling with the same `peerId`
 * preserves the original `pairedAt` (we only stamp it on first creation) but
 * does overwrite `label`, `categories`, and `peerBaseUrl`, which are the
 * user-visible knobs the pairing UI lets the operator edit.
 *
 * `peerBaseUrl` is optional. Pairing flows that don't know the URL yet
 * (e.g. `/pair/start` on the device that's generating the link) record
 * the peer without it; the URL gets filled in by the consuming side's
 * `/pair/accept`, OR — for re-syncs from the same device — pulled from
 * the existing entry without re-prompting the user.
 *
 * `peerAuth` is optional `{ username, password }`. Only stored when BOTH
 * fields are non-empty strings — a half-filled blob is treated as "no
 * auth supplied" and silently dropped (rather than persisting a useless
 * partial credential). When `peerAuth` is omitted/null, any previously-
 * stored credentials are preserved, mirroring the `peerBaseUrl` carry-
 * forward pattern: `/pair/start` doesn't know auth and must not clobber
 * what `/pair/accept` saved later. Stored in plaintext; see
 * `writeSyncState` for the file-mode policy that keeps the credentials
 * owner-readable only.
 *
 * @param {{ userRoot: string, peerId: string, label: string, categories: string[], peerBaseUrl?: string, peerAuth?: { username?: string, password?: string } | null }} args
 */
export async function recordPeer({ userRoot, peerId, label, categories, peerBaseUrl, peerAuth }) {
    assertSafePeerId(peerId);
    const state = readSyncState({ userRoot });
    const previous = state.peers[peerId] ?? {};
    const nextPeerAuth = (peerAuth && typeof peerAuth === 'object'
        && typeof peerAuth.username === 'string' && peerAuth.username.length
        && typeof peerAuth.password === 'string' && peerAuth.password.length)
        ? { username: peerAuth.username, password: peerAuth.password }
        : undefined;
    state.peers[peerId] = {
        ...previous,
        label,
        categories: [...categories],
        pairedAt: previous.pairedAt ?? Date.now(),
        // Preserve a previously-recorded URL when the caller doesn't
        // supply one; this keeps `/pair/start` (which has no peer URL
        // yet) from clobbering data recorded by a later `/pair/accept`.
        ...(peerBaseUrl ? { peerBaseUrl } : {}),
        // Same carry-forward for credentials: omitted/incomplete input
        // leaves the existing `peerAuth` (if any) intact.
        ...(nextPeerAuth ? { peerAuth: nextPeerAuth } : {}),
    };
    await writeSyncState({ userRoot, state });
}

/**
 * Drop stored basic-auth credentials for a peer. Used by the UI's
 * "Clear credentials" button when the user wants `Sync now` to start
 * prompting again (e.g. they rotated the other device's password and
 * want to enter the new one through the full pair flow).
 *
 * Idempotent — no-op when the peer isn't registered or has no stored
 * credentials. Other peer fields (label, categories, pairedAt,
 * peerBaseUrl, lastSyncAt, ...) are untouched.
 *
 * @param {{ userRoot: string, peerId: string }} args
 */
export async function clearPeerAuth({ userRoot, peerId }) {
    assertSafePeerId(peerId);
    const state = readSyncState({ userRoot });
    const peer = state.peers[peerId];
    if (!peer || !peer.peerAuth) return;
    delete peer.peerAuth;
    await writeSyncState({ userRoot, state });
}

/**
 * Stamp a successful sync completion. If the peer isn't registered yet (e.g.
 * a sync completed via a flow that bypasses pairing-time registration) we
 * create a minimal entry so the timestamp isn't lost. Other fields from a
 * prior `recordPeer` call are preserved.
 *
 * @param {{ userRoot: string, peerId: string, headOid: string }} args
 */
export async function recordSyncCompletion({ userRoot, peerId, headOid }) {
    assertSafePeerId(peerId);
    const state = readSyncState({ userRoot });
    if (!state.peers[peerId]) state.peers[peerId] = {};
    state.peers[peerId].lastSyncAt = Date.now();
    state.peers[peerId].lastSyncedOid = headOid;
    await writeSyncState({ userRoot, state });
}

/**
 * Remove a peer from the registry. Idempotent — removing an absent peer is a
 * no-op write.
 *
 * @param {{ userRoot: string, peerId: string }} args
 */
export async function removePeer({ userRoot, peerId }) {
    assertSafePeerId(peerId);
    const state = readSyncState({ userRoot });
    delete state.peers[peerId];
    await writeSyncState({ userRoot, state });
}

/**
 * Remove a peer and ALL on-disk state associated with it: the registry entry
 * AND the shadow repo directory under `<userRoot>/.sync/<peerId>/`. This is
 * what "Forget peer" in the UI calls — leaving the shadow dir behind would
 * silently consume disk space (a fully-snapshotted shadow can be tens of MB)
 * AND let stale state reappear if the user later re-pairs with a coincident
 * peerId.
 *
 * Idempotent: removing an absent peer (no registry entry, no shadow dir) is a
 * no-op. `fs.rm(..., { force: true })` swallows ENOENT so a partial state
 * (registry entry present but shadow dir already deleted, or vice versa) is
 * still cleaned up by a single call.
 *
 * @param {{ userRoot: string, peerId: string }} args
 */
export async function removePeerCompletely({ userRoot, peerId }) {
    assertSafePeerId(peerId);
    const { peerDir } = getShadowPaths({ userRoot, peerId });
    await removePeer({ userRoot, peerId });
    await fs.promises.rm(peerDir, { recursive: true, force: true });
}
