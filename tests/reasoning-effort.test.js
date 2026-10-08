// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import {
    REASONING_TOKENS,
    REASONING_EFFORT_BY_SOURCE,
    REASONING_EFFORT_LABEL_KEYS,
    REASONING_EFFORT_LABELS,
    getReasoningOptions,
    getReasoningHint,
    supportsReasoningOutput,
    buildReasoningEffortBySource,
} from '../public/scripts/reasoning-effort.js';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const openaiSrc = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const block = openaiSrc.match(/export const chat_completion_sources = \{([\s\S]*?)\n\};/)[1];
const sources = [...block.matchAll(/:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('descriptor completeness', () => {
    test('every chat completion source has a descriptor entry', () => {
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) {
            expect(REASONING_EFFORT_BY_SOURCE).toHaveProperty(source);
        }
    });
    test('every option is a canonical token and auto is first', () => {
        for (const descriptor of Object.values(REASONING_EFFORT_BY_SOURCE)) {
            for (const option of descriptor.options) {
                expect(REASONING_TOKENS).toContain(option);
            }
            expect(descriptor.options[0] ?? 'auto').toBe('auto');
        }
    });
    test('ai21 exposes no control and no output', () => {
        expect(getReasoningOptions('ai21')).toEqual([]);
        expect(supportsReasoningOutput('ai21')).toBe(false);
    });
    test('xai has no off', () => {
        expect(getReasoningOptions('xai')).not.toContain('off');
    });
    test('openrouter is a varies hint', () => {
        expect(getReasoningHint('openrouter')).toBe('varies');
    });
});

describe('REASONING_EFFORT_LABEL_KEYS', () => {
    test('covers every canonical token', () => {
        for (const token of REASONING_TOKENS) {
            expect(REASONING_EFFORT_LABEL_KEYS).toHaveProperty(token);
        }
    });
    test('every key is a data-i18n attribute present in index.html', () => {
        for (const key of Object.values(REASONING_EFFORT_LABEL_KEYS)) {
            expect(indexHtml).toContain(`data-i18n="${key}"`);
        }
    });
});

describe('REASONING_EFFORT_LABELS', () => {
    const expected = {
        auto: 'Auto',
        off: 'Off',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Max',
    };
    test('covers every canonical token', () => {
        for (const token of REASONING_TOKENS) {
            expect(REASONING_EFFORT_LABELS).toHaveProperty(token);
        }
    });
    test('uses the exact English labels, not raw keys', () => {
        expect(REASONING_EFFORT_LABELS).toEqual(expected);
        for (const token of REASONING_TOKENS) {
            expect(REASONING_EFFORT_LABELS[token]).not.toBe(REASONING_EFFORT_LABEL_KEYS[token]);
        }
    });
});

describe('buildReasoningEffortBySource', () => {
    test('seeds each source from a valid legacy token', () => {
        const map = buildReasoningEffortBySource('high');
        expect(map.openai).toBe('high');
        expect(map.deepseek).toBe('high');
    });
    test('falls back to auto where the legacy token is not offered', () => {
        const map = buildReasoningEffortBySource('xhigh');
        expect(map.xai).toBe('xhigh');
        expect(map.cohere).toBe('auto');
    });
    test('normalizes legacy min to minimal', () => {
        const map = buildReasoningEffortBySource('min');
        expect(map.openai).toBe('minimal');
    });
    test('skips sources without options', () => {
        const map = buildReasoningEffortBySource('high');
        expect(map).not.toHaveProperty('ai21');
    });
});
