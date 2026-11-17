// Stubs Luker's context with the zh-cn locale stack (core + lens-shared +
// workbench + memory-graph + lens). Import this first: lens modules read the
// context while they load.

import fs from 'node:fs';
import path from 'node:path';
import { registerLensSharedLocaleData } from '../../../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../../public/scripts/workbench/locale-data.js';
import { registerLensLocaleData } from '../../../../public/scripts/extensions/memory-graph/lens/locale-data.js';

const ROOT = path.resolve(process.cwd(), '..');
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));

const collect = (locale, data) => {
    if (locale === 'zh-cn') Object.assign(table, data);
};

// Synchronously load memory-graph/i18n.js zh-cn entries so static module imports
// that evaluate i18n() at load time (e.g. schema-model.js UNNAMED) see them immediately.
const mgI18nSrc = fs.readFileSync(path.join(ROOT, 'public/scripts/extensions/memory-graph/i18n.js'), 'utf8');
const cnBlock = mgI18nSrc.match(/addLocaleData\('zh-cn',\s*(\{[\s\S]*?\n\s*\})\);/);
if (cnBlock) {
    const entries = new Function(`return ${cnBlock[1]};`)();
    Object.assign(table, entries);
}

registerLensSharedLocaleData(collect);
registerWorkbenchLocaleData(collect);
registerLensLocaleData(collect);

globalThis.Luker = {
    getContext: () => ({
        addLocaleData: collect,
        getCurrentLocale: () => 'zh-cn',
        translate: (text) => table[text] ?? text,
        regex: {
            SCRIPT_TYPES: {},
            placement: { USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 },
            getScripts: () => [],
            getScriptsByType: () => [],
            registerRegexProvider: () => ({ refresh: () => {}, unregister: () => {} }),
        },
    }),
};
