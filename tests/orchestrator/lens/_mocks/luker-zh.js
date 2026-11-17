// Stubs Luker's context with the zh-cn locale stack (core + lens-shared +
// workbench + run-panel + orchestrator). Import this first.

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
}

import fs from 'node:fs';
import path from 'node:path';
import { registerLensSharedLocaleData } from '../../../../public/scripts/lens-shared/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../../public/scripts/workbench/locale-data.js';
import { registerRunPanelLocaleData } from '../../../../public/scripts/run-panel/locale-data.js';
import { registerLocaleData } from '../../../../public/scripts/extensions/orchestrator/i18n.js';

const ROOT = path.resolve(process.cwd(), '..');
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales/zh-cn.json'), 'utf8'));

const collect = (locale, data) => {
    if (locale === 'zh-cn') Object.assign(table, data);
};

registerLensSharedLocaleData(collect);
registerWorkbenchLocaleData(collect);
registerRunPanelLocaleData(collect);
registerLocaleData(collect);

globalThis.Luker = {
    getContext: () => ({
        addLocaleData: collect,
        getCurrentLocale: () => 'zh-cn',
        translate: (text) => table[text] ?? text,
        constants: {
            promptRoles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
            wiPosition: { before: 0, after: 1, ANTop: 2, ANBottom: 3, EMTop: 4, EMBottom: 5, atDepth: 6 },
        },
        extensionSettings: { orchestrator: {} },
        lib: { yaml: { load: () => ({}), dump: () => '' } },
        skills: {},
        Popup: class {},
        POPUP_TYPE: { CONFIRM: 1, TEXT: 2, INPUT: 3, DISPLAY: 4 },
        POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0, CUSTOM1: 1001 },
        saveSettingsDebounced: () => {},
        saveSettings: async () => {},
        getExtensionApi: () => null,
    }),
};
