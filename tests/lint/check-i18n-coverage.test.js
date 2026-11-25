import { describe, test, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-i18n-coverage.js');

const { collectInventory, runChecks, scanJsonEntries, splitI18nKeys, LUKER_PLUGINS } = await import('../../scripts/check-i18n-coverage.js');

const trees = [];
afterEach(() => {
    while (trees.length) rmSync(trees.pop(), { recursive: true, force: true });
});

const CLEAN_JSON = '{\n    "k.core": "c"\n}\n';

function makeTree(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'luker-i18n-coverage-'));
    trees.push(root);
    const all = {
        'public/locales/zh-cn.json': CLEAN_JSON,
        'public/locales/zh-tw.json': CLEAN_JSON,
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        const abs = path.join(root, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
    }
    return root;
}

function globalTable(plugin, cn, tw = cn) {
    return {
        [`public/scripts/extensions/${plugin}/i18n.js`]: [
            'import { addLocaleData } from \'../../i18n.js\';',
            `addLocaleData('zh-cn', ${JSON.stringify(cn)});`,
            `addLocaleData('zh-tw', ${JSON.stringify(tw)});`,
            '',
        ].join('\n'),
    };
}

function scopedTable(plugin, cn, tw = cn) {
    return {
        [`public/scripts/extensions/${plugin}/i18n.js`]: [
            'import { createPluginI18n } from \'../../lib/plugin-i18n.js\';',
            `const ZH_CN = ${JSON.stringify(cn)};`,
            `const ZH_TW = ${JSON.stringify(tw)};`,
            'const PLUGIN_I18N = createPluginI18n({ \'zh-cn\': ZH_CN, \'zh-tw\': ZH_TW });',
            'export const i18n = text => PLUGIN_I18N.translate(text);',
            '',
        ].join('\n'),
    };
}

function checksOf(root) {
    return runChecks(collectInventory(root)).map(v => v.check);
}

function count(root, check) {
    return checksOf(root).filter(c => c === check).length;
}

function lint(root) {
    return spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, LUKER_I18N_ROOT: root },
        encoding: 'utf8',
    });
}

describe('check-i18n-coverage', () => {
    test.each(['/scripts/tables.js', 'table-package', './missing.js'])('unsupported default table import %s produces diagnostics without crashing', (specifier) => {
        const root = makeTree({
            'public/scripts/extensions/search-tools/i18n.js': `import table from '${specifier}';\ncreatePluginI18n({ 'zh-cn': table, 'zh-tw': table });\n`,
        });
        expect(() => collectInventory(root)).not.toThrow();
        expect(checksOf(root)).toContain('unresolved-table');
    });
    test('a clean tree exits 0', () => {
        const root = makeTree({
            ...scopedTable('search-tools', { 'k.alpha': 'a' }),
            'public/scripts/extensions/search-tools/main.js': 'import { i18n } from \'./i18n.js\';\ni18n(\'k.alpha\');\n',
            'public/scripts/lib/x.js': 'export const s = i18n(\'k.core\');\n',
        });
        const out = lint(root);
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('i18n coverage: no violations.');
    });

    test('a violating tree exits 1 with grouped output', () => {
        const root = makeTree({
            'public/scripts/lib/x.js': 'export const s = i18n(\'k.missing\');\n',
        });
        const out = lint(root);
        expect(out.status).toBe(1);
        expect(out.stdout).toMatch(/^\[shared-missing\] 2$/m);
    });

    test('shared translator call shapes are collected', () => {
        const root = makeTree({
            'public/scripts/lib/a.js': [
                'i18n(\'k.call\');',
                'ctx.translate(\'k.member\');',
                't`k.tag ${n} of ${m}`;',
                'fmt(i18n, \'k.fmt\', 1);',
                'formatWithI18n(this.i18n, \'k.format\');',
                'const html = \'<b data-i18n="k.attr"></b>\';',
                '',
            ].join('\n'),
            'public/scripts/run-panel/b.html': '<span data-i18n="[title]k.html">x</span>\n',
        });
        const inv = collectInventory(root);
        for (const k of ['k.call', 'k.member', 'k.tag ${0} of ${1}', 'k.fmt', 'k.format', 'k.attr', 'k.html']) {
            expect(inv.sharedCalls.has(k)).toBe(true);
        }
    });

    test('scoped tables are collected per plugin and locale', () => {
        const root = makeTree({
            ...scopedTable('orchestrator', { 'k.o': 'o' }),
            'public/scripts/extensions/card-app/i18n.js': 'export const T = Luker.getContext().createScopedI18n({ \'zh-cn\': { \'k.a\': \'a\' }, \'zh-tw\': { \'k.a\': \'b\' } });\n',
        });
        const inv = collectInventory(root);
        const shape = inv.tables.map(t => `${t.owner}:${t.kind}:${t.locale}:${[...t.entries.keys()].join(',')}`).sort();
        expect(shape).toEqual([
            'card-app:scoped:zh-cn:k.a',
            'card-app:scoped:zh-tw:k.a',
            'orchestrator:scoped:zh-cn:k.o',
            'orchestrator:scoped:zh-tw:k.o',
        ]);
        expect(inv.literalOwners.has('k.a')).toBe(false);
    });

    test('scoped tables may override JSON and repeat keys of other plugins', () => {
        const root = makeTree({
            ...scopedTable('orchestrator', { 'k.core': 'x', 'k.both': 'a', 'k.cn': 'a' }, { 'k.core': 'x', 'k.both': 'a' }),
            ...scopedTable('memory-graph', { 'k.both': 'b' }),
            'public/scripts/skills/i18n.js': 'import { addLocaleData } from \'../i18n.js\';\naddLocaleData(\'zh-cn\', { \'k.skill\': \'s\' });\naddLocaleData(\'zh-tw\', { \'k.skill\': \'s\' });\n',
        });
        const checks = checksOf(root);
        expect(checks.filter(c => c === 'parity')).toHaveLength(1);
        expect(checks.filter(c => c === 'core-table')).toHaveLength(2);
        expect(checks.filter(c => c.startsWith('plugin-') || c.startsWith('global-table'))).toEqual([]);
    });

    test('Luker plugins using the global table or the core translator are reported', () => {
        const root = makeTree({
            ...globalTable('orchestrator', { 'k.o': 'o' }),
            ...globalTable('hook-order', { 'k.h': 'h' }),
            'public/scripts/extensions/memory-graph/main.js': [
                'const __ctx = Luker.getContext();',
                'const addLocaleData = __ctx.addLocaleData;',
                'const translate = __ctx.translate;',
                'const { t } = Luker.getContext();',
                'export const sim = context => context.translate(\'sim.a\');',
                'export const all = [addLocaleData, translate, t];',
                '',
            ].join('\n'),
        });
        expect(LUKER_PLUGINS).toContain('orchestrator');
        expect(LUKER_PLUGINS).not.toContain('hook-order');
        expect(count(root, 'plugin-add-locale-data')).toBe(3);
        expect(count(root, 'plugin-core-translate')).toBe(2);
    });

    test('local aliases of getContext() are context objects but parameters are not', () => {
        const root = makeTree({
            'public/scripts/extensions/orchestrator/a.js': [
                'const c = (typeof Luker !== \'undefined\') ? Luker.getContext() : null;',
                'export const a = () => c?.translate(\'k.a\');',
                'let ctx = Luker.getContext?.();',
                'export const b = ctx.t;',
                'const ctx2 = window.ctx || getContext();',
                'const { translate } = ctx2;',
                'export const sim = context => context?.translate(\'sim.a\');',
                'export function run(arg) {',
                '    const stContext = arg?.context || (typeof arg?.getContext === \'function\' ? arg.getContext() : null);',
                '    return [stContext.translate, translate];',
                '}',
                'export const other = { translate: 1 }.translate;',
                '',
            ].join('\n'),
            'public/scripts/extensions/regex/a.js': 'const c = Luker.getContext();\nexport const a = c.translate;\n',
        });
        const refs = collectInventory(root).coreTranslateRefs.map(x => `${x.line}:${x.name}`);
        expect(refs).toEqual(expect.arrayContaining(['2:translate', '4:t', '6:translate']));
        expect(refs).toHaveLength(3);
    });

    test('addLocaleData calls in Luker plugins are reported even when the table does not resolve', () => {
        const root = makeTree({
            'public/scripts/extensions/search-tools/a.js': [
                'import { addLocaleData } from \'../../i18n.js\';',
                'import { ZH } from \'./tables.js\';',
                'addLocaleData(\'zh-cn\', ZH);',
                'export const f = loc => addLocaleData(loc, { \'k.a\': \'a\' });',
                '',
            ].join('\n'),
            'public/scripts/extensions/regex/a.js': 'import { ZH } from \'./tables.js\';\naddLocaleData(\'zh-cn\', ZH);\n',
        });
        expect(count(root, 'plugin-add-locale-data')).toBe(2);
    });

    test('an unresolvable scoped table argument in a Luker plugin is reported', () => {
        const root = makeTree({
            'public/scripts/extensions/card-app/i18n.js': [
                'import { createPluginI18n } from \'../../lib/plugin-i18n.js\';',
                'import { TABLES, ZH_CN } from \'./tables.js\';',
                'export const a = createPluginI18n(TABLES);',
                'export const b = createPluginI18n({ \'zh-cn\': ZH_CN });',
                '',
            ].join('\n'),
            'public/scripts/lib/plugin-i18n.js': 'export function createPluginI18n(tables) {\n    return globalThis.Luker.getContext().createScopedI18n(tables);\n}\n',
        });
        expect(count(root, 'unresolved-table')).toBe(2);
    });

    test('template-literal data-i18n values show interpolations as $ in messages', () => {
        const semi = '{\n    "k.core": "c",\n    "Sync a; b": "s"\n}\n';
        const root = makeTree({
            'public/locales/zh-cn.json': semi,
            'public/locales/zh-tw.json': semi,
            'public/scripts/extensions/orchestrator/ui.js': 'export const a = n => `<i data-i18n="No ${n} notes">x</i>`;\n',
            'public/scripts/templates/a.js': 'export const b = n => `<i data-i18n="Sync a; b ${n}">x</i>`;\n',
        });
        const messages = runChecks(collectInventory(root)).filter(v => v.check === 'plugin-data-i18n' || v.check === 'data-i18n-semicolon');
        expect(messages.map(v => v.check).sort()).toEqual(['data-i18n-semicolon', 'plugin-data-i18n']);
        for (const v of messages) {
            expect(v.message).not.toContain('\u0000');
            expect(v.message).toContain('$');
        }
    });

    test('data-i18n in Luker plugin markup is reported', () => {
        const root = makeTree({
            'public/scripts/extensions/orchestrator/ui.js': 'export const a = \'<b data-i18n="k.core">x</b>\';\nexport const b = n => `<i data-i18n="k.core">${n}</i>`;\n',
            'public/scripts/extensions/regex/ui.js': 'export const a = \'<b data-i18n="k.core">x</b>\';\n',
            'public/scripts/templates/a.html': '<p data-i18n="k.core">x</p>\n',
        });
        expect(count(root, 'plugin-data-i18n')).toBe(2);
    });

    test('other extension tables may not change JSON values or disagree with each other', () => {
        const root = makeTree({
            ...globalTable('hook-order', { 'k.core': 'different', 'k.free': 'a' }),
            ...globalTable('tts', { 'k.free': 'b' }),
        });
        expect(count(root, 'global-table-override')).toBe(2);
        expect(count(root, 'global-table-collision')).toBe(2);
    });

    test('another extension table that repeats a JSON value is accepted', () => {
        const root = makeTree({ ...globalTable('hook-order', { 'k.core': 'c' }) });
        expect(checksOf(root)).toEqual([]);
    });

    test('translator calls are recorded per owner', () => {
        const root = makeTree({
            'public/scripts/extensions/search-tools/main.js': 'i18n(\'k.p\');\nfmt(i18n, \'k.q\');\n',
            'public/scripts/x.js': 'translate(\'k.r\');\n',
        });
        const inv = collectInventory(root);
        expect([...inv.callsByOwner.get('search-tools').keys()].sort()).toEqual(['k.p', 'k.q']);
        expect([...inv.callsByOwner.get('core').keys()]).toEqual(['k.r']);
        expect(inv.sharedCalls.has('k.p')).toBe(false);
    });

    test('simulation-review tables resolve default imports and own sim keys', () => {
        const dir = 'public/scripts/iteration-library/simulation-review';
        const root = makeTree({
            [`${dir}/i18n/index.js`]: [
                'import { addLocaleData } from \'../../../i18n.js\';',
                'import cn from \'./zh-cn.js\';',
                'import tw from \'./zh-tw.js\';',
                'addLocaleData(\'zh-cn\', cn);',
                'addLocaleData(\'zh-tw\', tw);',
                '',
            ].join('\n'),
            [`${dir}/i18n/zh-cn.js`]: 'export default { \'sim.a\': \'a\' };\n',
            [`${dir}/i18n/zh-tw.js`]: 'export default { \'sim.a\': \'a\', \'k.bad\': \'b\' };\n',
            [`${dir}/popup.js`]: 'translate(\'sim.a\');\ntranslate(\'sim.b\');\n',
        });
        const inv = collectInventory(root);
        expect(inv.tables.map(t => t.owner)).toEqual(['core:iteration-library/simulation-review', 'core:iteration-library/simulation-review']);
        const checks = runChecks(inv).map(v => v.check);
        expect(checks.filter(c => c === 'shared-sim-missing')).toHaveLength(2);
        expect(checks.filter(c => c === 'core-table')).toHaveLength(1);
    });

    test('json duplicates and table duplicates are reported', () => {
        const dup = '{\n    "k.core": "a",\n    "k.core": "b"\n}\n';
        const root = makeTree({
            'public/locales/zh-cn.json': dup,
            'public/scripts/extensions/alpha/i18n.js': 'addLocaleData(\'zh-cn\', { \'k.x\': \'a\', \'k.x\': \'b\' });\naddLocaleData(\'zh-tw\', { \'k.x\': \'a\' });\n',
        });
        const checks = checksOf(root);
        expect(checks.filter(c => c === 'json-duplicate')).toHaveLength(1);
        expect(checks.filter(c => c === 'table-duplicate')).toHaveLength(1);
        expect(scanJsonEntries(dup).map(e => e.line)).toEqual([2, 3]);
    });

    test('an unescaped semicolon key in data-i18n is reported', () => {
        const semi = '{\n    "k.core": "c",\n    "Sync a; b": "s"\n}\n';
        const root = makeTree({
            'public/locales/zh-cn.json': semi,
            'public/locales/zh-tw.json': semi,
            'public/scripts/templates/a.html': '<p data-i18n="Sync a; b">x</p>\n<p data-i18n="Sync a\\; b">y</p>\n',
        });
        expect(checksOf(root).filter(c => c === 'data-i18n-semicolon')).toHaveLength(1);
        expect(splitI18nKeys('[title]a\\; b;c')).toEqual(['a; b', 'c']);
    });

    test('an unescaped semicolon key is reported even beside an escaped copy', () => {
        const semi = '{\n    "k.core": "c",\n    "Sync a; b": "s"\n}\n';
        const root = makeTree({
            'public/locales/zh-cn.json': semi,
            'public/locales/zh-tw.json': semi,
            'public/scripts/templates/a.html': '<p data-i18n="[title]Sync a\\; b;Sync a; b">x</p>\n',
        });
        expect(checksOf(root).filter(c => c === 'data-i18n-semicolon')).toHaveLength(1);
    });

    test('translator arguments bound to same-file consts are resolved', () => {
        const root = makeTree({
            'public/scripts/run-panel/a.js': [
                'const D = \'k.ident\';',
                'const D2 = \'k.ternary\';',
                'const D3 = `k.nullish`;',
                'export function f(opts, flag) {',
                '    const text = opts.text || D;',
                '    t(text);',
                '    t(flag ? \'k.lit\' : D2);',
                '    return t(opts.y ?? D3);',
                '}',
                '',
            ].join('\n'),
        });
        const inv = collectInventory(root);
        for (const k of ['k.ident', 'k.ternary', 'k.nullish', 'k.lit']) {
            expect(inv.sharedCalls.has(k)).toBe(true);
        }
        expect(inv.unresolvedSharedCalls.map(u => u.site).sort()).toEqual(['public/scripts/run-panel/a.js:6', 'public/scripts/run-panel/a.js:8']);
    });

    test('const resolution follows the nearest enclosing binding', () => {
        const root = makeTree({
            'public/scripts/lib/a.js': [
                'const L = \'k.outer\';',
                'function g() { const L = \'k.inner\'; return t(L); }',
                'function h(L) { return t(L); }',
                '',
            ].join('\n'),
        });
        const inv = collectInventory(root);
        expect(inv.sharedCalls.has('k.inner')).toBe(true);
        expect(inv.sharedCalls.has('k.outer')).toBe(false);
        expect(inv.unresolvedSharedCalls.map(u => u.site)).toEqual(['public/scripts/lib/a.js:3']);
    });

    test('sim keys reached through a const lookup table are cross-checked', () => {
        const root = makeTree({
            'public/scripts/iteration-library/simulation-review/popup.js': 'const TITLES = { a: \'sim.x\', b: \'sim.y\' };\nexport const f = kind => translate(TITLES[kind]);\n',
        });
        expect(checksOf(root).filter(c => c === 'shared-sim-missing')).toHaveLength(4);
    });

    test('an unparsable plugin file is a parse violation', () => {
        const root = makeTree({
            'public/scripts/extensions/alpha/broken.js': 'export const = ;\n',
        });
        expect(checksOf(root)).toContain('parse');
    });

    test('an unparsable core file is a parse violation', () => {
        const root = makeTree({
            'public/scripts/broken.js': 'export const = ;\n',
        });
        expect(checksOf(root)).toContain('parse');
    });

    test('interpolated template literal passed to a non-tagged translator is reported', () => {
        const root = makeTree({
            ...scopedTable('search-tools', { 'Count: ${0}': '数量：${0}' }),
            'public/scripts/extensions/search-tools/main.js': [
                'import { i18n, i18nFormat } from \'./i18n.js\';',
                'const bad = n => i18n(`Count: ${n}`);',
                'const good = n => i18nFormat(\'Count: ${0}\', n);',
                'export { bad, good };',
                '',
            ].join('\n'),
        });
        expect(count(root, 'interpolated-call')).toBe(1);
    });

    test('missing Luker plugin translation keys are reported', () => {
        const root = makeTree({
            ...scopedTable('search-tools', { 'k.present': 'p' }),
            'public/scripts/extensions/search-tools/main.js': 'import { i18n } from \'./i18n.js\';\ni18n(\'k.present\');\ni18n(\'k.missing\');\n',
        });
        expect(count(root, 'plugin-missing')).toBe(2);
    });

    test('zh-cn.json and zh-tw.json key parity is enforced', () => {
        const root = makeTree({
            'public/locales/zh-cn.json': '{\n    "k.core": "c",\n    "k.cn_only": "a"\n}\n',
            'public/locales/zh-tw.json': '{\n    "k.core": "c",\n    "k.tw_only": "b"\n}\n',
        });
        expect(count(root, 'json-parity')).toBe(2);
    });
});
