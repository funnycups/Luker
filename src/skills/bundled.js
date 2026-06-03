import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSkillRepository } from './repository.js';
import { parseSkillFrontmatter } from './frontmatter-parser.js';

/**
 * Bundled-skill mirror logic.
 *
 * Luker ships a set of default global skills under default/skills/global/.
 * On fresh install we copy them into the user's data root; users can also
 * trigger a re-import explicitly (which overwrites same-named skills).
 */

/**
 * On fresh install (user skills/global/ missing or empty), populate from
 * defaultRoot/skills/global/. Does nothing if the user dir already has skills.
 *
 * Always returns `{ populated, installed, replaced }` so callers don't need
 * to branch on the result shape.
 *
 * @param {object} opts
 * @param {string} opts.defaultRoot - root containing skills/global/.
 * @param {string} opts.userRoot - user data root.
 * @returns {Promise<{populated:boolean, installed:number, replaced:number}>}
 */
export async function ensureFreshInstallPopulate({ defaultRoot, userRoot }) {
    const userGlobal = join(userRoot, 'skills/global');
    const isDir = await fs.stat(userGlobal).then(s => s.isDirectory()).catch(() => false);
    if (isDir) {
        const items = await fs.readdir(userGlobal);
        if (items.length > 0) return { populated: false, installed: 0, replaced: 0 };
    }
    const repository = createSkillRepository(userRoot);
    const result = await importBundledSkills({ defaultRoot, repository });
    return { populated: true, ...result };
}

/**
 * Explicit "Import bundled" button backend.
 * Overwrites all same-named global skills with bundled versions; adds new ones.
 *
 * @param {object} opts
 * @param {string} opts.defaultRoot - root containing skills/global/.
 * @param {object} opts.repository - SkillRepository instance.
 * @returns {Promise<{installed:number, replaced:number}>}
 */
export async function importBundledSkills({ defaultRoot, repository }) {
    const defaultGlobal = join(defaultRoot, 'skills/global');
    const items = (await fs.readdir(defaultGlobal).catch(() => [])).sort();
    let installed = 0;
    let replaced = 0;
    for (const name of items) {
        const skillDir = join(defaultGlobal, name);
        const stat = await fs.stat(skillDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;
        const files = await collectFilesAsPayload(skillDir);
        const result = await repository.install({
            scope: { kind: 'global' },
            payload: { files },
            conflictStrategy: 'replace',
        });
        if (result.action === 'replaced') replaced++;
        else if (result.action === 'installed') installed++;
    }
    return { installed, replaced };
}

async function collectFilesAsPayload(rootDir) {
    const out = [];
    async function recurse(rel) {
        const abs = rel ? join(rootDir, rel) : rootDir;
        const entries = await fs.readdir(abs, { withFileTypes: true });
        for (const e of entries) {
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                await recurse(relPath);
            } else if (e.isFile()) {
                const buf = await fs.readFile(join(abs, e.name));
                const isText = !buf.includes(0);
                out.push(isText
                    ? { path: relPath, encoding: 'utf8', content: buf.toString('utf8') }
                    : { path: relPath, encoding: 'base64', content: buf.toString('base64') });
            }
        }
    }
    await recurse('');
    return out;
}

/**
 * Build a manifest describing every skill under `defaultRoot/skills/global/`.
 *
 * Each entry's `installedHash` is computed using the same algorithm as
 * `repository.install` (sha256 over sorted `<path>\0<sha256(buffer)>\0`) so
 * the client can compare it directly against the `installedHash` field on a
 * skill returned by `context.skills.list({scope:'global'})`:
 *   - hashes match    → installed_match (bundled version already on disk)
 *   - hashes differ   → installed_differ (local copy was edited or older)
 *   - no installed    → not_installed
 *
 * Returns `[]` (not an error) when the directory is missing — the user-facing
 * Browse bundled tab should render an empty state rather than a 5xx toast.
 *
 * Each entry also surfaces `description` (parsed from SKILL.md frontmatter,
 * empty string when missing) and `fileCount` + `totalBytes` so the bundled-
 * browser row can render a meta line matching the installed-skill rows.
 *
 * @param {object} opts
 * @param {string} opts.defaultRoot - root containing skills/global/.
 * @returns {Promise<Array<{name:string, installedHash:string, fileCount:number, totalBytes:number, description:string}>>}
 */
export async function buildBundledManifest({ defaultRoot }) {
    const defaultGlobal = join(defaultRoot, 'skills/global');
    const items = (await fs.readdir(defaultGlobal).catch(() => [])).sort();
    const out = [];
    for (const name of items) {
        const skillDir = join(defaultGlobal, name);
        const stat = await fs.stat(skillDir).catch(() => null);
        if (!stat || !stat.isDirectory()) continue;
        const files = await walkSkillFiles(skillDir);
        if (files.length === 0) continue;
        // Description is best-effort: a malformed SKILL.md should not crash the
        // whole manifest. We surface "" and let the manager UI explain.
        let description = '';
        const skillMd = files.find(f => f.relPath === 'SKILL.md');
        if (skillMd) {
            try {
                const text = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8');
                description = String(parseSkillFrontmatter(text).description || '');
            } catch {
                description = '';
            }
        }
        out.push({
            name,
            installedHash: hashFiles(files),
            fileCount: files.length,
            totalBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
            description,
        });
    }
    return out;
}

async function walkSkillFiles(skillDir) {
    const out = [];
    async function recurse(rel) {
        const abs = rel ? join(skillDir, rel) : skillDir;
        const entries = await fs.readdir(abs, { withFileTypes: true });
        for (const e of entries) {
            const relPath = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) await recurse(relPath);
            else if (e.isFile()) {
                const buf = await fs.readFile(join(abs, e.name));
                out.push({
                    relPath,
                    sizeBytes: buf.length,
                    sha256: createHash('sha256').update(buf).digest('hex'),
                });
            }
        }
    }
    await recurse('');
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
}

function hashFiles(files) {
    const h = createHash('sha256');
    for (const f of files) {
        h.update(f.relPath); h.update('\0');
        h.update(f.sha256); h.update('\0');
    }
    return h.digest('hex');
}
