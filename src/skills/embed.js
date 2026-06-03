import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';

/**
 * Embed payload pack / extract.
 *
 * Embed payload is the transport form of one or more skills inside a preset
 * JSON or character card JSON (extensions.luker.embedded_skills_source).
 *
 * Two bundle formats:
 *   - inline-files-v1: pure UTF-8 text, small skill — files[] inlined as strings.
 *   - archive-base64-v1: binary or large — single base64 zip with sha256.
 *
 * `auto` mode picks inline when every file is UTF-8 text under per-file size
 * limit and total file count is small; otherwise falls back to archive.
 */

const INLINE_THRESHOLDS = {
    fileCount: 10,
    perFileBytes: 64 * 1024,
};

/**
 * Pack one or more skills from a scope into an embed payload.
 * @param {object} opts
 * @param {object} opts.repository - SkillRepository instance.
 * @param {object} opts.scope - source scope.
 * @param {string[]} opts.names - skill names to pack.
 * @param {'inline-files-v1'|'archive-base64-v1'|'auto'} [opts.mode='auto']
 * @returns {Promise<{version:1, items:Array}>}
 */
export async function packEmbedPayload({ repository, scope, names, mode = 'auto' }) {
    if (!Array.isArray(names) || names.length === 0) {
        throw new Error('names[] required');
    }
    const items = [];
    for (const name of names) {
        items.push(await packOne(repository, scope, name, mode));
    }
    return { version: 1, items };
}

async function packOne(repository, scope, name, mode) {
    const files = await repository.listFiles({ scope, name });
    if (files.length === 0) throw new Error(`skill ${name} has no files`);

    const canInline =
        files.length <= INLINE_THRESHOLDS.fileCount &&
        files.every(f => !f.isBinary && f.buffer.length <= INLINE_THRESHOLDS.perFileBytes);

    const useInline =
        mode === 'inline-files-v1' ||
        (mode === 'auto' && canInline);

    if (useInline) {
        return {
            bundleFormat: 'inline-files-v1',
            name,
            files: files.map(f => ({
                path: f.path,
                encoding: 'utf8',
                content: f.buffer.toString('utf8'),
            })),
        };
    }

    const zip = new AdmZip();
    for (const f of files) {
        zip.addFile(f.path, f.buffer);
    }
    const archiveBuf = zip.toBuffer();
    return {
        bundleFormat: 'archive-base64-v1',
        name,
        fileName: `${name}.zip`,
        contentBase64: archiveBuf.toString('base64'),
        sha256: createHash('sha256').update(archiveBuf).digest('hex'),
    };
}

/**
 * Parse and validate an embed payload structure.
 * @returns {Promise<Array>} items[] ready for materialization.
 */
export async function parseEmbedPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('embed payload must be an object');
    }
    if (payload.version !== 1) {
        throw new Error(`unsupported embed payload version: ${payload.version}`);
    }
    if (!Array.isArray(payload.items)) {
        throw new Error('embed payload missing items[]');
    }
    return payload.items;
}

/**
 * Materialize embed payload into a target scope on the repository.
 *
 * On failure, throws after installing earlier items; the error carries
 * `.installed` / `.skipped` / `.failedAt` for caller-side recovery.
 *
 * @param {object} opts
 * @param {object} opts.repository
 * @param {object} opts.payload - embed payload.
 * @param {object} opts.targetScope - destination scope.
 * @param {object} [opts.conflictStrategies] - { [skillName]: 'skip' | 'replace' }
 * @returns {Promise<{installed:string[], skipped:string[]}>}
 */
export async function materializeFromEmbed({ repository, payload, targetScope, conflictStrategies = {} }) {
    const items = await parseEmbedPayload(payload);
    const installed = [];
    const skipped = [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || !item.name) {
            const err = new Error('embed item missing name');
            err.installed = [...installed];
            err.skipped = [...skipped];
            err.failedAt = item && item.name ? item.name : null;
            throw err;
        }
        try {
            const files = await itemToFiles(item);
            const strategy = conflictStrategies[item.name];
            const r = await repository.install({
                scope: targetScope,
                payload: { files },
                conflictStrategy: strategy,
            });
            if (r.action === 'skipped' || r.action === 'already_installed') {
                skipped.push(item.name);
            } else {
                installed.push(item.name);
            }
        } catch (e) {
            const err = new Error(`materialize ${item.name}: ${e.message}`);
            err.installed = [...installed];
            err.skipped = [...skipped];
            err.failedAt = item.name;
            throw err;
        }
    }
    return { installed, skipped };
}

async function itemToFiles(item) {
    if (item.bundleFormat === 'inline-files-v1') {
        if (!Array.isArray(item.files)) {
            throw new Error(`item ${item.name} missing files[]`);
        }
        return item.files;
    }
    if (item.bundleFormat === 'archive-base64-v1') {
        if (typeof item.contentBase64 !== 'string') {
            throw new Error(`item ${item.name} missing contentBase64`);
        }
        const buf = Buffer.from(item.contentBase64, 'base64');
        if (item.sha256) {
            const actual = createHash('sha256').update(buf).digest('hex');
            if (actual !== item.sha256) {
                throw new Error(`sha256 mismatch for ${item.name}`);
            }
        }
        const zip = new AdmZip(buf);
        return zip.getEntries()
            .filter(e => !e.isDirectory)
            .map(e => ({
                path: e.entryName,
                encoding: 'base64',
                content: e.getData().toString('base64'),
            }));
    }
    throw new Error(`unsupported bundleFormat: ${item.bundleFormat}`);
}

/**
 * Compute the install hash an embed item would produce when materialized.
 *
 * Mirrors `computePayloadHash` in repository.js so `extract-embed/preview`
 * can compare against an existing skill's `installedHash` without running
 * the install. The algorithm is sha256 over
 *   sorted-by-path: <path>\0<sha256(buffer)>\0
 * which is the same shape as both repository.computePayloadHash (preview
 * side) and repository.hashFiles (installed side), so a 'same' verdict
 * here will round-trip to an `already_installed` action on execute.
 *
 * Archive-base64-v1 items must be cracked open here too — the installed
 * hash is computed over decoded zip entries, not the outer zip blob.
 *
 * @param {object} item - one entry from a parsed embed payload.
 * @returns {Promise<string>} hex sha256.
 */
export async function computeEmbedItemHash(item) {
    const files = await itemToFiles(item);
    const decoded = files.map(f => {
        const enc = String(f.encoding || 'utf8').toLowerCase();
        let buf;
        if (enc === 'utf8' || enc === 'utf-8') buf = Buffer.from(f.content, 'utf8');
        else if (enc === 'base64') buf = Buffer.from(f.content, 'base64');
        else throw new Error(`unsupported file encoding: ${enc}`);
        return { path: f.path, buf };
    });
    decoded.sort((a, b) => a.path.localeCompare(b.path));
    const h = createHash('sha256');
    for (const { path, buf } of decoded) {
        h.update(path); h.update('\0');
        h.update(createHash('sha256').update(buf).digest('hex')); h.update('\0');
    }
    return h.digest('hex');
}
