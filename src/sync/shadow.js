import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SYNC_CATEGORIES, resolveCategoryPaths } from './categories.js';

export const PEER_ID_PATTERN = /^[A-Za-z0-9._@-]+$/;

/**
 * Throw if `peerId` is not safe to embed in a filesystem path or to use as a
 * sync registry key. Centralized so `getShadowPaths` (which derives on-disk
 * paths) and `state.js` (which writes the cross-peer registry) share one
 * source of truth — a peerId rejected by one must be rejected by the other,
 * or the registry can hold ids that crash later when path derivation runs.
 *
 * @param {string} peerId
 */
export function assertSafePeerId(peerId) {
    if (typeof peerId !== 'string' || !peerId || /^\.+$/.test(peerId) || !PEER_ID_PATTERN.test(peerId)) {
        throw new Error(`peerId ${JSON.stringify(peerId)} is not a safe identifier`);
    }
}

const SHADOW_AUTHOR = { name: 'Luker Sync', email: 'sync@luker.local' };

/**
 * @typedef {Object} ShadowPaths
 * @property {string} syncRoot
 * @property {string} peerDir
 * @property {string} gitDir
 * @property {string} workdir
 * @property {string} statePath
 */

/**
 * Derive on-disk paths for a peer's shadow repo. Pure; no I/O.
 *
 * The shadow repo is intentionally split: `gitDir` (the bare `.git`-style
 * object/ref store) sits next to `workdir` (the checked-out tree we snapshot
 * the live user data into). This split is what lets us point isomorphic-git
 * at both via explicit `gitdir`/`dir` args, instead of the default
 * `<dir>/.git` layout that `IsomorphicGitClient` assumes.
 *
 * @param {{ userRoot: string, peerId: string }} args
 * @returns {ShadowPaths}
 */
export function getShadowPaths({ userRoot, peerId }) {
    if (typeof userRoot !== 'string' || !userRoot) {
        throw new Error('getShadowPaths: userRoot must be a non-empty string');
    }
    assertSafePeerId(peerId);
    const syncRoot = path.join(userRoot, '.sync');
    const peerDir = path.join(syncRoot, peerId);
    return {
        syncRoot,
        peerDir,
        gitDir: path.join(peerDir, 'repo.git'),
        workdir: path.join(peerDir, 'workdir'),
        statePath: path.join(syncRoot, 'state.json'),
    };
}

/**
 * Create the shadow repo on disk for `(userRoot, peerId)` if it doesn't
 * already exist. Idempotent: a second call with the same args is a no-op
 * (besides re-mkdir'ing already-present dirs).
 *
 * @param {{ userRoot: string, peerId: string }} args
 * @returns {Promise<ShadowPaths>}
 */
export async function ensureShadowRepo({ userRoot, peerId }) {
    const paths = getShadowPaths({ userRoot, peerId });
    await fs.promises.mkdir(paths.workdir, { recursive: true });
    await fs.promises.mkdir(paths.gitDir, { recursive: true });

    // Detect existing repo via HEAD; a freshly mkdir'd dir won't have it.
    const headPath = path.join(paths.gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
        await git.init({ fs, dir: paths.workdir, gitdir: paths.gitDir, defaultBranch: 'main' });
        await git.setConfig({ fs, dir: paths.workdir, gitdir: paths.gitDir, path: 'user.name', value: SHADOW_AUTHOR.name });
        await git.setConfig({ fs, dir: paths.workdir, gitdir: paths.gitDir, path: 'user.email', value: SHADOW_AUTHOR.email });
    }
    return paths;
}

/**
 * Mirror the enabled-category subset of the live user data into the shadow
 * worktree, then commit if anything changed.
 *
 * The workdir layout mirrors `directories.root` exactly: a live file at
 * `<userRoot>/characters/char_001.png` lands at
 * `<workdir>/characters/char_001.png`. This 1:1 correspondence lets the
 * reverse step (`reconcileShadowToLive`, Task 5) compute its writes by simply
 * subtracting the shadow root from each relative path.
 *
 * Implementation notes:
 *   - Symlinks are skipped per spec §4.3 — both the live walker and the
 *     workdir walker treat them as non-data; the live walker emits a
 *     `console.warn` so a misconfigured user data dir is observable.
 *   - Nested `.git` directories are skipped at every depth per spec §6.4 —
 *     card-apps initialize per-character git repos and we must not pull their
 *     `.git` internals into the shadow's index.
 *   - Change detection avoids `git.statusMatrix` (whose racy-git WORKDIR
 *     comparison can collide on rapid same-second rewrites) and avoids the
 *     "commit-then-rewind" pattern (which would orphan a fresh commit object
 *     in the ODB on every no-op snapshot, and isomorphic-git has no `git
 *     gc`). Instead we force-stage every desired file, sweep the index
 *     against the desired set, then walk `[TREE(HEAD), STAGE]` and compare
 *     oids: identical → no commit, differing → one real commit. See
 *     `commitIfTreeChanged` for the full rationale.
 *
 * @param {{
 *   userRoot: string,
 *   peerId: string,
 *   directories: import('../users.js').UserDirectoryList,
 *   enabledCategoryIds: string[],
 * }} args
 * @returns {Promise<{ committed: boolean, oid: string | null }>}
 */
export async function snapshotLiveToShadow({ userRoot, peerId, directories, enabledCategoryIds }) {
    const paths = await ensureShadowRepo({ userRoot, peerId });

    const enabled = new Set(enabledCategoryIds);
    const targets = SYNC_CATEGORIES.filter(category => enabled.has(category.id));

    // desired: relative POSIX path within the shadow workdir -> absolute source on disk.
    const desired = new Map();
    for (const category of targets) {
        for (const resolved of resolveCategoryPaths(category, directories)) {
            // Spec §6.3: the `'database'` category's live source is the
            // running SQLite engine's DB file. A raw byte-copy of an open
            // WAL'd DB would either miss in-WAL writes or corrupt the
            // destination, so the orchestrator pre-places a consistent
            // `VACUUM INTO` snapshot at `<workdir>/luker-storage.sqlite`
            // BEFORE calling us. We point `desired` at THAT workdir copy
            // (instead of the live file) so `syncWorkdirToDesired`'s
            // `copyFile(src, dst)` becomes a same-path no-op rather than
            // overwriting our snapshot with a torn read of the live DB.
            //
            // The if-exists guard mirrors the file-kind branch below:
            // when the orchestrator skips the VACUUM (e.g. `fs` mode,
            // where the DB file legitimately doesn't exist), this
            // category contributes nothing to the snapshot and the
            // standard walk proceeds unchanged.
            if (category.id === 'database') {
                const rel = toPosixRel(directories.root, resolved.absolutePath);
                const workdirCopy = path.join(paths.workdir, rel);
                if (fs.existsSync(workdirCopy)) {
                    desired.set(rel, workdirCopy);
                }
                continue;
            }
            if (!fs.existsSync(resolved.absolutePath)) continue;
            if (resolved.kind === 'file') {
                const rel = toPosixRel(directories.root, resolved.absolutePath);
                desired.set(rel, resolved.absolutePath);
            } else if (resolved.kind === 'directory') {
                await walkLiveDir(resolved.absolutePath, directories.root, desired);
            }
        }
    }

    await syncWorkdirToDesired(paths.workdir, desired);
    return commitIfTreeChanged(paths.workdir, paths.gitDir);
}

/**
 * Convert an absolute file path under `userRoot` into the POSIX-style
 * relative path that isomorphic-git uses for filepaths. `path.relative` keeps
 * the host separator, so we normalize once at this boundary.
 *
 * @param {string} userRoot
 * @param {string} absolutePath
 * @returns {string}
 */
function toPosixRel(userRoot, absolutePath) {
    return path.relative(userRoot, absolutePath).split(path.sep).join('/');
}

/**
 * Recursively walk a live directory, populating `desired` with every regular
 * file beneath it. Nested `.git` directories are skipped wholesale per spec
 * §6.4. Symlinks are intentionally not part of supported user data (spec
 * §4.3); we `console.warn` so a misconfigured live tree is observable, and
 * we never follow them (which would risk chasing into arbitrary filesystem
 * locations).
 *
 * @param {string} absDir
 * @param {string} userRoot
 * @param {Map<string, string>} desired
 */
async function walkLiveDir(absDir, userRoot, desired) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
            await walkLiveDir(abs, userRoot, desired);
        } else if (entry.isFile()) {
            desired.set(toPosixRel(userRoot, abs), abs);
        } else if (entry.isSymbolicLink()) {
            console.warn('[sync] ignoring symlink at:', abs);
        }
        // other entry kinds (fifos, sockets, block/char devs) silently skipped
        // — not data, never expected under user-root, no need to warn.
    }
}

/**
 * Reconcile the workdir tree against the desired file set: any workdir file
 * not in `desired` is deleted, every desired file is copied in (overwriting
 * if present). Empty directories left behind by deletions are pruned so
 * later `git.listFiles` walks stay tidy. The shadow's `.git` lives outside
 * the workdir (split layout), so this walk has nothing to skip beyond a
 * defensive guard for any stray `.git` inside the worktree.
 *
 * Copies use `fs.copyFile` rather than atomic-rename — the workdir is
 * private to the sync process under mutex (spec §4.3) so torn writes are
 * not a concern, and `git.add` will read whichever bytes we wrote.
 *
 * @param {string} workdir
 * @param {Map<string, string>} desired
 */
async function syncWorkdirToDesired(workdir, desired) {
    if (fs.existsSync(workdir)) {
        await pruneWorkdir(workdir, '', desired);
    }
    for (const [rel, src] of desired) {
        const dst = path.join(workdir, rel);
        // SQLite-mode entry path: `snapshotLiveToShadow` points the
        // `'database'` category's `src` at the workdir copy that the
        // orchestrator already produced via `VACUUM INTO`, so `src` and
        // `dst` are the same file. `fs.copyFile` is a no-op on
        // identical paths on the platforms we ship, but the kernel
        // behaviour is OS-defined — skipping explicitly keeps the
        // semantics platform-portable and avoids the (theoretical)
        // truncate-then-copy window inside the syscall.
        if (path.resolve(src) === path.resolve(dst)) continue;
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
    }
}

/**
 * Depth-first sweep: delete any file in the workdir whose POSIX relative path
 * is not in `desired`, then `rmdir` directories that end up empty.
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {Map<string, string>} desired
 */
async function pruneWorkdir(dir, prefix, desired) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        // Defensive: the shadow's .git is a sibling of workdir, not inside it,
        // but skipping any stray .git keeps us aligned with the live walker.
        if (entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await pruneWorkdir(abs, rel, desired);
            const remaining = await fs.promises.readdir(abs);
            if (remaining.length === 0) await fs.promises.rmdir(abs);
        } else if (entry.isFile()) {
            if (!desired.has(rel)) {
                await fs.promises.unlink(abs);
            }
        }
    }
}

/**
 * Stage the entire workdir, prune stale index entries, then decide whether
 * to commit by comparing the staged index against the HEAD tree.
 *
 * The comparison walks `[TREE({ref: 'HEAD'}), STAGE()]` together. This is
 * safe to do for change detection — unlike `git.statusMatrix`, no WORKDIR
 * walker is involved, so the racy second-precision mtime heuristic that
 * collides on rapid same-second rewrites (see `IsomorphicGitClient.commit-
 * IfChanged`, commit `c4b42855e`) never comes into play. Every comparison
 * is pure tree-oid vs index-oid.
 *
 * When the trees would be identical we skip `git.commit` entirely, so the
 * ODB never accumulates orphan commit objects from no-op snapshots — this
 * matters because the sync subsystem expects to run on a poll interval and
 * isomorphic-git provides no `git gc`. Tree objects that would match an
 * existing tree are content-addressed and re-writing them is a no-op, so
 * the next "real" commit just reuses the prior tree storage anyway.
 *
 * When HEAD does not yet exist (very first snapshot in a fresh shadow),
 * `TREE({ref: 'HEAD'})` resolves to the empty-tree magic oid
 * (`4b825dc6…`); a non-empty index then differs from it and we commit
 * normally. A first snapshot with zero desired files (empty user data on
 * the synced categories) intentionally records nothing: there is no value
 * in an empty-tree initial commit and subsequent snapshots will start the
 * history the moment real content appears.
 *
 * @param {string} workdir
 * @param {string} gitdir
 * @returns {Promise<{ committed: boolean, oid: string | null }>}
 */
async function commitIfTreeChanged(workdir, gitdir) {
    const tracked = new Set();
    await collectWorkdirFiles(workdir, '', tracked);
    for (const filepath of tracked) {
        await git.add({ fs, dir: workdir, gitdir, filepath });
    }
    for (const filepath of await git.listFiles({ fs, dir: workdir, gitdir })) {
        if (!tracked.has(filepath)) {
            await git.remove({ fs, dir: workdir, gitdir, filepath });
        }
    }

    const previousHeadOid = await resolveHeadOidOrNull(workdir, gitdir);
    if (!(await indexDiffersFromHeadTree(workdir, gitdir))) {
        return { committed: false, oid: previousHeadOid };
    }

    const message = `local snapshot ${new Date(Date.now()).toISOString()}`;
    const newOid = await git.commit({ fs, dir: workdir, gitdir, message, author: SHADOW_AUTHOR });
    return { committed: true, oid: newOid };
}

/**
 * Enumerate every regular file under the workdir as POSIX-style paths
 * relative to it, skipping nested `.git` directories defensively. Symlinks
 * are intentionally excluded so the stage-then-prune symmetry holds:
 * `pruneWorkdir` only deletes `entry.isFile()`, so anything we stage here
 * that isn't a regular file would commit but never get cleaned up,
 * producing index ↔ workdir drift on the next snapshot.
 *
 * @param {string} dir
 * @param {string} prefix
 * @param {Set<string>} out
 */
async function collectWorkdirFiles(dir, prefix, out) {
    if (!fs.existsSync(dir)) return;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.git') continue;
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await collectWorkdirFiles(abs, rel, out);
        } else if (entry.isFile()) {
            out.add(rel);
        }
        // symlinks and other non-file entries skipped (see prune symmetry above).
    }
}

/**
 * Return true iff the staged index would produce a different tree from
 * HEAD's tree. Walks `[TREE(HEAD), STAGE]` together and reports a diff on
 * the first path whose presence-and-oid pair differs across the two sides.
 *
 * No WORKDIR walker is involved, so this is immune to the racy-git
 * size+mtime heuristic that makes `statusMatrix` unreliable for change
 * detection. When HEAD is absent the TREE walker reports the empty tree
 * (isomorphic-git GitWalkerRepo line ~4380), so this function correctly
 * reports `true` whenever the new index has any entries.
 *
 * @param {string} dir
 * @param {string} gitdir
 * @returns {Promise<boolean>}
 */
async function indexDiffersFromHeadTree(dir, gitdir) {
    let differs = false;
    await git.walk({
        fs,
        dir,
        gitdir,
        trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
        map: async (filepath, [head, stage]) => {
            if (differs || filepath === '.') return;
            // Presence mismatch: a file only on one side is by definition a diff.
            if (!head !== !stage) {
                differs = true;
                return;
            }
            if (!head || !stage) return;
            const [headType, stageType] = await Promise.all([head.type(), stage.type()]);
            // Skip non-blob/tree entries (commits-as-submodules, etc.) — same
            // policy as statusMatrix; we don't snapshot submodules anyway.
            if (headType === 'commit' || stageType === 'commit') return;
            if (headType !== stageType) {
                differs = true;
                return;
            }
            if (headType === 'tree') return; // recursion handled by walk()
            const [headOid, stageOid] = await Promise.all([head.oid(), stage.oid()]);
            if (headOid !== stageOid) differs = true;
        },
    });
    return differs;
}

/**
 * @param {string} dir
 * @param {string} gitdir
 * @returns {Promise<string | null>}
 */
async function resolveHeadOidOrNull(dir, gitdir) {
    try {
        return await git.resolveRef({ fs, dir, gitdir, ref: 'HEAD' });
    } catch {
        return null;
    }
}

/**
 * Mirror the shadow workdir state back into live user data. The reverse of
 * `snapshotLiveToShadow`: every regular file under an enabled category in the
 * shadow workdir is written atomically into the corresponding live path, and
 * every live file under those same categories that no longer exists in shadow
 * is deleted. Files outside the enabled categories are not touched — sync only
 * mutates what the user agreed to sync.
 *
 * Atomicity is mandatory here (spec §4.4): live data is being read by the
 * running app, so torn writes are user-visible. `write-file-atomic` writes
 * to a sibling `.tmp` and renames into place, so a crash mid-write leaves the
 * prior live file intact and a stale `.tmp` that the OS process-exit handler
 * cleans up. The shadow workdir itself is private to the sync process under
 * mutex (spec §4.3), so the read side needs no extra synchronization.
 *
 * Scoping is done by starting each walk at a category's resolved live path
 * rather than at `directories.root` and then filtering. That way an
 * out-of-scope sibling directory (e.g. `extensions/` when only `characters`
 * is enabled) is never visited at all — not just left untouched, but never
 * even read — and the deletion sweep cannot accidentally rmdir an unrelated
 * empty scaffold dir.
 *
 * Nested `.git` directories are skipped at every depth in both walks: in the
 * shadow walk that's defensive — the shadow's own `.git` is split off into
 * `paths.gitDir`, not inside the workdir — but a stray `.git` would corrupt
 * the desired set. In the live walk it implements spec §6.4 (`card-apps/`
 * already has per-character git repos we must never overwrite).
 *
 * Symlinks and other non-file entries are silently ignored on both sides,
 * matching `snapshotLiveToShadow`'s policy (spec §4.3): they aren't synced
 * data, and we don't want a symlink in live data to silently follow into a
 * deletion sweep.
 *
 * @param {{
 *   userRoot: string,
 *   peerId: string,
 *   directories: import('../users.js').UserDirectoryList,
 *   enabledCategoryIds: string[],
 * }} args
 * @returns {Promise<{ written: string[], deleted: string[] }>}
 *   `written` and `deleted` list POSIX-style relative paths (from
 *   `directories.root`). Order is unspecified beyond "matches the walk order
 *   of the respective tree".
 */
export async function reconcileShadowToLive({ userRoot, peerId, directories, enabledCategoryIds }) {
    const paths = await ensureShadowRepo({ userRoot, peerId });

    const enabled = new Set(enabledCategoryIds);
    // For each enabled category, list its live targets paired with kind so the
    // walker can dispatch directory vs file correctly.
    /** @type {{ rel: string, kind: 'file' | 'directory' }[]} */
    const liveTargets = [];
    for (const category of SYNC_CATEGORIES.filter(c => enabled.has(c.id))) {
        for (const resolved of resolveCategoryPaths(category, directories)) {
            liveTargets.push({
                rel: toPosixRel(directories.root, resolved.absolutePath),
                kind: resolved.kind,
            });
        }
    }

    // desired: POSIX-relative path within live -> absolute source path in shadow.
    // Built by walking each in-scope target inside the shadow workdir.
    const desired = new Map();
    for (const target of liveTargets) {
        const shadowTarget = path.join(paths.workdir, target.rel);
        if (!fs.existsSync(shadowTarget)) continue;
        if (target.kind === 'file') {
            desired.set(target.rel, shadowTarget);
        } else {
            await walkShadowForDesired(shadowTarget, target.rel, desired);
        }
    }

    const deleted = [];
    // Walk each target's live side and prune anything not in desired. We start
    // each walk AT the category target so unrelated siblings under
    // directories.root are never read.
    for (const target of liveTargets) {
        const liveTarget = path.join(directories.root, target.rel);
        if (!fs.existsSync(liveTarget)) continue;
        if (target.kind === 'file') {
            // A file-kind target survives if the shadow side still has it;
            // otherwise it's deleted in place. No directory pruning applies.
            if (!desired.has(target.rel)) {
                await fs.promises.unlink(liveTarget);
                deleted.push(target.rel);
            }
        } else {
            await walkLiveForDeletions(liveTarget, target.rel, desired, deleted);
        }
    }

    // Atomic-write every desired file. Writes happen AFTER deletions so that a
    // partial-failure run can still be retried: any file we've already written
    // is durable, and an interrupted write leaves the old live file intact.
    const written = [];
    for (const [rel, src] of desired) {
        const dst = path.join(directories.root, rel);
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        const data = await fs.promises.readFile(src);
        writeFileAtomicSync(dst, data);
        written.push(rel);
    }

    return { written, deleted };
}

/**
 * Walk a directory inside the shadow workdir, populating `desired` with every
 * regular file beneath it. Mirrors the policy of `walkLiveDir` (skip nested
 * `.git`, skip non-regular files), but applied to the shadow side of the
 * snapshot/reconcile pair. Caller scopes the walk by passing a category-rooted
 * directory; this function adds no further filtering.
 *
 * @param {string} absDir
 * @param {string} prefix POSIX-relative path of `absDir` from `directories.root`
 * @param {Map<string, string>} desired
 */
async function walkShadowForDesired(absDir, prefix, desired) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
        // Defensive: the shadow's .git is a sibling of workdir, not inside it,
        // but a stray .git in the workdir would taint the desired set.
        if (entry.name === '.git') continue;
        const abs = path.join(absDir, entry.name);
        // Mirror snapshot-side walkers (walkLiveDir / pruneWorkdir /
        // collectWorkdirFiles): ternary form prevents leading-slash rel paths
        // if this walker is ever entered with prefix='' — would happen if a
        // future SYNC_CATEGORIES entry resolved a directory-kind path to
        // directories.root itself. Today none do, but the asymmetry would
        // silently produce '/foo.png' style entries in the returned arrays.
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await walkShadowForDesired(abs, rel, desired);
        } else if (entry.isFile()) {
            desired.set(rel, abs);
        }
        // symlinks and other non-file entries silently skipped — same stance
        // as snapshotLiveToShadow (spec §4.3): non-data on both sides.
    }
}

/**
 * Walk a live directory belonging to a category, deleting every regular file
 * that does NOT appear in `desired`, and pruning subdirectories that end up
 * empty. The category root directory itself is left alone even when fully
 * empty — apps that re-create it on next launch should not have to also
 * create it on next reconcile.
 *
 * @param {string} absDir
 * @param {string} prefix POSIX-relative path of `absDir` from `directories.root`
 * @param {Map<string, string>} desired
 * @param {string[]} deleted
 */
async function walkLiveForDeletions(absDir, prefix, desired, deleted) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
        // Spec §6.4: card-apps and any other live directory may host
        // per-content git repos we must never touch.
        if (entry.name === '.git') continue;
        const abs = path.join(absDir, entry.name);
        // Mirror snapshot-side walkers (see walkShadowForDesired): ternary
        // form prevents leading-slash rel paths if this walker is ever entered
        // with prefix='' (no current category resolves to directories.root,
        // but defensive symmetry with the snapshot walkers).
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            await walkLiveForDeletions(abs, rel, desired, deleted);
            const remaining = await fs.promises.readdir(abs);
            if (remaining.length === 0) {
                await fs.promises.rmdir(abs);
            }
        } else if (entry.isFile()) {
            if (!desired.has(rel)) {
                await fs.promises.unlink(abs);
                deleted.push(rel);
            }
        }
        // symlinks and other non-file entries: not synced data; leave alone.
    }
}
