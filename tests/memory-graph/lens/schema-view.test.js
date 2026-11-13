/**
 * @jest-environment jsdom
 */
import './_mocks/luker-zh.js';
import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createSchemaView } from '../../../public/scripts/extensions/memory-graph/lens/schema/schema-view.js';

const clone = (v) => JSON.parse(JSON.stringify(v));

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

const SCHEMA_TYPES = [
    {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['summary'],
        embeddingColumns: ['summary'],
        columnHints: { summary: 'Event summary' },
        requiredColumns: ['summary'],
        extractHint: 'Critical plot events',
        extractionInstructions: 'EVENT RULES',
        alwaysInject: true,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: { mode: 'hierarchical', threshold: 5, fanIn: 3, maxDepth: 10, keepRecentLeaves: 3, summarizeInstruction: 'COMPRESS' },
    },
    {
        id: 'character_sheet',
        label: 'Character Sheet',
        tableName: 'character_table',
        tableColumns: ['title', 'aliases', 'identity'],
        embeddingColumns: ['title', 'aliases'],
        columnHints: { title: 'Name', aliases: 'Nicknames', identity: 'Identity' },
        requiredColumns: ['title'],
        extractHint: 'Character facts',
        extractionInstructions: 'CHAR RULES',
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['title'],
        compression: { mode: 'none', threshold: 6, fanIn: 3, maxDepth: 6, keepRecentLeaves: 0, summarizeInstruction: '' },
    },
];

describe('schema-view fixes & Workbench AI navigation', () => {
    let openSpy;

    beforeEach(() => {
        document.body.innerHTML = '';
        globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
        globalThis.cancelAnimationFrame = () => {};
        openSpy = jest.fn();
        const prevGetContext = globalThis.Luker.getContext;
        const baseCtx = prevGetContext();
        globalThis.Luker = {
            getContext: () => ({
                ...baseCtx,
                workbench: { open: openSpy },
            }),
        };
    });

    function mountSchemaView(writeSpy = jest.fn(async () => ({}))) {
        const app = {
            root: document.createElement('div'),
            model: () => ({ typeCounts: new Map([['event', 2], ['character_sheet', 1]]) }),
            isCompact: () => false,
            reload: jest.fn(),
            showToast: jest.fn(),
            openStatus: jest.fn(),
        };
        const source = {
            schema: {
                read: async () => ({
                    scope: 'global',
                    hasCharacter: true,
                    avatar: 'alice.png',
                    characterName: 'Alice',
                    types: clone(SCHEMA_TYPES),
                    defaults: clone(SCHEMA_TYPES),
                    labels: {},
                }),
                write: writeSpy,
                restore: jest.fn(async () => {}),
                clearCharacter: jest.fn(async () => true),
            },
        };
        const view = createSchemaView(app, source);
        app.root.appendChild(view.el);
        document.body.appendChild(app.root);
        return { app, source, view, writeSpy };
    }

    test('renders compression toggle unconditionally for non-event types', async () => {
        const { view } = mountSchemaView();
        view.render();
        await flushMicrotasks();

        const typeButtons = [...view.el.querySelectorAll('.ml-schema-type')];
        expect(typeButtons.length).toBe(2);
        typeButtons[1].click(); // select character_sheet (compression mode: none)
        await flushMicrotasks();

        const flagSwitches = [...view.el.querySelectorAll('.ml-schema-flag')];
        expect(flagSwitches.length).toBe(3);
    });

    test('renders primaryKeyColumns multi-select checkboxes and saves updated keys with expectedAvatar', async () => {
        const writeSpy = jest.fn(async () => ({}));
        const { app, view } = mountSchemaView(writeSpy);
        view.render();
        await flushMicrotasks();

        const typeButtons = [...view.el.querySelectorAll('.ml-schema-type')];
        typeButtons[1].click();
        await flushMicrotasks();

        const pkLabel = [...view.el.querySelectorAll('.ml-aiset-label')]
            .find(el => el.textContent.includes('主键') || el.textContent.includes('Primary Key'));
        expect(pkLabel).toBeTruthy();

        const pkField = pkLabel.closest('.ml-aiset-field');
        const checkboxes = [...pkField.querySelectorAll('[role="checkbox"]')];
        expect(checkboxes.length).toBe(3);
        expect(checkboxes[0].getAttribute('aria-checked')).toBe('true');
        expect(checkboxes[1].getAttribute('aria-checked')).toBe('false');

        // Toggle 'aliases' into primaryKeyColumns
        checkboxes[1].click();
        await flushMicrotasks();

        // Switch scope to character so expectedAvatar is passed
        const scopeButtons = [...view.el.querySelectorAll('.ml-schema-scope-seg [role="group"] button, .ml-schema-scope-seg button')];
        scopeButtons[1].click();
        await flushMicrotasks();

        const saveBtn = [...view.el.querySelectorAll('.ml-schema-actions button')].at(-1);
        expect(saveBtn.disabled).toBe(false);
        saveBtn.click();
        await flushMicrotasks();

        const confirmBtn = [...app.root.querySelectorAll('.ml-dialog-backdrop button')].at(-1);
        expect(confirmBtn).toBeTruthy();
        confirmBtn.click();
        await flushMicrotasks();

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const [writtenTypes, writeOpts] = writeSpy.mock.calls[0];
        expect(writtenTypes[1].primaryKeyColumns).toEqual(['title', 'aliases']);
        expect(writeOpts.scope).toBe('character');
        expect(writeOpts.expectedAvatar).toBe('alice.png');
    });

    test('AI configure buttons navigate to Workbench AI page for memory', async () => {
        const { view } = mountSchemaView();
        view.render();
        await flushMicrotasks();

        const aiBtn = view.el.querySelector('.ml-schema-aibtn');
        expect(aiBtn).toBeTruthy();
        aiBtn.click();
        expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ page: 'ai', ws: 'memory' }));

        const typeAiBtn = view.el.querySelector('.ml-schema-suggest');
        expect(typeAiBtn).toBeTruthy();
        typeAiBtn.click();
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(openSpy.mock.calls[1][0]).toEqual(expect.objectContaining({ page: 'ai', ws: 'memory' }));
    });
});
