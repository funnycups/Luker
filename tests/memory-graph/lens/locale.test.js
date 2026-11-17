import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from '@jest/globals';
import { registerLensLocaleData } from '../../../public/scripts/extensions/memory-graph/lens/locale-data.js';
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

describe('memory-graph/lens locale-data hygiene', () => {
    const lensTables = collectLocaleTables(registerLensLocaleData);
    const cnKeys = Object.keys(lensTables['zh-cn']);
    const twKeys = Object.keys(lensTables['zh-tw']);

    test('100% EN / zh-CN / zh-TW key parity', () => {
        expect(cnKeys.length).toBeGreaterThan(0);
        expect(twKeys.filter(k => !(k in lensTables['zh-cn']))).toEqual([]);
        expect(cnKeys.filter(k => !(k in lensTables['zh-tw']))).toEqual([]);
    });

    test('0 unescaped semicolons in English keys', () => {
        const bad = cnKeys.filter(k => /(?<!\\);/.test(k));
        expect(bad).toEqual([]);
    });

    test('zh-CN and zh-TW values use full-width CJK punctuation', () => {
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;
        const badCn = cnKeys.filter(k => halfWidthCjk.test(lensTables['zh-cn'][k])).map(k => [k, lensTables['zh-cn'][k]]);
        const badTw = twKeys.filter(k => halfWidthCjk.test(lensTables['zh-tw'][k])).map(k => [k, lensTables['zh-tw'][k]]);
        expect(badCn).toEqual([]);
        expect(badTw).toEqual([]);
    });

    test('0 key collisions with core locales, memory-graph/i18n.js, lens-shared, and workbench', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const lensShared = collectLocaleTables(registerLensSharedLocaleData);
        const workbench = collectLocaleTables(registerWorkbenchLocaleData);

        const mgI18nPath = path.join(ROOT, 'public/scripts/extensions/memory-graph/i18n.js');
        const mgI18nSource = fs.readFileSync(mgI18nPath, 'utf8');
        const cnSectionMatch = /addLocaleData\('zh-cn',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        const twSectionMatch = /addLocaleData\('zh-tw',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        const mgCnKeys = new Set();
        const mgTwKeys = new Set();
        for (const m of (cnSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgCnKeys.add(m[1].replace(/\\'/g, '\''));
        }
        for (const m of (twSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgTwKeys.add(m[1].replace(/\\'/g, '\''));
        }

        const cnCollisions = cnKeys.filter(k =>
            Object.hasOwn(zhCnCore, k)
            || Object.hasOwn(lensShared['zh-cn'], k)
            || Object.hasOwn(workbench['zh-cn'], k)
            || mgCnKeys.has(k),
        );
        const twCollisions = twKeys.filter(k =>
            Object.hasOwn(zhTwCore, k)
            || Object.hasOwn(lensShared['zh-tw'], k)
            || Object.hasOwn(workbench['zh-tw'], k)
            || mgTwKeys.has(k),
        );

        expect(cnCollisions).toEqual([]);
        expect(twCollisions).toEqual([]);
    });

    test('all i18n/i18nFormat literals in memory-graph/lens/** resolve in zh-CN/zh-TW and have no unescaped semicolons', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const lensShared = collectLocaleTables(registerLensSharedLocaleData);
        const workbench = collectLocaleTables(registerWorkbenchLocaleData);

        const mgI18nSource = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/i18n.js'), 'utf8');
        const mgCn = {};
        const mgTw = {};
        const cnSectionMatch = /addLocaleData\('zh-cn',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        const twSectionMatch = /addLocaleData\('zh-tw',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        for (const m of (cnSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgCn[m[1].replace(/\\'/g, '\'')] = true;
        }
        for (const m of (twSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgTw[m[1].replace(/\\'/g, '\'')] = true;
        }

        const hasCn = k => (
            Object.hasOwn(lensTables['zh-cn'], k)
            || Object.hasOwn(zhCnCore, k)
            || Object.hasOwn(lensShared['zh-cn'], k)
            || Object.hasOwn(workbench['zh-cn'], k)
            || Object.hasOwn(mgCn, k)
        );
        const hasTw = k => (
            Object.hasOwn(lensTables['zh-tw'], k)
            || Object.hasOwn(zhTwCore, k)
            || Object.hasOwn(lensShared['zh-tw'], k)
            || Object.hasOwn(workbench['zh-tw'], k)
            || Object.hasOwn(mgTw, k)
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

    test('all i18n/i18nFormat literals in memory-graph/main.js resolve synchronously without waiting for async lens/locale-data.js', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));

        const mgI18nSource = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/i18n.js'), 'utf8');
        const mgCn = {};
        const mgTw = {};
        const cnSectionMatch = /addLocaleData\('zh-cn',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        const twSectionMatch = /addLocaleData\('zh-tw',\s*\{([\s\S]*?)\n\s*\}\);/.exec(mgI18nSource);
        for (const m of (cnSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgCn[m[1].replace(/\\'/g, '\'')] = true;
        }
        for (const m of (twSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgTw[m[1].replace(/\\'/g, '\'')] = true;
        }

        const mainSrc = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/main.js'), 'utf8');
        const usedKeys = new Set();
        const callRe = /\bi18n(?:Format)?\(\s*'((?:\\'|[^'])+)'|\bi18n(?:Format)?\(\s*"((?:\\"|[^"])+)"/g;
        for (const m of mainSrc.matchAll(callRe)) {
            const raw = m[1] !== undefined
                ? m[1].replace(/\\'/g, '\'').replace(/\\\\/g, '\\')
                : m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            usedKeys.add(raw);
        }

        const missingCn = [...usedKeys].filter(k => !Object.hasOwn(mgCn, k) && !Object.hasOwn(zhCnCore, k));
        const missingTw = [...usedKeys].filter(k => !Object.hasOwn(mgTw, k) && !Object.hasOwn(zhTwCore, k));

        expect(missingCn).toEqual([]);
        expect(missingTw).toEqual([]);
    });
});
