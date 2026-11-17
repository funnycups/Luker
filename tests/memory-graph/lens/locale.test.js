import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from '@jest/globals';
import { registerLocaleData } from '../../../public/scripts/extensions/memory-graph/i18n.js';
import { registerLensSharedLocaleData } from '../../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../public/scripts/workbench/locale-data.js';

const ROOT = path.resolve(process.cwd(), '..');

function collectLocaleTables(registerFn) {
    const tables = { 'zh-cn': {}, 'zh-tw': {} };
    registerFn((locale, map) => {
        if (locale === 'zh-cn' || locale === 'zh-tw') {
            Object.assign(tables[locale], map);
        }
    });
    return tables;
}

describe('memory-graph unified i18n hygiene', () => {
    const mgTables = collectLocaleTables(registerLocaleData);
    const cnKeys = Object.keys(mgTables['zh-cn']);
    const twKeys = Object.keys(mgTables['zh-tw']);

    test('split lens/locale-data.js is removed in favor of single memory-graph/i18n.js', () => {
        expect(fs.existsSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/lens/locale-data.js'))).toBe(false);
    });

    test('100% EN / zh-CN / zh-TW key parity', () => {
        expect(cnKeys.length).toBeGreaterThan(0);
        expect(twKeys.filter(k => !Object.hasOwn(mgTables['zh-cn'], k))).toEqual([]);
        expect(cnKeys.filter(k => !Object.hasOwn(mgTables['zh-tw'], k))).toEqual([]);
    });

    test('zh-CN and zh-TW values use full-width CJK punctuation', () => {
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;
        const badCn = cnKeys.filter(k => halfWidthCjk.test(mgTables['zh-cn'][k])).map(k => [k, mgTables['zh-cn'][k]]);
        const badTw = twKeys.filter(k => halfWidthCjk.test(mgTables['zh-tw'][k])).map(k => [k, mgTables['zh-tw'][k]]);
        expect(badCn).toEqual([]);
        expect(badTw).toEqual([]);
    });

    test('all i18n/i18nFormat literals in memory-graph/lens/** resolve in zh-CN/zh-TW and have no unescaped semicolons', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const lensShared = collectLocaleTables(registerLensSharedLocaleData);
        const workbench = collectLocaleTables(registerWorkbenchLocaleData);

        const hasCn = k => (
            Object.hasOwn(mgTables['zh-cn'], k)
            || Object.hasOwn(zhCnCore, k)
            || Object.hasOwn(lensShared['zh-cn'], k)
            || Object.hasOwn(workbench['zh-cn'], k)
        );
        const hasTw = k => (
            Object.hasOwn(mgTables['zh-tw'], k)
            || Object.hasOwn(zhTwCore, k)
            || Object.hasOwn(lensShared['zh-tw'], k)
            || Object.hasOwn(workbench['zh-tw'], k)
        );

        const lensDir = path.join(ROOT, 'public/scripts/extensions/memory-graph/lens');
        const jsFiles = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) jsFiles.push(full);
            }
        };
        walk(lensDir);

        const usedKeys = new Set();
        const callRe = /\bi18n(?:Format)?\(\s*'((?:\\'|[^'])+)'|\bi18n(?:Format)?\(\s*"((?:\\"|[^"])+)"/g;
        for (const file of jsFiles) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(callRe)) {
                const raw = m[1] !== undefined
                    ? m[1].replace(/\\'/g, '\'').replace(/\\\\/g, '\\')
                    : m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
                usedKeys.add(raw);
            }
        }

        const semicolonKeys = [...usedKeys].filter(k => /(?<!\\);/.test(k));
        const missingCn = [...usedKeys].filter(k => !hasCn(k));
        const missingTw = [...usedKeys].filter(k => !hasTw(k));

        expect(semicolonKeys).toEqual([]);
        expect(missingCn).toEqual([]);
        expect(missingTw).toEqual([]);
    });

    test('all i18n/i18nFormat literals in memory-graph/main.js resolve synchronously from memory-graph/i18n.js + core locales', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));

        const mainSrc = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/main.js'), 'utf8');
        const usedKeys = new Set();
        const callRe = /\bi18n(?:Format)?\(\s*'((?:\\'|[^'])+)'|\bi18n(?:Format)?\(\s*"((?:\\"|[^"])+)"/g;
        for (const m of mainSrc.matchAll(callRe)) {
            const raw = m[1] !== undefined
                ? m[1].replace(/\\'/g, '\'').replace(/\\\\/g, '\\')
                : m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            usedKeys.add(raw);
        }

        const missingCn = [...usedKeys].filter(k => !Object.hasOwn(mgTables['zh-cn'], k) && !Object.hasOwn(zhCnCore, k));
        const missingTw = [...usedKeys].filter(k => !Object.hasOwn(mgTables['zh-tw'], k) && !Object.hasOwn(zhTwCore, k));

        expect(missingCn).toEqual([]);
        expect(missingTw).toEqual([]);
    });
});
