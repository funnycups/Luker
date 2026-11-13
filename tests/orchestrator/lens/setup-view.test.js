/**
 * @jest-environment jsdom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later

import './_mocks/luker-zh.js';
import { describe, test, expect, jest } from '@jest/globals';
import { createDrafts } from '../../../public/scripts/extensions/orchestrator/lens/model/drafts.js';
import { createSetupView } from '../../../public/scripts/extensions/orchestrator/lens/views/setup-view.js';
import { toolGroupName, toolName } from '../../../public/scripts/extensions/orchestrator/lens/i18n.js';

function makeApp({
    target = { mode: 'spec', scope: 'character', presetId: 'default', avatar: 'alice.png', chatKey: 'char:alice.png:c1' },
    profile = {
        spec: {
            stages: [{ id: 'distill', mode: 'serial', nodes: ['distiller'] }],
            defaultTools: null,
        },
        presets: {
            distiller: { systemPrompt: 'sys', userPromptTemplate: 'task', apiPresetName: '', promptPresetName: '' },
        },
    },
    presetList = {
        character: [{ id: 'default', name: 'Card Default' }],
        global: [{ id: 'default', name: 'Global Default' }],
    },
    inventoryFn = null,
    openSkillManagerFn = null,
} = {}) {
    const drafts = createDrafts();
    drafts.setBase(target, profile);
    const selectMock = jest.fn(async () => {});
    const reloadMock = jest.fn(async () => {});
    const mountedChips = [];
    const skillsList = inventoryFn || jest.fn(async () => [{ name: 'skill-a', description: 'desc' }]);

    const app = {
        drafts,
        snapshot: () => ({ target, profile, mode: target.mode, presetName: 'Card Default', cardPinnedMode: '' }),
        canEdit: () => true,
        notify: jest.fn(),
        reload: reloadMock,
        promptText: jest.fn(async () => null),
        dialog: { ask: jest.fn(async () => '') },
        source: {
            presets: {
                list: () => presetList,
                select: selectMock,
                create: jest.fn(),
                duplicate: jest.fn(),
                rename: jest.fn(),
                remove: jest.fn(),
                exportActive: jest.fn(),
                parseImport: jest.fn(),
                importParsed: jest.fn(),
                saveToGlobal: jest.fn(),
                saveToCharacter: jest.fn(),
                clearCharacter: jest.fn(),
                pinMode: jest.fn(),
                resetSingle: jest.fn(),
                saveCustomTools: jest.fn(),
            },
            edit: {
                allTools: (_m, on) => ({ chat: { read_range: on, search: on }, note: { open: on, close: on }, lorebook: { world_book_list: on, list: on, search: on, get: on } }),
                baseTools: () => ({ chat: { read_range: false, search: false } }),
                defaultMainPrompt: () => 'main',
                convertFrom: () => null,
            },
            skills: {
                inventory: skillsList,
                mount: (el, opts) => { mountedChips.push({ el, opts }); },
            },
            customToolEditor: {
                registry: () => [],
                open: jest.fn(async () => null),
                bridge: jest.fn(async () => {}),
                importDefaults: jest.fn(),
                defaults: () => [],
            },
            openSkillManager: openSkillManagerFn || jest.fn(async () => {}),
            openAiIteration: jest.fn(),
        },
    };
    return { app, selectMock, reloadMock, skillsList, mountedChips };
}

describe('orchestrator/lens/views/setup-view.js', () => {
    test('presetBar encodes option values as scope:id so global and character "default" never collide', async () => {
        const { app, selectMock } = makeApp();
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const sel = view.el.querySelector('select[aria-label]');
        expect(sel).not.toBeNull();
        const optionValues = [...sel.querySelectorAll('option')].map(o => o.value);
        expect(optionValues).toEqual(['character:default', 'global:default']);
        expect(sel.value).toBe('character:default');

        sel.value = 'global:default';
        sel.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(selectMock).toHaveBeenCalledWith(expect.anything(), 'global', 'default');
        view.el.remove();
    });

    test('defaultToolsSection renders clickable tool checkboxes even when defaultTools is null', () => {
        const { app } = makeApp();
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const checkboxes = [...view.el.querySelectorAll('.ol-setup-tools [role="checkbox"]')];
        expect(checkboxes.length).toBeGreaterThan(0);

        checkboxes[0].click();
        expect(app.drafts.get('@profile', 'spec/defaultTools')).not.toBe('');
        view.el.remove();
    });

    test('toolGrid displays localized tool group names and tool names instead of raw IDs/verbs', () => {
        const { app } = makeApp();
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const heads = [...view.el.querySelectorAll('.ol-setup-toolhead')].map(el => el.textContent);
        expect(heads).toContain(toolGroupName('note'));
        expect(heads).toContain(toolGroupName('chat'));
        expect(heads).toContain(toolGroupName('lorebook'));
        expect(heads).not.toContain('lorebook');

        const labels = [...view.el.querySelectorAll('.ol-setup-tools .ol-checkrow-label, .ol-setup-tools .lw-check-label')].map(el => el.textContent);
        expect(labels).toContain(toolName('note_open'));
        expect(labels).toContain(toolName('chat_read_range'));
        expect(labels).not.toContain('read_range');
        view.el.remove();
    });

    test('renaming a spec node ID updates agentId bindings cleanly while keeping <details> open', () => {
        const { app } = makeApp();
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const nodeDetails = view.el.querySelector('details.ol-setup-node');
        nodeDetails.open = true;

        const idInput = nodeDetails.querySelector('input.ol-input');
        idInput.value = 'analyzer';
        idInput.dispatchEvent(new Event('change'));

        const updatedDetails = view.el.querySelector('details.ol-setup-node');
        expect(updatedDetails.open).toBe(true);
        expect(updatedDetails.querySelector('.ol-setup-name')?.textContent).toBe('analyzer');

        const overrideSwitch = updatedDetails.querySelector('.ol-setup-override [role="switch"]');
        overrideSwitch.click();
        expect(app.drafts.get('analyzer', 'tools')).not.toBe('');
        expect(app.drafts.get('distiller', 'tools')).toBe('');
        view.el.remove();
    });

    test('refreshes skill inventory cache when Manage skills closes and on reload', async () => {
        const openSkillManagerFn = jest.fn(async () => {});
        const inventoryFn = jest.fn(async () => [{ name: 's1', description: 'd1' }]);
        const { app } = makeApp({ openSkillManagerFn, inventoryFn });
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();
        await Promise.resolve();
        expect(inventoryFn).toHaveBeenCalledTimes(1);

        const manageBtn = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('管理 Skills') || b.textContent.includes('Manage skills'));
        expect(manageBtn).toBeTruthy();
        manageBtn.click();
        await new Promise(r => setTimeout(r, 10));
        expect(openSkillManagerFn).toHaveBeenCalledTimes(1);
        expect(inventoryFn).toHaveBeenCalledTimes(2);

        view.invalidate?.();
        view.render(true);
        await Promise.resolve();
        expect(inventoryFn).toHaveBeenCalledTimes(3);
        view.el.remove();
    });

    test('pickFile settles to null when user cancels file dialog without hanging', async () => {
        const { app } = makeApp();
        const view = createSetupView(app);
        document.body.appendChild(view.el);
        view.render();

        const origCreate = document.createElement.bind(document);
        let fileInput = null;
        const spy = jest.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
            const node = origCreate(tag, ...rest);
            if (tag === 'input') {
                fileInput = node;
                node.click = () => {
                    setTimeout(() => node.dispatchEvent(new Event('cancel')), 0);
                };
            }
            return node;
        });

        const importBtn = [...view.el.querySelectorAll('button')].find(b => b.textContent.includes('导入') || b.textContent.includes('Import'));
        expect(importBtn).toBeTruthy();
        importBtn.click();
        await new Promise(r => setTimeout(r, 30));
        expect(fileInput).not.toBeNull();
        expect(app.source.presets.parseImport).not.toHaveBeenCalled();

        spy.mockRestore();
        view.el.remove();
    });
});
