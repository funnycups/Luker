// Stubs Luker's context with the zh-cn workbench locale. Import this first:
// workbench modules read the context while they load.

import { registerLensSharedLocaleData } from '../../../public/scripts/extensions/lens-shared/locale-data.js';
import { registerLensLocaleData } from '../../../public/scripts/extensions/orchestrator/lens/locale-data.js';
import { registerWorkbenchLocaleData } from '../../../public/scripts/extensions/workbench/locale-data.js';

const table = {};
const collect = (locale, data) => {
    if (locale === 'zh-cn') Object.assign(table, data);
};
registerLensSharedLocaleData(collect);
registerLensLocaleData(collect);
registerWorkbenchLocaleData(collect);

globalThis.Luker = {
    getContext: () => ({
        addLocaleData: () => {},
        getCurrentLocale: () => 'zh-cn',
        translate: (text) => table[text] ?? text,
    }),
};
