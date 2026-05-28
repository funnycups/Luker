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

    test('intent_scout prompt covers both sources (user input + lorebook authoring directives)', () => {
        const profile = createDefaultDirectorProfile();
        const scout = profile.subAgents.find(a => a.id === 'intent_scout');
        const body = scout.systemPrompt;
        // Source 1: user input — explicit, OOC asides, implicit signals
        expect(body).toMatch(/explicit ask/i);
        expect(body.toLowerCase()).toMatch(/parenthetical|ooc|aside/);
        expect(body.toLowerCase()).toMatch(/implicit signal/);
        // Source 2: lorebook authoring directives — categories
        expect(body.toLowerCase()).toMatch(/authoring.{0,10}directive|meta.{0,5}directive/);
        expect(body).toMatch(/style/i);
        expect(body).toMatch(/pacing/i);
        expect(body).toMatch(/constraint/i);
        expect(body.toLowerCase()).toMatch(/output spec|output specification/);
    });

    test('intent_scout carries the no-prescription discipline', () => {
        const profile = createDefaultDirectorProfile();
        const scout = profile.subAgents.find(a => a.id === 'intent_scout');
        // Must explicitly forbid prescribing action / direction for the main agent
        expect(scout.systemPrompt.toLowerCase()).toMatch(/prescribe action|prescribe.{0,10}direction|interpretation is the main agent/);
        // Must explicitly call out the implicit-signal-into-preference trap
        expect(scout.systemPrompt.toLowerCase()).toMatch(/interpret implicit signal|preference claim/);
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
