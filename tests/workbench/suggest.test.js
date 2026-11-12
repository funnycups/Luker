// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { runRules, listRules, similarity, RULES } from '../../public/scripts/workbench/model/suggest.js';

const ids = (list) => list.map(s => s.id);

describe('workbench suggest rules & SuggestRuleProvider registry integration', () => {
    test('quiet snapshot gives no suggestions with zero providers', () => {
        expect(runRules({})).toEqual([]);
        expect(runRules({
            preset: { name: 'p', prompts: [{ id: 1, name: 'Style', text: 'Completely unique style prompt text.', enabled: true }] },
            card: { pending: 0 },
        })).toEqual([]);
    });

    test('core preset.dup is off by default and card.pending sorts first', () => {
        const text = 'Write vivid prose focusing on sensory details and avoid modern slang.';
        const snap = {
            preset: {
                name: 'p',
                prompts: [
                    { id: 1, name: 'Style', text, enabled: true },
                    { id: 2, name: 'Style 2', text: `${text} Keep it brief.`, enabled: true },
                ],
            },
            card: { pending: 3, sessionTitle: 'Tighten prose', sessionId: 's1' },
        };

        expect(ids(runRules(snap))).toEqual(['card.pending']);
        expect(ids(runRules(snap, { enabled: { 'preset.dup': true } }))).toEqual(['card.pending', 'preset.dup']);
        expect(similarity(text, text)).toBeGreaterThan(0.99);
        expect(similarity(text, 'A completely unrelated sentence about astrophysics and telescopes.')).toBeLessThan(0.3);
        expect(RULES.length).toBeGreaterThanOrEqual(2);
    });

    test('integrates SuggestRuleProvider rules and respects enabled/dismissed state', () => {
        const provider = {
            id: 'mock-ext',
            rules: [
                {
                    id: 'ext.highLoad',
                    tone: 'memory',
                    name: 'High load',
                    when: 'load > 100',
                    defaultOn: true,
                    check: (snap) => (snap.ext?.load > 100
                        ? {
                            text: `Load is ${snap.ext.load}`,
                            why: 'Load exceeded 100',
                            source: 'Mock extension',
                            sig: `${Math.round(snap.ext.load / 50)}`,
                            actions: [],
                        }
                        : null),
                },
            ],
        };

        const allRules = listRules([provider]);
        expect(allRules.map(r => r.id)).toContain('ext.highLoad');

        const snap = { ext: { load: 160 }, card: { pending: 1, sessionId: 's1' } };
        expect(ids(runRules(snap, { providers: [provider] }))).toEqual(['card.pending', 'ext.highLoad']);
        expect(ids(runRules(snap, { enabled: { 'ext.highLoad': false }, providers: [provider] }))).toEqual(['card.pending']);
        expect(ids(runRules(snap, { dismissed: { 'ext.highLoad': '3' }, providers: [provider] }))).toEqual(['card.pending']);
        expect(ids(runRules({ ext: { load: 260 } }, { dismissed: { 'ext.highLoad': '3' }, providers: [provider] }))).toEqual(['ext.highLoad']);
    });
});
