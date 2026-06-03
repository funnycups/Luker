import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createSkillRepository } from './repository.js';

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
