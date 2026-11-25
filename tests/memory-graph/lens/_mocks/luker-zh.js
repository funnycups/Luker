// Stubs Luker's context with the zh-cn locale stack (core + lens-shared +
// workbench + memory-graph). Import this first: lens modules read the
// context while they load.

import fs from 'node:fs';
import path from 'node:path';
import { registerLensSharedLocaleData } from '../../../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../../public/scripts/workbench/locale-data.js';
import { registerLocaleData } from '../../../../public/scripts/extensions/memory-graph/i18n.js';

const ROOT = path.resolve(process.cwd(), '..');
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));

const collect = (locale, data) => {
    if (locale === 'zh-cn') Object.assign(table, data);
};

registerLensSharedLocaleData(collect);
registerWorkbenchLocaleData(collect);
registerLocaleData(collect);

globalThis.Luker = {
    getContext: () => ({
        addLocaleData: collect,
        getCurrentLocale: () => 'zh-cn',
        translate: (text) => table[text] ?? text,
        createScopedI18n: (tables) => {
            const tr = (text, key = null) => {
                const loc = globalThis.Luker?.getContext?.()?.getCurrentLocale?.() || '';
                const lookupKey = key || text;
                const own = loc && tables?.[loc] && Object.hasOwn(tables[loc], lookupKey) ? tables[loc][lookupKey] : '';
                if (own) return own;
                const fallbackFn = globalThis.Luker?.getContext?.()?.translate;
                return typeof fallbackFn === 'function' ? fallbackFn(text) : (text ?? '');
            };
            return {
                t: (strings, ...values) => tr(strings.reduce((r, s, i) => r + s + (values[i] !== undefined ? `\${${i}}` : ''), '')).replace(/\$\{(\d+)\}/g, (_, idx) => values[Number(idx)]),
                translate: tr,
                format: (template, ...values) => tr(String(template || '')).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? '')),
                has: (key) => { const loc = globalThis.Luker?.getContext?.()?.getCurrentLocale?.() || ''; return Boolean(loc && tables?.[loc]?.[key]); },
            };
        },
        regex: {
            SCRIPT_TYPES: {},
            placement: { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 },
            getScripts: () => [],
            getScriptsByType: () => [],
            registerRegexProvider: () => ({ refresh: () => {}, unregister: () => {} }),
        },
    }),
};
