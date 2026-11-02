import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import git from 'isomorphic-git';
import writeFileAtomic from 'write-file-atomic';
import { atomicFs } from './pipeline/atomic-fs.js';
import { failpoint, FAILPOINTS } from './pipeline/failpoints.js';

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
    const result = await git.readObject({ fs: atomicFs, dir, gitdir, oid, format: 'content' });
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
 * An object whose closure is not complete locally is marked suspect before
 * it is written (see `markSuspectIfIncomplete`).
 *
 * @param {{ dir: string, gitdir: string, oid: string, type: string, body: Buffer }} args
 */
export async function writeObjectFromWire({ dir, gitdir, oid, type, body }) {
    await markSuspectIfIncomplete({ dir, gitdir, oid, type, body });
    await writeWireObject({ dir, gitdir, oid, type, body });
}

/**
 * @param {{ dir: string, gitdir: string, oid: string, type: string, body: Buffer }} args
 */
async function writeWireObject({ dir, gitdir, oid, type, body }) {
    const writtenOid = await git.writeObject({
        fs: atomicFs, dir, gitdir,
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
 * Senders write children first, but a sender running an older build sends
 * parents first, so an object whose closure is not complete locally is
 * marked suspect before it is written (see `markSuspectIfIncomplete`).
 *
 * `withLock` wraps the two sections that create files in the repository:
 * opening the tmp file and moving the received object into the store.
 * The transfer between them runs outside it, so a caller can hold a lock
 * over both sections without holding it while the sender streams.
 *
 * @param {{
 *   dir: string,
 *   gitdir: string,
 *   oid: string,
 *   type: string,
 *   stream: import('node:stream').Readable,
 *   withLock?: <T>(fn: () => Promise<T>) => Promise<T>,
 * }} args
 */
export async function writeObjectFromWireStream({ dir, gitdir, oid, type, stream, withLock = fn => fn() }) {
    const incomingDir = path.join(gitdir, 'objects', 'incoming');
    const tmpPath = path.join(incomingDir, crypto.randomBytes(16).toString('hex'));
    let output = null;
    try {
        const handle = await withLock(async () => {
            await fs.promises.mkdir(incomingDir, { recursive: true });
            return fs.promises.open(tmpPath, 'w');
        });
        output = handle.createWriteStream();
        await pipeline(stream, output);
        await withLock(async () => {
            const body = await fs.promises.readFile(tmpPath);
            if (wireObjectOid(type, body) !== oid) {
                throw new Error(`Object oid mismatch on receive: expected ${oid}, got ${wireObjectOid(type, body)}`);
            }
            await markSuspectIfIncomplete({ dir, gitdir, oid, type, body });
            await writeWireObject({ dir, gitdir, oid, type, body });
        });
    } finally {
        if (output && !output.closed) output.destroy();
        await fs.promises.rm(tmpPath, { force: true });
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
        await git.readObject({ fs: atomicFs, dir, gitdir, oid, format: 'content' });
        return true;
    } catch (e) {
        if (e.code === 'NotFoundError') return false;
        throw e;
    }
}

/**
 * Hash of a wire object the way git names it: sha1 over
 * `<type> <length>\0<body>`.
 */
function wireObjectOid(type, body) {
    return crypto.createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}

/**
 * Oids an object refers to: a commit's tree and parents, a tree's entries.
 * Submodule entries (mode 160000) name commits of another repository and
 * are not followed.
 *
 * @param {string} type
 * @param {Buffer} body raw unwrapped object bytes
 * @returns {string[]}
 */
export function childOidsOfWireObject(type, body) {
    return childEntriesOfWireObject(type, body).map(child => child.oid);
}

/**
 * `childOidsOfWireObject` with the type each child must have: the tree
 * entry mode tells blobs from trees, so callers can check a blob's presence
 * without reading it.
 *
 * @param {string} type
 * @param {Buffer} body
 * @returns {Array<{ oid: string, kind: 'commit' | 'tree' | 'blob' }>}
 */
function childEntriesOfWireObject(type, body) {
    if (type === 'commit') {
        const text = body.toString('utf8');
        const headerEnd = text.indexOf('\n\n');
        const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
        const children = [];
        for (const line of header.split('\n')) {
            if (line.startsWith('tree ')) children.push({ oid: line.slice('tree '.length).trim(), kind: 'tree' });
            else if (line.startsWith('parent ')) children.push({ oid: line.slice('parent '.length).trim(), kind: 'commit' });
        }
        return children;
    }
    if (type === 'tree') {
        const children = [];
        let offset = 0;
        while (offset < body.length) {
            const space = body.indexOf(0x20, offset);
            const nul = body.indexOf(0, offset);
            if (space === -1 || nul === -1 || space === offset || space > nul || nul + 21 > body.length) throw new Error('malformed tree object');
            const mode = body.subarray(offset, space).toString('utf8');
            const oid = body.subarray(nul + 1, nul + 21).toString('hex');
            if (mode === '40000' || mode === '040000') children.push({ oid, kind: 'tree' });
            else if (mode !== '160000') children.push({ oid, kind: 'blob' });
            offset = nul + 21;
        }
        return children;
    }
    return [];
}

/**
 * Copy every object reachable from `headOid` that the local ODB lacks,
 * writing each object only after all of its children. A present object
 * that is not marked suspect therefore has its whole closure present, so
 * the walk stops at such objects and an interrupted transfer leaves only
 * complete sub-graphs behind. A suspect object is read locally and walked
 * like a fetched one; once its children are complete its mark is removed.
 * The first call on a repository runs `scanClosureOnce`, which marks the
 * incomplete objects that builds writing parents first left behind.
 * A missing child of a suspect object must come from `fetchObject`; when
 * the peer cannot supply it the fetch throws, and every later fetch that
 * reaches that suspect object throws the same way until the child arrives
 * from some other source.
 *
 * Depth-first with an explicit stack: fetched bodies are held only for
 * the objects on the current path. Each body is checked against the
 * requested oid before its children are read, so a responder cannot
 * steer the walk with substituted bytes.
 *
 * `fetchObject` is the transport: the HTTP layer wraps
 * `GET /session/object/<oid>`, tests read another local repo.
 *
 * @param {{
 *   dir: string,
 *   gitdir: string,
 *   headOid: string,
 *   fetchObject: (oid: string) => Promise<{ oid: string, type: string, body: Buffer }>,
 *   withLocal?: <T>(fn: () => Promise<T>) => Promise<T>,
 * }} args
 * @returns {Promise<string[]>} oids written this run, children before parents
 */
export async function fetchMissingObjects({ dir, gitdir, headOid, fetchObject, withLocal = fn => fn() }) {
    await withLocal(() => scanClosureOnce({ dir, gitdir }));
    const written = [];
    const present = new Set();
    const onPath = new Set([headOid]);
    const stack = [{ oid: headOid, object: null, children: null, next: 0 }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.object === null) {
            if (present.has(frame.oid)) {
                onPath.delete(frame.oid);
                stack.pop();
                continue;
            }
            if (await objectExists({ dir, gitdir, oid: frame.oid })) {
                if (!isSuspect(gitdir, frame.oid)) {
                    present.add(frame.oid);
                    onPath.delete(frame.oid);
                    stack.pop();
                    continue;
                }
                const local = await readObjectForWire({ dir, gitdir, oid: frame.oid });
                frame.object = { type: local.type, body: local.body };
                frame.children = childOidsOfWireObject(local.type, local.body);
                frame.local = true;
                continue;
            }
            const fetched = await fetchObject(frame.oid);
            const body = Buffer.from(fetched.body);
            const actual = wireObjectOid(fetched.type, body);
            if (actual !== frame.oid) {
                throw new Error(`Object oid mismatch on receive: expected ${frame.oid}, got ${actual}`);
            }
            frame.object = { type: fetched.type, body };
            frame.children = childOidsOfWireObject(fetched.type, body);
            continue;
        }
        if (frame.next < frame.children.length) {
            const child = frame.children[frame.next++];
            if (!present.has(child) && !onPath.has(child)) {
                onPath.add(child);
                stack.push({ oid: child, object: null, children: null, next: 0 });
            }
            continue;
        }
        if (frame.local) {
            await withLocal(() => clearSuspect(gitdir, frame.oid));
        } else {
            await withLocal(() => writeWireObject({ dir, gitdir, oid: frame.oid, type: frame.object.type, body: frame.object.body }));
            written.push(frame.oid);
        }
        present.add(frame.oid);
        onPath.delete(frame.oid);
        stack.pop();
        if (written.length === 1 && !frame.local) failpoint(FAILPOINTS.FETCH_AFTER_FIRST_OBJECT);
    }
    return written;
}

/**
 * Local objects reachable from `headOid` and not in `skip`, each listed
 * after all of its children, so a receiver that writes them in this order
 * keeps the closure invariant even if the transfer stops halfway.
 *
 * @param {{ dir: string, gitdir: string, headOid: string, skip: Set<string> }} args
 * @returns {Promise<string[]>}
 */
export async function listObjectsChildrenFirst({ dir, gitdir, headOid, skip }) {
    const ordered = [];
    const seen = new Set();
    const stack = [{ oid: headOid, children: null, next: 0 }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.children === null) {
            if (seen.has(frame.oid) || skip.has(frame.oid)) {
                stack.pop();
                continue;
            }
            seen.add(frame.oid);
            const obj = await readObjectForWire({ dir, gitdir, oid: frame.oid });
            frame.children = childOidsOfWireObject(obj.type, obj.body);
            continue;
        }
        if (frame.next < frame.children.length) {
            const child = frame.children[frame.next++];
            if (!seen.has(child) && !skip.has(child)) stack.push({ oid: child, children: null, next: 0 });
            continue;
        }
        ordered.push(frame.oid);
        stack.pop();
    }
    return ordered;
}

/**
 * Whether `oid` and everything it reaches are present locally. Present
 * objects that are not suspect have a complete closure, because
 * children-first writes mark a parent suspect before writing it whenever a
 * child is missing or suspect.
 *
 * @param {{ dir: string, gitdir: string, oid: string }} args
 * @returns {Promise<boolean>}
 */
export async function hasCompleteClosure({ dir, gitdir, oid, verify = false }) {
    if (verify) {
        const stack = [{ oid, kind: 'commit' }];
        const seen = new Map();
        const cache = {};
        try {
            while (stack.length) {
                const next = stack.pop();
                if (!/^[a-f0-9]{40}$/.test(next.oid)) return false;
                if (seen.has(next.oid)) {
                    if (seen.get(next.oid) !== next.kind) return false;
                    continue;
                }
                const object = await git.readObject({ fs: atomicFs, dir, gitdir, oid: next.oid, format: 'content', cache });
                const body = Buffer.from(object.object);
                if (object.type !== next.kind || wireObjectOid(object.type, body) !== next.oid) return false;
                const children = childEntriesOfWireObject(object.type, body);
                if (object.type === 'commit' && children.filter(child => child.kind === 'tree').length !== 1) return false;
                seen.set(next.oid, object.type);
                for (const child of children) stack.push(child);
            }
            return true;
        } catch { return false; }
    }
    await scanClosureOnce({ dir, gitdir });
    return (await objectExists({ dir, gitdir, oid })) && !isSuspect(gitdir, oid);
}

/**
 * Closure bookkeeping lives under `<gitdir>/luker-closure/`: `scanned`
 * records that `scanClosureOnce` finished, and `suspect/<oid>` marks a
 * present object whose closure may be incomplete.
 */
const CLOSURE_DIR = 'luker-closure';

function closurePaths(gitdir) {
    const root = path.join(gitdir, CLOSURE_DIR);
    return { scanned: path.join(root, 'scanned'), suspect: path.join(root, 'suspect') };
}

function isSuspect(gitdir, oid) {
    return fs.existsSync(path.join(closurePaths(gitdir).suspect, oid));
}

async function markSuspect(gitdir, oid) {
    const { suspect } = closurePaths(gitdir);
    await fs.promises.mkdir(suspect, { recursive: true });
    await writeFileAtomic(path.join(suspect, oid), '');
}

async function clearSuspect(gitdir, oid) {
    await fs.promises.rm(path.join(closurePaths(gitdir).suspect, oid), { force: true });
}

function looseObjectPath(gitdir, oid) {
    return path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2));
}

/**
 * Presence check that avoids inflating loose objects; packed objects fall
 * back to `hasObjectLocally`.
 *
 * @param {{ dir: string, gitdir: string, oid: string }} args
 * @returns {Promise<boolean>}
 */
async function objectExists({ dir, gitdir, oid }) {
    if (fs.existsSync(looseObjectPath(gitdir, oid))) return true;
    return hasObjectLocally({ dir, gitdir, oid });
}

/**
 * Mark `oid` suspect before it is written when one of its children is
 * missing or suspect. The mark is written first so no reader ever sees
 * the object present and unmarked while its closure is incomplete.
 *
 * @param {{ dir: string, gitdir: string, oid: string, type: string, body: Buffer }} args
 */
async function markSuspectIfIncomplete({ dir, gitdir, oid, type, body }) {
    for (const child of childOidsOfWireObject(type, body)) {
        if (!(await objectExists({ dir, gitdir, oid: child })) || isSuspect(gitdir, child)) {
            await markSuspect(gitdir, oid);
            return;
        }
    }
}

/**
 * Object type of a loose object, read by inflating its zlib stream only
 * until the `<type> <size>\0` header has come out.
 *
 * @param {string} file
 * @returns {Promise<string>}
 */
async function looseObjectType(file) {
    const source = fs.createReadStream(file);
    const inflate = zlib.createInflate();
    source.on('error', error => inflate.destroy(error));
    source.pipe(inflate);
    let head = Buffer.alloc(0);
    try {
        for await (const chunk of inflate) {
            head = Buffer.concat([head, chunk]);
            if (head.includes(0)) break;
        }
    } finally {
        source.destroy();
        inflate.destroy();
    }
    const space = head.indexOf(0x20);
    if (space === -1 || head.indexOf(0) < space) throw new Error(`malformed loose object header in ${file}`);
    return head.subarray(0, space).toString('utf8');
}

async function listLooseObjects(gitdir) {
    const objectsDir = path.join(gitdir, 'objects');
    const oids = [];
    for (const prefix of await fs.promises.readdir(objectsDir).catch(() => [])) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
        for (const rest of await fs.promises.readdir(path.join(objectsDir, prefix))) {
            if (/^[0-9a-f]{38}$/.test(rest)) oids.push(prefix + rest);
        }
    }
    return oids;
}

/**
 * Builds before children-first transfer wrote parents first, so an
 * interrupted transfer could leave a commit or tree without its children.
 * Once per repository, walk every loose commit and tree, mark each present
 * object whose closure is incomplete as suspect, then record the scan.
 * Blobs have no children and are only checked for presence. An object
 * that cannot be read or parsed is marked suspect and the scan goes on;
 * fetch then fails when it needs that object, instead of the scan failing
 * on every call. Shadow
 * repositories hold loose objects only: every sync writer goes through
 * `git.writeObject`, `writeBlob`, `writeTree` or `commit`.
 *
 * @param {{ dir: string, gitdir: string }} args
 */
async function scanClosureOnce({ dir, gitdir }) {
    const { scanned } = closurePaths(gitdir);
    if (fs.existsSync(scanned)) return;
    /** @type {Map<string, boolean>} commit and tree oids -> closure complete */
    const complete = new Map();
    for (const root of await listLooseObjects(gitdir)) {
        if (complete.has(root)) continue;
        let type;
        try {
            type = await looseObjectType(looseObjectPath(gitdir, root));
        } catch (error) {
            console.warn('[sync] unreadable loose object marked suspect:', root, error);
            complete.set(root, false);
            continue;
        }
        if (type !== 'commit' && type !== 'tree') continue;
        const stack = [{ oid: root, children: null, next: 0, ok: true }];
        const onPath = new Set([root]);
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame.children === null) {
                if (!(await objectExists({ dir, gitdir, oid: frame.oid }))) {
                    frame.ok = false;
                    frame.children = [];
                } else {
                    try {
                        const obj = await readObjectForWire({ dir, gitdir, oid: frame.oid });
                        frame.children = childEntriesOfWireObject(obj.type, obj.body);
                    } catch (error) {
                        console.warn('[sync] unreadable object marked suspect:', frame.oid, error);
                        frame.ok = false;
                        frame.children = [];
                    }
                }
                continue;
            }
            if (frame.next < frame.children.length) {
                const child = frame.children[frame.next++];
                if (child.kind === 'blob') {
                    if (!(await objectExists({ dir, gitdir, oid: child.oid }))) frame.ok = false;
                } else if (complete.has(child.oid)) {
                    if (!complete.get(child.oid)) frame.ok = false;
                } else if (!onPath.has(child.oid)) {
                    onPath.add(child.oid);
                    stack.push({ oid: child.oid, children: null, next: 0, ok: true });
                }
                continue;
            }
            complete.set(frame.oid, frame.ok);
            onPath.delete(frame.oid);
            stack.pop();
            if (stack.length > 0 && !frame.ok) stack[stack.length - 1].ok = false;
        }
    }
    for (const [oid, ok] of complete) {
        if (!ok && await objectExists({ dir, gitdir, oid })) await markSuspect(gitdir, oid);
    }
    await fs.promises.mkdir(path.dirname(scanned), { recursive: true });
    await writeFileAtomic(scanned, '');
}
