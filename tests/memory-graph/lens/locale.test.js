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
        const mgCnKeys = new Set();
        for (const m of mgI18nSource.matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            mgCnKeys.add(m[1].replace(/\\'/g, '\''));
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
            || mgCnKeys.has(k),
        );

        expect(cnCollisions).toEqual([]);
        expect(twCollisions).toEqual([]);
    });
});
