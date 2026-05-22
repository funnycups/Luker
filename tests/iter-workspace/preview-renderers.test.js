// tests/iter-workspace/preview-renderers.test.js
import { describe, test, expect, beforeAll, jest } from '@jest/globals';

// public/lib.js pulls in a browser bundle that can't be resolved under jest.
// Mirror the same workaround used by tests/cpa-iteration/tools.test.js:
// stub the facade to a thin { lodash } re-export.
jest.unstable_mockModule('../../public/lib.js', async () => {
    const { default: lodash } = await import('lodash');
    return {
        lodash,
        // showdown / DOMPurify are pulled in by render.js; stub to minimum.
        showdown: {
            Converter: class {
                makeHtml(text) { return `<p>${text}</p>`; }
            },
        },
        DOMPurify: {
            sanitize: (html) => html,
        },
    };
});

// popup.js drags in the entire UI shell — stub to no-op exports.
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    Popup: class { constructor() {} show() { return Promise.resolve(); } },
    POPUP_TYPE: { DISPLAY: 0 },
}));

// Runner pulls in iter-tool-calling which needs the LLM stack — stub.
jest.unstable_mockModule('../../public/scripts/lib/iter-tool-calling.js', () => ({
    requestToolCallsWithRetry: jest.fn(),
    buildExecutionToolCalls: jest.fn(),
    buildPendingToolResults: jest.fn(),
    buildPersistentToolCallsFromRawCalls: jest.fn(),
    buildPersistentToolHistoryMessages: jest.fn(),
    createPersistentToolTurnMessage: jest.fn(),
    makeAiIterationMessageId: jest.fn(() => 'id'),
}));

jest.unstable_mockModule('../../public/scripts/lib/abort-utils.js', () => ({}));

let _testOnly_renderCpaPreviewPane;

beforeAll(async () => {
    const mod = await import('../../public/scripts/extensions/completion-preset-assistant/cpa-iteration/studio.js');
    _testOnly_renderCpaPreviewPane = mod._testOnly_renderCpaPreviewPane;
});

describe('renderCpaPreviewPane', () => {
    const sampleLive = {
        temperature: 0.7,
        top_p: 1.0,
        top_k: 40,
        freq_pen: 0,
        pres_pen: 0,
        prompts: [
            { identifier: 'main', name: 'Main prompt', role: 'system', content: 'You are a helpful assistant.' },
            { identifier: 'persona', name: 'Persona', role: 'system', content: 'Speak in a calm tone.' },
        ],
    };

    test('renders Sampling params section with current temperature value', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, []);
        expect(html).toMatch(/temperature/i);
        expect(html).toContain('0.7');
    });

    test('renders Prompts section with prompt names', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, []);
        expect(html).toContain('Main prompt');
        expect(html).toContain('Persona');
    });

    test('marks a sampling-param row .pending-change when a pending edit modifies it', () => {
        // Real `set` op shape: { op, path, oldValue, newValue }.
        const edit = { op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.85 };
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [edit]);
        expect(html).toContain('pending-change');
        expect(html).toContain('0.85');
    });

    test('empty-state when live is null', () => {
        const html = _testOnly_renderCpaPreviewPane(null, []);
        expect(html).toMatch(/no preset loaded|未加载预设|未載入預設/i);
    });

    test('inline pending diff shows old → new value with English source phrasing', () => {
        const edit = { op: 'set', path: 'temperature', oldValue: 0.7, newValue: 0.85 };
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [edit]);
        // The source format is (was X → now Y); locale-specific translations may differ.
        expect(html).toMatch(/was.*0\.7.*now.*0\.85|0\.7.*0\.85/);
    });

    test('saved-presets aside renders when savedPresets is non-empty + clickable rows have ref-name attr', () => {
        const html = _testOnly_renderCpaPreviewPane(sampleLive, [], ['PresetA', 'PresetB'], 'PresetA');
        expect(html).toContain('PresetA');
        expect(html).toContain('PresetB');
        expect(html).toContain('data-cpa-it-preview-action="ref-pick"');
        expect(html).toContain('data-cpa-it-ref-name="PresetA"');
    });
});
