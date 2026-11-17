import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from '@jest/globals';
import { registerLensSharedLocaleData } from '../public/scripts/lens-shared/locale-data.js';
import { registerRunPanelLocaleData } from '../public/scripts/run-panel/locale-data.js';
import { registerWorkbenchLocaleData } from '../public/scripts/workbench/locale-data.js';
import { registerLocaleData as registerMgLocaleData } from '../public/scripts/extensions/memory-graph/i18n.js';
import { registerLocaleData as registerOrchLocaleData } from '../public/scripts/extensions/orchestrator/i18n.js';
import { MODE_IDS, modeInfo } from '../public/scripts/extensions/orchestrator/lens/i18n.js';

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

function walkJsFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkJsFiles(full));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

function extractI18nCalls(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const keys = [];
    const callRe = /\bi18n(?:Format)?\(\s*(?:'((?:\\'|[^'])+)'|"((?:\\"|[^"])+)"|`([^`${}]+)`)/g;
    for (const m of src.matchAll(callRe)) {
        const raw = m[1] !== undefined
            ? m[1].replace(/\\'/g, '\'').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
            : m[2] !== undefined
                ? m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
                : m[3].replace(/\\`/g, '`').replace(/\\\\/g, '\\');
        keys.push(raw);
    }
    return keys;
}

const CORE_LOCALE_MODULES = [
    { name: 'lens-shared', register: registerLensSharedLocaleData, dir: 'public/scripts/lens-shared' },
    { name: 'run-panel', register: registerRunPanelLocaleData, dir: 'public/scripts/run-panel' },
    { name: 'workbench', register: registerWorkbenchLocaleData, dir: 'public/scripts/workbench' },
];

const EXTENSION_MODULES = [
    { name: 'memory-graph/i18n', register: registerMgLocaleData, lensDir: 'public/scripts/extensions/memory-graph/lens' },
    { name: 'orchestrator/i18n', register: registerOrchLocaleData, lensDir: 'public/scripts/extensions/orchestrator/lens' },
];

const zhCnCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));
const zhTwCore = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-tw.json'), 'utf8'));

const coreModuleTables = CORE_LOCALE_MODULES.map((m) => ({
    ...m,
    tables: collectLocaleTables(m.register),
}));

const extensionModuleTables = EXTENSION_MODULES.map((m) => ({
    ...m,
    tables: collectLocaleTables(m.register),
}));

const allModuleTables = [...coreModuleTables, ...extensionModuleTables];

describe('i18n lens & workbench unified audit', () => {
    test('zero split extension lens/locale-data.js files remain on disk', () => {
        const splitFiles = [
            'public/scripts/extensions/memory-graph/lens/locale-data.js',
            'public/scripts/extensions/orchestrator/lens/locale-data.js',
            'public/scripts/extensions/stable-diffusion/lens/locale-data.js',
        ].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
        expect(splitFiles).toEqual([]);
    });

    test('100% EN / zh-CN / zh-TW key parity across all core and extension i18n modules', () => {
        const parityErrors = {};
        for (const mod of allModuleTables) {
            const cnKeys = Object.keys(mod.tables['zh-cn']);
            const twKeys = Object.keys(mod.tables['zh-tw']);
            const missingInTw = cnKeys.filter((k) => !Object.hasOwn(mod.tables['zh-tw'], k));
            const missingInCn = twKeys.filter((k) => !Object.hasOwn(mod.tables['zh-cn'], k));
            if (missingInTw.length || missingInCn.length) {
                parityErrors[mod.name] = { missingInTw, missingInCn };
            }
        }
        expect(parityErrors).toEqual({});
    });

    test('zero English keys contain semicolons across core locale-data modules', () => {
        const bad = {};
        for (const mod of coreModuleTables) {
            const cnBad = Object.keys(mod.tables['zh-cn']).filter((k) => k.includes(';'));
            const twBad = Object.keys(mod.tables['zh-tw']).filter((k) => k.includes(';'));
            if (cnBad.length || twBad.length) {
                bad[mod.name] = { cnBad, twBad };
            }
        }
        expect(bad).toEqual({});
    });

    test('zero key conflicts in core locale-data modules overwriting core JSONs or extension i18n with differing translations', () => {
        const baselines = [
            { name: 'core', tables: { 'zh-cn': zhCnCore, 'zh-tw': zhTwCore } },
            ...extensionModuleTables,
        ];
        const conflicts = [];
        for (const mod of coreModuleTables) {
            for (const loc of ['zh-cn', 'zh-tw']) {
                for (const [k, v] of Object.entries(mod.tables[loc])) {
                    for (const base of baselines) {
                        if (Object.hasOwn(base.tables[loc], k) && base.tables[loc][k] !== v) {
                            conflicts.push({ module: mod.name, locale: loc, base: base.name, key: k, modVal: v, baseVal: base.tables[loc][k] });
                        }
                    }
                }
            }
        }
        expect(conflicts).toEqual([]);
    });

    test('zero cross-module collisions with differing translations across core locale-data modules', () => {
        const conflicts = [];
        for (let i = 0; i < coreModuleTables.length; i++) {
            for (let j = i + 1; j < coreModuleTables.length; j++) {
                const a = coreModuleTables[i];
                const b = coreModuleTables[j];
                for (const loc of ['zh-cn', 'zh-tw']) {
                    for (const [k, va] of Object.entries(a.tables[loc])) {
                        if (Object.hasOwn(b.tables[loc], k) && b.tables[loc][k] !== va) {
                            conflicts.push({ locale: loc, a: a.name, b: b.name, key: k, valA: va, valB: b.tables[loc][k] });
                        }
                    }
                }
            }
        }
        expect(conflicts).toEqual([]);
    });

    test('zero half-width CJK punctuation in zh-CN and zh-TW values across all core and extension i18n modules', () => {
        const halfWidthCjk = /[\u3400-\u9fff][,.;:!?()]|[,.;:!?()][\u3400-\u9fff]/;
        const bad = [];
        for (const mod of allModuleTables) {
            for (const loc of ['zh-cn', 'zh-tw']) {
                for (const [k, v] of Object.entries(mod.tables[loc])) {
                    if (halfWidthCjk.test(v)) {
                        bad.push({ module: mod.name, locale: loc, key: k, value: v });
                    }
                }
            }
        }
        expect(bad).toEqual([]);
    });

    test('zero missing i18n/i18nFormat string literals or semicolons across all 6 lens & workbench source trees', () => {
        const allCn = { ...zhCnCore };
        const allTw = { ...zhTwCore };
        for (const mod of allModuleTables) {
            Object.assign(allCn, mod.tables['zh-cn']);
            Object.assign(allTw, mod.tables['zh-tw']);
        }

        const sourceTrees = [
            ...CORE_LOCALE_MODULES.map((m) => ({ name: m.name, dir: m.dir })),
            { name: 'memory-graph/lens', dir: 'public/scripts/extensions/memory-graph/lens' },
            { name: 'orchestrator/lens', dir: 'public/scripts/extensions/orchestrator/lens' },
            { name: 'stable-diffusion/lens', dir: 'public/scripts/extensions/stable-diffusion/lens' },
        ];

        const missingCn = [];
        const missingTw = [];
        const semicolonKeys = [];

        for (const tree of sourceTrees) {
            const files = walkJsFiles(path.join(ROOT, tree.dir));
            for (const file of files) {
                const rel = path.relative(ROOT, file);
                for (const key of extractI18nCalls(file)) {
                    if (key.includes(';')) semicolonKeys.push({ module: tree.name, file: rel, key });
                    if (!Object.hasOwn(allCn, key)) missingCn.push({ module: tree.name, file: rel, key });
                    if (!Object.hasOwn(allTw, key)) missingTw.push({ module: tree.name, file: rel, key });
                }
            }
        }

        expect(semicolonKeys).toEqual([]);
        expect(missingCn).toEqual([]);
        expect(missingTw).toEqual([]);
    });

    test('Ask providers do not contain hardcoded Chinese strings or hardcoded zh-CN date locale', () => {
        const mgProviders = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/lens/providers.js'), 'utf8');
        const orchProviders = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/orchestrator/lens/providers.js'), 'utf8');

        expect(mgProviders).not.toMatch(/[\u4e00-\u9fff]/);
        expect(mgProviders).not.toMatch(/toLocaleString\(\s*['"]zh-CN['"]\s*\)/);
        expect(orchProviders).not.toMatch(/[\u4e00-\u9fff]/);
        expect(orchProviders).not.toMatch(/toLocaleString\(\s*['"]zh-CN['"]\s*\)/);
    });

    test('orchestrator/lens MODES hints match Spec Section 4.2.B and resolve in zh-CN/zh-TW', () => {
        const expectedHints = {
            spec: 'Executes configured stages and agent nodes in fixed order.',
            agenda: 'A dispatcher agent selects which worker agents run and in what order for each turn.',
            loop: 'A single agent iteratively calls read and world tools until producing a final output.',
            director: 'A director agent plans and invokes sub-agents as tools during generation.',
            single: 'Executes one standalone agent without multi-stage orchestration.',
        };
        const orchTables = extensionModuleTables.find((m) => m.name === 'orchestrator/i18n').tables;
        for (const id of MODE_IDS) {
            const { hint } = modeInfo(id);
            expect(hint).toBe(expectedHints[id]);
            expect(Object.hasOwn(orchTables['zh-cn'], hint)).toBe(true);
            expect(Object.hasOwn(orchTables['zh-tw'], hint)).toBe(true);
        }
    });
});
