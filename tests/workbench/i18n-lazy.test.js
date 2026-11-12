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
const { registerWorkbenchLocaleData } = await import('../../public/scripts/workbench/locale-data.js');

describe('lazy i18n evaluation after Luker locale registration', () => {
    test('modules imported before Luker initializes still return translated strings once locale data is registered', () => {
        const tables = {};
        const coreZhCn = {
            'Request inspector': '请求检查器-core',
            Preset: '预设',
            'Character card': '角色卡',
            'World book': '世界书',
            'Q&A': '问问',
        };
        registerWorkbenchLocaleData((loc, data) => {
            tables[loc] = { ...(tables[loc] || {}), ...data };
        });

        globalThis.Luker = {
            getContext: () => ({
                getCurrentLocale: () => 'zh-cn',
                translate: (text) => tables['zh-cn']?.[text] ?? coreZhCn[text] ?? text,
            }),
        };

        expect(readLabel('wb_list_requests')).toBe('请求列表');
        expect(getReadLabels().wb_read_frontend_logs).toBe('前端日志');
        expect(readsSummary([{ name: 'wb_list_requests' }])).toBe('请求列表');

        expect(baseRules().find(r => r.id === 'preset.dup')?.name).toBe('预设条目重复');

        expect(chips()).toContain('这条回复为什么会这样写');
        expect(wsName('memory')).toBe('记忆图');

        expect(nameMap().orch).toBe('编排');
        expect(formatChangeName('memory')).toBe('记忆图');

        expect(knownRoles().find(r => r.key === 'memory')?.label).toBe('记忆图');
        expect(sourceDefs().find(s => s.key === 'frontLogs')?.name).toBe('前端日志');

        expect(toneLabel('memory')).toBe('记忆图');
        expect(getTones().orch).toBe('编排');

        delete globalThis.Luker;
    });
});
