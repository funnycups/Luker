/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';

// Intentionally import workbench modules BEFORE Luker / registerWorkbenchLocaleData exist.
delete globalThis.Luker;
delete globalThis.lukerContext;

const { readLabel, getReadLabels, readsSummary } = await import('../../public/scripts/workbench/model/ask.js');
const { baseRules } = await import('../../public/scripts/workbench/model/suggest.js');
const { chips, wsName } = await import('../../public/scripts/workbench/pages/ask.js');
const { nameMap, formatChangeName } = await import('../../public/scripts/workbench/pages/history.js');
const { knownRoles, sourceDefs } = await import('../../public/scripts/workbench/pages/settings.js');
const { toneLabel, getTones } = await import('../../public/scripts/workbench/ui/components.js');
const { cardUnits } = await import('../../public/scripts/workbench/model/adapters.js');
const { registerWorkbenchLocaleData } = await import('../../public/scripts/workbench/locale-data.js');

describe('lazy i18n evaluation after Luker locale registration', () => {
    test('modules imported before Luker initializes still evaluate translate() lazily once Luker is attached', () => {
        const tables = {};
        registerWorkbenchLocaleData((loc, data) => {
            tables[loc] = { ...(tables[loc] || {}), ...data };
        });

        const translatedCalls = [];
        globalThis.Luker = {
            getContext: () => ({
                getCurrentLocale: () => 'zh-cn',
                translate: (text) => {
                    translatedCalls.push(text);
                    return `TR:${text}`;
                },
            }),
        };

        expect(readLabel('wb_list_requests')).toMatch(/^TR:/);
        expect(getReadLabels().wb_read_frontend_logs).toMatch(/^TR:/);
        expect(readsSummary([{ name: 'wb_list_requests' }])).toBe(readLabel('wb_list_requests'));

        expect(baseRules().find(r => r.id === 'preset.dup')?.name).toMatch(/^TR:/);

        expect(chips().every(c => c.startsWith('TR:'))).toBe(true);
        expect(wsName('memory')).toMatch(/^TR:/);
        expect(wsName('memory_graph')).toMatch(/^TR:/);
        expect(wsName('memory')).not.toBe(wsName('memory_graph'));

        expect(nameMap().orch).toMatch(/^TR:/);
        expect(formatChangeName('memory')).toBe(wsName('memory'));
        expect(formatChangeName('memory_graph')).toBe(wsName('memory_graph'));

        expect(knownRoles().find(r => r.key === 'memory')?.label).toBe(wsName('memory'));
        expect(knownRoles().find(r => r.key === 'memory_graph')?.label).toBe(wsName('memory_graph'));
        expect(sourceDefs().find(s => s.key === 'frontLogs')?.name).toMatch(/^TR:/);

        expect(toneLabel('memory')).toMatch(/^TR:/);
        expect(getTones().orch).toMatch(/^TR:/);

        const units = cardUnits({
            character: { name: 'A', description: 'D', system_prompt: 'S', creator_notes: 'N' },
        });
        expect(units.get('card:name')?.label).toMatch(/^TR:/);
        expect(units.get('card:description')?.label).toMatch(/^TR:/);
        expect(units.get('card:system_prompt')?.label).toMatch(/^TR:/);
        expect(units.get('card:creator_notes')?.label).toMatch(/^TR:/);
        expect(Object.keys(tables['zh-cn'] || {}).length).toBeGreaterThan(0);
        expect(translatedCalls.length).toBeGreaterThan(10);

        delete globalThis.Luker;
    });
});
