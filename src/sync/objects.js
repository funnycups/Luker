import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import git from 'isomorphic-git';

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
 * No size cap: isomorphic-git has no streaming readObject API, so the read is
 * already paid for in RAM by the time we'd check a limit, and the caller has
 * decided (sync/objects route) that any object the responder is willing to
 * serve is one the peer must be willing to accept.
 *
 * @param {{ dir: string, gitdir: string, oid: string }} args
 * @returns {Promise<{ oid: string, type: 'blob'|'tree'|'commit'|'tag', body: Buffer }>}
 */
export async function readObjectForWire({ dir, gitdir, oid }) {
    const result = await git.readObject({ fs, dir, gitdir, oid, format: 'content' });
    const body = Buffer.from(result.object);
    return { oid, type: result.type, body };
}

/**
 * Write a wire-format object into the local ODB and verify the resulting oid
 * matches what the sender claimed.
 *
 * Buffer variant — used by `fetchMissingObjects`, which already holds the
 * fetched body in memory as a Buffer (parsed from the responder's HTTP
 * response by the transport layer).
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
 * Streaming variant of `writeObjectFromWire` for the HTTP receive path.
 *
 * The Express request body is piped to a tmp file under
 * `<gitdir>/objects/incoming/` so the request bytes are NEVER held in
 * process RAM as a single buffer — back-pressure flows through the pipe
 * and the kernel pages the file in and out as `git.writeObject` reads it.
 * This is the safety net that replaces the old `MAX_OBJECT_BYTES` cap: a
 * hostile or buggy peer streaming gigabytes still cannot grow the
 * responder's heap past what isomorphic-git itself needs to hash and
 * write the object once.
 *
 * Why a tmp file at all (vs `request.pipe(into-writeObject)`):
 * isomorphic-git's `git.writeObject` has no streaming API — it consumes a
 * single `object: Buffer`. The tmp file is the smallest available
 * abstraction that lets us accept the body without buffering it in RAM
 * during transfer; the buffer materializes exactly once, inside
 * `writeObject`'s sha1+deflate path, which is where it would have lived
 * regardless of how the bytes arrived.
 *
 * On success the tmp file is unlinked (the object is already persisted to
 * the ODB by `writeObject`'s atomic rename). On any failure path
 * (pipeline error, oid mismatch, writeObject throw) the tmp file is also
 * unlinked, so a failed receive leaves no orphans under `incoming/`.
 *
 * `incoming/` is created lazily via `mkdir({recursive:true})` — older
 * shadow repos initialized before this code shipped won't have the
 * directory pre-created, and creating it on every call is cheap (a single
 * stat-and-noop after the first hit).
 *
 * @param {{
 *   dir: string,
 *   gitdir: string,
 *   oid: string,
 *   type: string,
 *   stream: import('node:stream').Readable,
 * }} args
 */
export async function writeObjectFromWireStream({ dir, gitdir, oid, type, stream }) {
    const incomingDir = path.join(gitdir, 'objects', 'incoming');
    await fs.promises.mkdir(incomingDir, { recursive: true });
    const tmpPath = path.join(incomingDir, crypto.randomBytes(16).toString('hex'));

    let cleanedUp = false;
    const cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { await fs.promises.unlink(tmpPath); } catch { /* best-effort */ }
    };

    try {
        await pipeline(stream, fs.createWriteStream(tmpPath));
        const body = await fs.promises.readFile(tmpPath);
        const writtenOid = await git.writeObject({
            fs, dir, gitdir,
            type,
            object: body,
            format: 'content',
        });
        if (writtenOid !== oid) {
            throw new Error(`Object oid mismatch on receive: expected ${oid}, got ${writtenOid}`);
        }
    } finally {
        await cleanup();
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
 * `fetchObject` is injected so this module
 * stays transport-agnostic — the HTTP layer wraps it around
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
