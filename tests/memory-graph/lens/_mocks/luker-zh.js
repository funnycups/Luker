// Stubs Luker's context with the zh-cn lens locale. Import this first: lens
// modules read the context while they load.

import { registerLensLocaleData } from '../../../../public/scripts/extensions/memory-graph/lens/locale-data.js';

const table = {};
registerLensLocaleData((locale, data) => {
    if (locale === 'zh-cn') Object.assign(table, data);
});

globalThis.Luker = {
    getContext: () => ({
        addLocaleData: () => {},
        getCurrentLocale: () => 'zh-cn',
        translate: (text) => table[text] ?? text,
    }),
};
