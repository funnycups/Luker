import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

/**
 * @typedef {Object} ConflictEntry
 * @property {string} filepath
 * @property {'bothModified' | 'deleteByUs' | 'deleteByTheirs'} kind
 * @property {string | null} oursOid - blob oid on the `ours` side (null if our side deleted)
 * @property {string | null} theirsOid - blob oid on the `theirs` side (null if their side deleted)
 */

/**
 * `gitdir` is optional so existing call sites that use the conventional
 * `<dir>/.git` layout (the conflict unit tests) work unchanged; the sync
 * shadow uses a split layout (`<peerDir>/workdir` + `<peerDir>/repo.git`),
 * so the orchestrator must pass `gitdir` explicitly. Every internal git
 * call in this module forwards `gitdir` for the same reason.
 *
 * @param {{ dir: string, gitdir?: string, ours: string, theirs: string, author: { name: string, email: string } }} args
 * @returns {Promise<{ success: true, conflicts: [], mergeOid: string } | { success: false, conflicts: ConflictEntry[] }>}
 */
export async function attemptMerge({ dir, gitdir, ours, theirs, author }) {
    try {
        const result = await git.merge({ fs, dir, gitdir, ours, theirs, author, abortOnConflict: false });
        return { success: true, conflicts: [], mergeOid: result.oid };
    } catch (e) {
        if (e.code === 'MergeConflictError') {
            const conflicts = await collectConflicts({ dir, gitdir, ours, theirs, data: e.data });
            return { success: false, conflicts };
        }
        // `MergeNotSupportedError` fires on strictly-linear or no-common-
        // ancestor merges that git.merge cannot resolve as a 3-way. The
        // orchestrator has already short-circuited the ancestor-prefix
        // cases (fast-forward forward/backward and already-in-sync) via
        // `isAncestor`, so reaching this branch means there really is no
        // common ancestor — typically because both sides created their
        // first commit independently before being paired.
        //
        // Two sub-cases:
        //   - Trees diverge on at least one file → return the symmetric
        //     diff as a conflict set so the UI prompts the user to pick.
        //   - Trees are IDENTICAL despite the divergent commit history
        //     (both sides made root commits of the same seed `data/`,
        //     common in fresh-pair test fixtures) → there is nothing to
        //     resolve. Produce the two-parent merge commit ourselves
        //     and return success so the orchestrator continues to push
        //     and reconcile.
        if (e.code === 'MergeNotSupportedError') {
            const conflicts = await collectNoCommonAncestorConflicts({ dir, gitdir, ours, theirs });
            if (conflicts.length === 0) {
                const mergeOid = await mergeIdenticalTreesNoAncestor({
                    dir, gitdir, ours, theirs, author,
                });
                return { success: true, conflicts: [], mergeOid };
            }
            return { success: false, conflicts };
        }
        throw e;
    }
}

/**
 * When two no-common-ancestor branches have identical trees, the only
 * thing missing is the merge commit that records "these two histories
 * converged". Build it explicitly: same tree as `ours`, both heads as
 * parents, advance `ours` to point at the new merge commit. The workdir
 * is already in the right state since `git.merge` was abortOnConflict
 * false and never touched files when it threw.
 */
async function mergeIdenticalTreesNoAncestor({ dir, gitdir, ours, theirs, author }) {
    const oursOid = await git.resolveRef({ fs, dir, gitdir, ref: ours });
    const theirsOid = await git.resolveRef({ fs, dir, gitdir, ref: theirs });
    const oursCommit = await git.readCommit({ fs, dir, gitdir, oid: oursOid });
    const mergeOid = await git.commit({
        fs, dir, gitdir,
        message: `merge ${theirs} into ${ours} (identical trees, no common ancestor)`,
        author,
        parent: [oursOid, theirsOid],
        tree: oursCommit.commit.tree,
    });
    await git.writeRef({ fs, dir, gitdir, ref: `refs/heads/${ours}`, value: mergeOid, force: true });
    return mergeOid;
}

/**
 * When two branches share no common ancestor (both are root commits),
 * the symmetric difference IS the conflict set: every file present on
 * exactly one side is a "deleteByX" pick; every file present on both
 * with different blob oids is a "bothModified" pick. Files identical
 * on both sides need no resolution.
 *
 * Returned shape matches `collectConflicts` so the orchestrator's caller
 * (UI) handles both paths uniformly.
 */
async function collectNoCommonAncestorConflicts({ dir, gitdir, ours, theirs }) {
    const oursOid = await git.resolveRef({ fs, dir, gitdir, ref: ours });
    const theirsOid = await git.resolveRef({ fs, dir, gitdir, ref: theirs });
    const oursFiles = await listFilesAtTree(dir, gitdir, oursOid);
    const theirsFiles = await listFilesAtTree(dir, gitdir, theirsOid);
    const all = new Set([...Object.keys(oursFiles), ...Object.keys(theirsFiles)]);
    const out = [];
    for (const fp of all) {
        const o = oursFiles[fp];
        const t = theirsFiles[fp];
        if (o && !t) {
            out.push({ filepath: fp, kind: 'deleteByTheirs', oursOid: o, theirsOid: null });
        } else if (!o && t) {
            out.push({ filepath: fp, kind: 'deleteByUs', oursOid: null, theirsOid: t });
        } else if (o && t && o !== t) {
            out.push({ filepath: fp, kind: 'bothModified', oursOid: o, theirsOid: t });
        }
        // o === t: same blob, no conflict.
    }
    return out;
}

async function listFilesAtTree(dir, gitdir, commitOid) {
    const out = {};
    const commit = await git.readCommit({ fs, dir, gitdir, oid: commitOid });
    await walkTreeForFiles(dir, gitdir, commit.commit.tree, '', out);
    return out;
}

async function walkTreeForFiles(dir, gitdir, treeOid, prefix, out) {
    const tree = await git.readTree({ fs, dir, gitdir, oid: treeOid });
    for (const entry of tree.tree) {
        const fp = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'tree') {
            await walkTreeForFiles(dir, gitdir, entry.oid, fp, out);
        } else if (entry.type === 'blob') {
            out[fp] = entry.oid;
        }
    }
}

async function collectConflicts({ dir, gitdir, ours, theirs, data }) {
    const oursOid = await git.resolveRef({ fs, dir, gitdir, ref: ours });
    const theirsOid = await git.resolveRef({ fs, dir, gitdir, ref: theirs });

    const out = [];
    for (const fp of data.bothModified ?? []) {
        const o = await blobIfPresent(dir, gitdir, oursOid, fp);
        const t = await blobIfPresent(dir, gitdir, theirsOid, fp);
        out.push({
            filepath: fp,
            kind: 'bothModified',
            oursOid: o?.oid ?? null,
            theirsOid: t?.oid ?? null,
        });
    }
    for (const fp of data.deleteByUs ?? []) {
        const t = await blobIfPresent(dir, gitdir, theirsOid, fp);
        out.push({
            filepath: fp,
            kind: 'deleteByUs',
            oursOid: null,
            theirsOid: t?.oid ?? null,
        });
    }
    for (const fp of data.deleteByTheirs ?? []) {
        const o = await blobIfPresent(dir, gitdir, oursOid, fp);
        out.push({
            filepath: fp,
            kind: 'deleteByTheirs',
            oursOid: o?.oid ?? null,
            theirsOid: null,
        });
    }
    return out;
}

/**
 * Apply per-file picks and produce a two-parent merge commit.
 *
 * isomorphic-git's `git.merge` only stages bothModified / clean-merge /
 * delete-by-X cases; files added on only one side are never written to the
 * index. If we just `git.add` the files in `picks` and commit, every
 * unique-side addition silently disappears from the merged tree.
 *
 * To prevent that data loss we rebuild the index ourselves: walk the union of
 * both side trees, pre-stage every non-conflict file with the correct blob,
 * then overlay the user's picks on top.
 *
 * `gitdir` is optional for backward compatibility with the existing unit
 * tests' default `<dir>/.git` layout; the sync shadow uses split layout and
 * the orchestrator passes it explicitly. See `attemptMerge` above for the
 * full rationale.
 *
 * @param {{
 *   dir: string,
 *   gitdir?: string,
 *   ours: string,
 *   theirs: string,
 *   author: { name: string, email: string },
 *   picks: Record<string, 'ours' | 'theirs'>,
 * }} args
 * @returns {Promise<string>} new merge commit oid
 */
export async function applyResolutions({ dir, gitdir, ours, theirs, author, picks }) {
    const oursOid = await git.resolveRef({ fs, dir, gitdir, ref: ours });
    const theirsOid = await git.resolveRef({ fs, dir, gitdir, ref: theirs });

    const oursFiles = await git.listFiles({ fs, dir, gitdir, ref: oursOid });
    const theirsFiles = await git.listFiles({ fs, dir, gitdir, ref: theirsOid });
    const allFiles = new Set([...oursFiles, ...theirsFiles]);
    const pickedPaths = new Set(Object.keys(picks));

    for (const filepath of allFiles) {
        if (pickedPaths.has(filepath)) continue;

        const oursBlob = await blobIfPresent(dir, gitdir, oursOid, filepath);
        const theirsBlob = await blobIfPresent(dir, gitdir, theirsOid, filepath);

        if (oursBlob && theirsBlob) {
            if (oursBlob.oid === theirsBlob.oid) {
                await writeAndStage(dir, gitdir, filepath, oursBlob.blob);
            } else {
                // bothModified path not in picks — caller missed a conflict.
                throw new Error(`Unresolved conflict: ${filepath} differs on both sides but is not in picks`);
            }
        } else if (oursBlob) {
            await writeAndStage(dir, gitdir, filepath, oursBlob.blob);
        } else if (theirsBlob) {
            await writeAndStage(dir, gitdir, filepath, theirsBlob.blob);
        }
    }

    // Apply picks. Overwrites any pre-staged version of conflict files.
    for (const [filepath, side] of Object.entries(picks)) {
        const sideOid = side === 'ours' ? oursOid : theirsOid;
        const blob = await blobIfPresent(dir, gitdir, sideOid, filepath);
        const abs = path.join(dir, filepath);
        if (blob === null) {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
            await git.remove({ fs, dir, gitdir, filepath });
        } else {
            await writeAndStage(dir, gitdir, filepath, blob.blob);
        }
    }

    const mergeOid = await git.commit({
        fs, dir, gitdir,
        message: `merge ${theirs} into ${ours} (manual resolution)`,
        author,
        parent: [oursOid, theirsOid],
    });
    await git.writeRef({ fs, dir, gitdir, ref: `refs/heads/${ours}`, value: mergeOid, force: true });
    return mergeOid;
}

async function blobIfPresent(dir, gitdir, ref, filepath) {
    try {
        return await git.readBlob({ fs, dir, gitdir, oid: ref, filepath });
    } catch (e) {
        if (e.code === 'NotFoundError') return null;
        throw e;
    }
}

async function writeAndStage(dir, gitdir, filepath, blobBytes) {
    const abs = path.join(dir, filepath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, Buffer.from(blobBytes));
    await git.add({ fs, dir, gitdir, filepath });
}
