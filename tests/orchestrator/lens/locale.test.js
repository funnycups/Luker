import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from '@jest/globals';
import { registerLensLocaleData } from '../../../public/scripts/extensions/orchestrator/lens/locale-data.js';
import { registerLensSharedLocaleData } from '../../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../public/scripts/workbench/locale-data.js';
import { registerRunPanelLocaleData } from '../../../public/scripts/run-panel/locale-data.js';
import { MODE_IDS, modeInfo } from '../../../public/scripts/extensions/orchestrator/lens/i18n.js';

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

describe('orchestrator/lens locale-data hygiene', () => {
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

    test('0 key collisions with core locales, orchestrator/i18n.js, lens-shared, workbench, and run-panel', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const lensShared = collectLocaleTables(registerLensSharedLocaleData);
        const workbench = collectLocaleTables(registerWorkbenchLocaleData);
        const runPanel = collectLocaleTables(registerRunPanelLocaleData);

        const orchI18nPath = path.join(ROOT, 'public/scripts/extensions/orchestrator/i18n.js');
        const orchI18nSource = fs.readFileSync(orchI18nPath, 'utf8');
        const cnSectionMatch = /_addLocaleData\('zh-cn',\s*\{([\s\S]*?)\n\s*\}\);/.exec(orchI18nSource);
        const twSectionMatch = /_addLocaleData\('zh-tw',\s*\{([\s\S]*?)\n\s*\}\);/.exec(orchI18nSource);
        const orchCnKeys = new Set();
        const orchTwKeys = new Set();
        for (const m of (cnSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            orchCnKeys.add(m[1].replace(/\\'/g, '\''));
        }
        for (const m of (twSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            orchTwKeys.add(m[1].replace(/\\'/g, '\''));
        }

        const cnCollisions = cnKeys.filter(k =>
            Object.hasOwn(zhCnCore, k)
            || Object.hasOwn(lensShared['zh-cn'], k)
            || Object.hasOwn(workbench['zh-cn'], k)
            || Object.hasOwn(runPanel['zh-cn'], k)
            || orchCnKeys.has(k),
        );
        const twCollisions = twKeys.filter(k =>
            Object.hasOwn(zhTwCore, k)
            || Object.hasOwn(lensShared['zh-tw'], k)
            || Object.hasOwn(workbench['zh-tw'], k)
            || Object.hasOwn(runPanel['zh-tw'], k)
            || orchTwKeys.has(k),
        );

        expect(cnCollisions).toEqual([]);
        expect(twCollisions).toEqual([]);
    });

    test('MODES hints match Spec Section 4.2.B and resolve in zh-CN/zh-TW', () => {
        const expectedHints = {
            single: 'Executes one standalone agent without multi-stage orchestration.',
            spec: 'Executes agents along a fixed stage pipeline.',
            agenda: 'A planner selects the next step at each stage based on current state.',
            loop: 'An agent executes a multi-round tool loop until its objective is reached.',
            director: 'A director plans dialogue direction before handing control to the main generation.',
        };
        for (const id of MODE_IDS) {
            const { hint } = modeInfo(id);
            expect(hint).toBe(expectedHints[id]);
            expect(Object.hasOwn(lensTables['zh-cn'], hint)).toBe(true);
            expect(Object.hasOwn(lensTables['zh-tw'], hint)).toBe(true);
        }
    });

    test('all i18n/i18nFormat literals in orchestrator/lens/** resolve in zh-CN/zh-TW and have no unescaped semicolons', () => {
        const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
        const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));
        const lensShared = collectLocaleTables(registerLensSharedLocaleData);
        const workbench = collectLocaleTables(registerWorkbenchLocaleData);
        const runPanel = collectLocaleTables(registerRunPanelLocaleData);

        const orchI18nSource = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/orchestrator/i18n.js'), 'utf8');
        const orchCn = {};
        const orchTw = {};
        const cnSectionMatch = /_addLocaleData\('zh-cn',\s*\{([\s\S]*?)\n\s*\}\);/.exec(orchI18nSource);
        const twSectionMatch = /_addLocaleData\('zh-tw',\s*\{([\s\S]*?)\n\s*\}\);/.exec(orchI18nSource);
        for (const m of (cnSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            orchCn[m[1].replace(/\\'/g, '\'')] = true;
        }
        for (const m of (twSectionMatch?.[1] || '').matchAll(/^\s*'((?:\\'|[^'])+)'\s*:/gm)) {
            orchTw[m[1].replace(/\\'/g, '\'')] = true;
        }

        const hasCn = k => (
            Object.hasOwn(lensTables['zh-cn'], k)
            || Object.hasOwn(zhCnCore, k)
            || Object.hasOwn(lensShared['zh-cn'], k)
            || Object.hasOwn(workbench['zh-cn'], k)
            || Object.hasOwn(runPanel['zh-cn'], k)
            || Object.hasOwn(orchCn, k)
        );
        const hasTw = k => (
            Object.hasOwn(lensTables['zh-tw'], k)
            || Object.hasOwn(zhTwCore, k)
            || Object.hasOwn(lensShared['zh-tw'], k)
            || Object.hasOwn(workbench['zh-tw'], k)
            || Object.hasOwn(runPanel['zh-tw'], k)
            || Object.hasOwn(orchTw, k)
        );

        const lensDir = path.join(ROOT, 'public/scripts/extensions/orchestrator/lens');
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
});
