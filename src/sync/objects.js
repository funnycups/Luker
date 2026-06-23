import fs from 'node:fs';
import git from 'isomorphic-git';

/**
 * Hard cap on object size for wire transfer. Matches spec §5.4: 25 MB per
 * object — comfortably accommodates a large settings.json with headroom, and
 * lets oversized objects fail loudly (with a known error code) rather than
 * silently filling the ODB or the HTTP payload buffer.
 */
/**
 * Hard cap on a single git object's body size, in bytes.
 *
 * Set to 1 GiB rather than the spec's original 25 MB. The original
 * number was sized for individual user files (the largest realistic was
 * settings.json at ~4 MB, with headroom). The SQLite-mode whole-DB
 * snapshot blows past that — a real `data/default-user` migrated to
 * SQLite is ~250 MB+. Without a cap that fits the SQLite blob, sync is
 * unusable in SQLite mode.
 *
 * The cap is NOT zero (i.e. unlimited): a malformed or hostile peer
 * could otherwise stream gigabytes into the raw-body buffer and OOM
 * the responder. 1 GiB fits any plausible SQLite blob a Luker user
 * would have, and is still bounded by the OS process's address space
 * — Express's `raw()` parser refuses on the way in.
 */
const MAX_OBJECT_BYTES = 1024 * 1024 * 1024;

/**
 * Read a single git object from the local ODB in a form suitable for the wire.
 *
 * Uses `format: 'content'` so the returned bytes are the raw, unwrapped object
 * body (i.e. the same bytes `writeObject({format: 'content'})` consumes on the
 * receiving side). isomorphic-git's `_readObject` returns the unwrapped object
 * with `type` set from the on-disk header (see `GitObject.unwrap`), so we get
 * both fields directly without re-parsing.
 *
 * The body is normalized to a Buffer because `result.object` may come back as a
 * Buffer (loose path) or a Uint8Array (packed path); the HTTP layer downstream
 * wants one shape it can write to a response stream. `Buffer.from(uint8)` is
 * cheap (no copy when given a Buffer, view-over-same-ArrayBuffer when given a
 * Uint8Array).
 *
 * Size check happens AFTER read so callers see the actual byte count in the
 * error message; the read itself is already paid for by the time we know the
 * size, and there is no streaming readObject API to short-circuit earlier.
 *
 * @param {{ dir: string, gitdir: string, oid: string }} args
 * @returns {Promise<{ oid: string, type: 'blob'|'tree'|'commit'|'tag', body: Buffer }>}
 */
export async function readObjectForWire({ dir, gitdir, oid }) {
    const result = await git.readObject({ fs, dir, gitdir, oid, format: 'content' });
    const body = Buffer.from(result.object);
    if (body.length > MAX_OBJECT_BYTES) {
        const err = new Error(`Object ${oid} exceeds wire size limit (${body.length} > ${MAX_OBJECT_BYTES})`);
        err.code = 'OBJECT_TOO_LARGE';
        throw err;
    }
    return { oid, type: result.type, body };
}

/**
 * Write a wire-format object into the local ODB and verify the resulting oid
 * matches what the sender claimed.
 *
 * Size check runs BEFORE `git.writeObject` so an oversized payload never
 * touches disk — important because isomorphic-git has no `gc`, so any object
 * we land that turns out to be junk would persist forever. A rejected write
 * leaves the ODB exactly as it was.
 *
 * The post-write oid comparison is the integrity gate. `git.writeObject`
 * computes the oid from the object's wrapped form (type-prefix + length +
 * NUL + body), so if the sender's `type` or `body` was tampered with in
 * transit the computed oid will not match `oid` and we throw. This is the
 * sync layer's substitute for transport-layer signing.
 *
 * @param {{ dir: string, gitdir: string, oid: string, type: string, body: Buffer }} args
 */
export async function writeObjectFromWire({ dir, gitdir, oid, type, body }) {
    if (body.length > MAX_OBJECT_BYTES) {
        const err = new Error(`Object ${oid} exceeds wire size limit (${body.length} > ${MAX_OBJECT_BYTES})`);
        err.code = 'OBJECT_TOO_LARGE';
        throw err;
    }
    const writtenOid = await git.writeObject({
        fs, dir, gitdir,
        type,
        object: body,
        format: 'content',
    });
    if (writtenOid !== oid) {
        throw new Error(`Object oid mismatch on receive: expected ${oid}, got ${writtenOid}`);
    }
}

/**
 * Check whether `oid` is already in the local ODB. Used by the missing-object
 * walker to skip objects we already have, so a re-sync of an unchanged HEAD
 * is a single ref read plus one `hasObjectLocally` check.
 *
 * Implementation detail: isomorphic-git has no public "does this oid exist"
 * helper, so we probe with `readObject({format: 'content'})` and special-case
 * its `NotFoundError`. `format: 'content'` (over 'parsed') skips the
 * commit/tree parser, keeping the probe cheap — we throw away the result
 * either way. Any other error (corrupt object, I/O error) is re-thrown so the
 * sync loop fails loudly instead of treating a damaged ODB as "missing" and
 * silently re-fetching forever.
 *
 * @param {{ dir: string, gitdir: string, oid: string }} args
 * @returns {Promise<boolean>}
 */
export async function hasObjectLocally({ dir, gitdir, oid }) {
    try {
        await git.readObject({ fs, dir, gitdir, oid, format: 'content' });
        return true;
    } catch (e) {
        if (e.code === 'NotFoundError') return false;
        throw e;
    }
}

/**
 * Walk a remote object graph starting at `headOid`. For each oid not present
 * locally, call `fetchObject(oid)` to retrieve it from the remote, write it
 * into the local ODB, then enqueue its children. Returns the oids written
 * this run (useful for progress reporting and for tests).
 *
 * Implements spec §5.2's pseudocode. `fetchObject` is injected so this module
 * stays transport-agnostic — the HTTP layer (Task 11) will wrap it around
 * `GET /session/object/<oid>`, but tests just call `readObjectForWire` against
 * a second shadow repo.
 *
 * Walk order is depth-first (`queue.pop()` from the tail). Order is not
 * semantically meaningful — every reachable object must be written before
 * the caller can advance the local ref — but DFS keeps the queue small for
 * commit-heavy graphs (we descend into one commit's tree before processing
 * its parents) which matters on long histories.
 *
 * Children are enqueued AFTER the parent is written; this guarantees that if
 * the parent write fails (oid mismatch, oversized body, disk error) we don't
 * leak its tree/parent references into the queue and waste fetch round trips
 * on subgraphs the caller is about to discard.
 *
 * Children are discovered by re-reading the just-written object in 'parsed'
 * form. We can't reuse the fetched `obj.body` directly because it's the raw
 * unwrapped bytes — parsing requires the GitCommit/GitTree machinery, and
 * `git.readObject({format: 'parsed'})` is the single canonical entry point
 * isomorphic-git exposes for that. The extra disk read is negligible
 * compared to the network round trip we just paid for.
 *
 * Tags are leaves for now (their `object` field would point to another oid,
 * but the sync flow never creates annotated tags — the shadow only commits
 * to `main`).
 *
 * @param {{
 *   dir: string,
 *   gitdir: string,
 *   headOid: string,
 *   fetchObject: (oid: string) => Promise<{ oid: string, type: string, body: Buffer }>,
 * }} args
 * @returns {Promise<string[]>} oids written this run, in walk order
 */
export async function fetchMissingObjects({ dir, gitdir, headOid, fetchObject }) {
    const written = [];
    const seen = new Set();
    const queue = [headOid];

    while (queue.length) {
        const oid = queue.pop();
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (await hasObjectLocally({ dir, gitdir, oid })) continue;

        const obj = await fetchObject(oid);
        // Pass the loop's `oid` (what we asked for) explicitly, not `...obj`
        // which would let the responder's claimed oid drive integrity. The
        // gate in writeObjectFromWire must verify "the bytes hash to what we
        // requested", otherwise a buggy/hostile responder could substitute a
        // different-but-internally-consistent object. obj.oid is informational.
        await writeObjectFromWire({ dir, gitdir, oid, type: obj.type, body: obj.body });
        written.push(oid);

        // Walk children of newly-written objects. The just-written object is
        // guaranteed to be local now, so 'parsed' read won't trigger another
        // fetch.
        if (obj.type === 'commit') {
            const parsed = await git.readObject({ fs, dir, gitdir, oid, format: 'parsed' });
            queue.push(parsed.object.tree);
            for (const p of parsed.object.parent ?? []) queue.push(p);
        } else if (obj.type === 'tree') {
            const parsed = await git.readObject({ fs, dir, gitdir, oid, format: 'parsed' });
            for (const entry of parsed.object) queue.push(entry.oid);
        }
        // blobs and tags have no children we need to follow for sync.
    }
    return written;
}
