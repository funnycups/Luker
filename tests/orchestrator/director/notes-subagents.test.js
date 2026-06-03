import { describe, test, expect } from '@jest/globals';
import { createDefaultDirectorProfile } from '../../../public/scripts/extensions/orchestrator/director-defaults.js';

describe('default director profile: notes sub-agents', () => {
    test('includes notes_pickup_scout', () => {
        const profile = createDefaultDirectorProfile();
        const scout = profile.subAgents.find(a => a.id === 'notes_pickup_scout');
        expect(scout).toBeDefined();
        expect(String(scout.description || '').length).toBeGreaterThan(40);
        expect(String(scout.systemPrompt || '').length).toBeGreaterThan(200);
    });

    test('includes notes_curator', () => {
        const profile = createDefaultDirectorProfile();
        const curator = profile.subAgents.find(a => a.id === 'notes_curator');
        expect(curator).toBeDefined();
        expect(String(curator.description || '').length).toBeGreaterThan(40);
        expect(String(curator.systemPrompt || '').length).toBeGreaterThan(200);
        // 反污染必须在 prompt 里
        expect(curator.systemPrompt.toLowerCase()).toMatch(/do.{0,5}nothing|conservative|default.{0,15}do nothing/);
    });
});

describe('default director profile: intent_scout', () => {
    test('includes intent_scout with description + systemPrompt', () => {
        const profile = createDefaultDirectorProfile();
        const scout = profile.subAgents.find(a => a.id === 'intent_scout');
        expect(scout).toBeDefined();
        expect(String(scout.description || '').length).toBeGreaterThan(40);
        expect(String(scout.systemPrompt || '').length).toBeGreaterThan(200);
    });

    test('intent_scout is positioned among pre-draft scouts (before mid-stage brainstormer)', () => {
        const profile = createDefaultDirectorProfile();
        const ids = profile.subAgents.map(a => a.id);
        const intentIdx = ids.indexOf('intent_scout');
        const brainstormerIdx = ids.indexOf('plot_brainstormer');
        const curatorIdx = ids.indexOf('notes_curator');
        expect(intentIdx).toBeGreaterThanOrEqual(0);
        expect(intentIdx).toBeLessThan(brainstormerIdx);
        expect(intentIdx).toBeLessThan(curatorIdx);
    });
});
