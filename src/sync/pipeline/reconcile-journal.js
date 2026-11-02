import fs from 'node:fs';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';

import { getShadowPaths } from '../shadow.js';

/**
 * Intent log for reconciling live data from commit `base` to commit
 * `target` over `categories`. It is written before the first live write
 * and deleted after `main` has moved, so a journal found at start means a
 * reconcile was interrupted and must run again with the same pair and
 * categories. A version 1 journal predates the category list and reads
 * with `categories: null`. `advanceOnSkip` makes main move to `target`
 * even when paths are skipped; a journal without it reads as false.
 */
export const JOURNAL_FILENAME = 'reconcile-journal.json';
const JOURNAL_VERSION = 2;
const JOURNAL_VERSION_WITHOUT_CATEGORIES = 1;
const OID_PATTERN = /^[a-f0-9]{40}$/;

/**
 * @param {{ userRoot: string, backendId: string }} args
 * @returns {string}
 */
export function journalPath({ userRoot, backendId }) {
    return path.join(getShadowPaths({ userRoot, peerId: backendId }).peerDir, JOURNAL_FILENAME);
}

const isCategoryList = value => Array.isArray(value) && value.every(id => typeof id === 'string');

/**
 * @param {{ userRoot: string, backendId: string, base: string | null, target: string, categories: string[], advanceOnSkip?: boolean }} args
 */
export async function writeReconcileJournal({ userRoot, backendId, base, target, categories, advanceOnSkip = false }) {
    if (base !== null && !OID_PATTERN.test(String(base))) throw new TypeError(`reconcile journal: invalid base ${JSON.stringify(base)}`);
    if (!OID_PATTERN.test(String(target))) throw new TypeError(`reconcile journal: invalid target ${JSON.stringify(target)}`);
    if (!isCategoryList(categories)) throw new TypeError(`reconcile journal: invalid categories ${JSON.stringify(categories)}`);
    if (typeof advanceOnSkip !== 'boolean') throw new TypeError(`reconcile journal: invalid advanceOnSkip ${JSON.stringify(advanceOnSkip)}`);
    const file = journalPath({ userRoot, backendId });
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ version: JOURNAL_VERSION, base, target, categories: [...categories], ...(advanceOnSkip ? { advanceOnSkip } : {}) }), { encoding: 'utf8' });
}

/**
 * @param {{ userRoot: string, backendId: string }} args
 * @returns {{ base: string | null, target: string, categories: string[] | null, advanceOnSkip: boolean } | null}
 */
export function readReconcileJournal({ userRoot, backendId }) {
    const file = journalPath({ userRoot, backendId });
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    const parsed = JSON.parse(raw);
    const baseOk = parsed?.base === null || OID_PATTERN.test(String(parsed?.base));
    const legacy = parsed?.version === JOURNAL_VERSION_WITHOUT_CATEGORIES;
    const categoriesOk = legacy || (parsed?.version === JOURNAL_VERSION && isCategoryList(parsed.categories));
    const advanceOk = parsed?.advanceOnSkip === undefined || typeof parsed.advanceOnSkip === 'boolean';
    if (!parsed || !categoriesOk || !baseOk || !advanceOk || !OID_PATTERN.test(String(parsed.target))) {
        throw new Error(`reconcile journal at ${file} has an unexpected shape`);
    }
    return { base: parsed.base, target: parsed.target, categories: legacy ? null : parsed.categories, advanceOnSkip: parsed.advanceOnSkip === true };
}

/**
 * @param {{ userRoot: string, backendId: string }} args
 */
export async function deleteReconcileJournal({ userRoot, backendId }) {
    await fs.promises.rm(journalPath({ userRoot, backendId }), { force: true });
}
