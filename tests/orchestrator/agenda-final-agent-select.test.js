/** @jest-environment jsdom */

import { describe, test, expect } from '@jest/globals';

// The agenda final agent select marks the option of the stored agent key
// the editor's final agent id resolves to. Agent keys are stored
// verbatim, so a whitespace-padded key is selected by its trimmed id and
// an ambiguous id is listed as missing.

globalThis.Luker = {
    getContext: () => ({
        extensionSettings: {},
        translate: (s) => String(s ?? ''),
        getCurrentLocale: () => 'en',
        addLocaleData: () => {},
    }),
};

const { buildAgendaFinalAgentSelectModel, validateStructure } = await import('../../public/scripts/extensions/orchestrator/lens/model/edit.js');
const { buildFlow } = await import('../../public/scripts/extensions/orchestrator/lens/model/profile.js');
const { selectInput } = await import('../../public/scripts/extensions/orchestrator/lens/views/setup-view.js');

describe('agenda final agent select', () => {
    const PADDED = ' 守夜';

    test('selects a whitespace-padded agent by its trimmed id', () => {
        const model = buildAgendaFinalAgentSelectModel({ finalizer: {}, [PADDED]: {} }, '守夜');
        const select = selectInput(model.options, model.value, () => {});
        expect(select.value).toBe(PADDED);
        expect([...select.options].map(o => o.textContent)).not.toContain('守夜 (missing)');
        expect(validateStructure('agenda', { agents: { finalizer: {}, [PADDED]: {} }, finalAgentId: '守夜' })).toEqual([]);
        const flow = buildFlow({ agents: { finalizer: {}, [PADDED]: {} }, finalAgentId: '守夜', planner: {} }, { mode: 'agenda' });
        expect(flow.agents[PADDED]?.kind).toBe('final');
    });

    test('lists an id matching several padded agents as missing', () => {
        const model = buildAgendaFinalAgentSelectModel({ ' 守夜': {}, '守夜 ': {} }, '守夜');
        const select = selectInput(model.options, model.value, () => {});
        expect(select.value).toBe('守夜');
        const selectedOption = [...select.options].find(o => o.selected);
        expect(selectedOption?.textContent).toBe('守夜 (missing)');
        expect(validateStructure('agenda', { agents: { ' 守夜': {}, '守夜 ': {} }, finalAgentId: '守夜' })).toHaveLength(1);
    });
});
