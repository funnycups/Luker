// Director profile load-shape regression (bug fixed 2026-05-28).
//
// Memory: known_bug_director_override_load_shape. The director profile
// JSON used to nest its fields under a `director:` key. Now flattened to
// match loop/agenda. The sanitizer auto-detects legacy nested input and
// lifts the fields to the top level.
//
// This is a pure data-shape unit test. The original e2e/#69 file drove
// `sanitizeDirectorProfile` in the browser via page.evaluate, but there
// is no UI affordance to "load a preset object from JSON" — the editor
// reads from preset-library, which itself runs sanitization on read.
// Drive the sanitizer directly here so the regression is locked in
// without spinning up a browser.

import { describe, test, expect } from '@jest/globals';

globalThis.Luker = globalThis.Luker || {
    getContext: () => ({
        translate: (s) => String(s ?? ''),
        addLocaleData: () => {},
    }),
};

const { sanitizeDirectorProfile } = await import(
    '../../public/scripts/extensions/orchestrator/director-defaults.js'
);

const INNER = {
    mainAgent: {
        promptPresetName: 'director-main',
        apiPresetName: 'director-claude',
        systemPrompt: 'You are the cliff-watch coordinator. Synthesize the scouts\' reports.',
        tools: null,
    },
    subAgents: [
        {
            id: 'scout_north',
            description: 'Read the northern reef line for unusual hull silhouettes.',
            systemPrompt: 'You are scout_north. Examine the chart between marker pairs A-B and B-C and report any anomaly.',
            tools: null,
            maxRounds: 6,
        },
        {
            id: 'scout_south',
            description: 'Read the southern reef line.',
            systemPrompt: 'You are scout_south. Mirror scout_north on the southern section.',
            tools: null,
            maxRounds: 6,
        },
    ],
    maxRounds: 12,
    maxConcurrentSubagents: 2,
    maxTotalSubagentRuns: 10,
    discardOnAbort: true,
};

describe('sanitizeDirectorProfile — flat vs legacy nested vs bare', () => {
    test('flat input → flat output (no `director:` wrapper)', () => {
        const out = sanitizeDirectorProfile({ mode: 'director', ...INNER });
        expect(out).toBeTruthy();
        expect(Object.prototype.hasOwnProperty.call(out, 'director')).toBe(false);
        expect(out.mode).toBe('director');
        expect(out.mainAgent.systemPrompt).toContain('cliff-watch coordinator');
        expect(out.subAgents.length).toBe(2);
        expect(out.subAgents.map(a => a.id).sort()).toEqual(['scout_north', 'scout_south']);
        expect(out.maxRounds).toBe(12);
        expect(out.maxConcurrentSubagents).toBe(2);
        expect(out.maxTotalSubagentRuns).toBe(10);
        expect(out.discardOnAbort).toBe(true);
    });

    test('legacy nested input (`director:` wrapper) → flat output', () => {
        const out = sanitizeDirectorProfile({ mode: 'director', director: INNER });
        expect(Object.prototype.hasOwnProperty.call(out, 'director')).toBe(false);
        expect(out.mode).toBe('director');
        expect(out.mainAgent.systemPrompt).toContain('cliff-watch coordinator');
        expect(out.subAgents.length).toBe(2);
        expect(out.subAgents.map(a => a.id).sort()).toEqual(['scout_north', 'scout_south']);
        expect(out.maxRounds).toBe(12);
    });

    test('bare sub-object (character-card override style) → flat output', () => {
        const out = sanitizeDirectorProfile({ ...INNER });
        expect(Object.prototype.hasOwnProperty.call(out, 'director')).toBe(false);
        expect(out.mode).toBe('director');
        expect(out.subAgents.length).toBe(2);
        expect(out.mainAgent.systemPrompt).toContain('cliff-watch coordinator');
    });

    test('flat output is deep-equal to nested-lifted output (the core regression contract)', () => {
        const flatOut = sanitizeDirectorProfile({ mode: 'director', ...INNER });
        const nestedOut = sanitizeDirectorProfile({ mode: 'director', director: INNER });
        const norm = (o) => JSON.parse(JSON.stringify(o));
        expect(norm(flatOut)).toEqual(norm(nestedOut));
    });

    test('sanitizer is idempotent — re-sanitizing produces the same shape (no director wrapper appears)', () => {
        const once = sanitizeDirectorProfile({ mode: 'director', ...INNER });
        const twice = sanitizeDirectorProfile(once);
        expect(twice.mainAgent.systemPrompt).toBe(once.mainAgent.systemPrompt);
        expect(twice.subAgents.length).toBe(once.subAgents.length);
        expect(twice.maxRounds).toBe(once.maxRounds);
        expect(Object.prototype.hasOwnProperty.call(twice, 'director')).toBe(false);
    });
});
