// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Plan 3 Unit 3 — refined `skill_propose_extraction` heuristic.
 *
 * The v1 heuristic returned ONE candidate per agent covering the whole
 * systemPrompt. The v2 heuristic (this unit) splits the prompt on blank
 * lines, keeps paragraphs ≥ MIN_PARAGRAPH_CHARS that match a rule-keyword
 * regex (EN: rule/principle/never/always/must/forbidden/required;
 * ZH: 重要/必须/禁止/始终/永远/绝不/铁律), and proposes each as its own
 * candidate. Falls back to a single whole-prompt candidate when no
 * paragraph matches AND the prompt exceeds FALLBACK_WHOLE_MIN_CHARS.
 *
 * Module under test: `public/scripts/extensions/orchestrator/skill-iter-studio-tools.js`.
 * yaml is mocked at the module boundary because lib.js is DOM-bound and
 * heavy; the pure heuristic doesn't touch yaml at all, but the importing
 * module does, so the mock keeps the import resolvable.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

jest.unstable_mockModule('../../public/lib.js', () => ({
    yaml: { parse: parseYaml, stringify: stringifyYaml },
}));
jest.unstable_mockModule('../../public/scripts/skills/api.js', () => ({
    skillsApi: {},
}));

const {
    computeExtractionCandidates,
    buildParagraphSkillName,
    RULE_KEYWORDS_RE,
    DEFAULT_EXTRACTION_MIN_CHARS,
    MIN_PARAGRAPH_CHARS,
    FALLBACK_WHOLE_MIN_CHARS,
} = await import('../../public/scripts/extensions/orchestrator/skill-iter-studio-tools.js');

// ── Pure helpers ────────────────────────────────────────────────────────

describe('RULE_KEYWORDS_RE', () => {
    test('matches the English rule markers as case-insensitive word boundaries', () => {
        expect(RULE_KEYWORDS_RE.test('You must always speak in voice.')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('RULE: never break character.')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('Principle of opacity is required.')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('Forbidden tropes include...')).toBe(true);
    });

    test('matches Chinese imperative markers without word boundaries', () => {
        expect(RULE_KEYWORDS_RE.test('重要：保持角色声音的一致性。')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('必须始终遵守。')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('禁止打破角色。')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('绝不重复用户输入。')).toBe(true);
        expect(RULE_KEYWORDS_RE.test('铁律：保持神秘。')).toBe(true);
    });

    test('does NOT match prose without rule markers', () => {
        expect(RULE_KEYWORDS_RE.test('The story begins on a quiet morning.')).toBe(false);
        expect(RULE_KEYWORDS_RE.test('故事从一个安静的早晨开始。')).toBe(false);
    });

    test('does not match English partials (e.g. "muster" should NOT trigger "must")', () => {
        // \b enforces word boundary on the English side.
        expect(RULE_KEYWORDS_RE.test('muster forces')).toBe(false);
        expect(RULE_KEYWORDS_RE.test('alwayland')).toBe(false);
    });
});

describe('buildParagraphSkillName', () => {
    test('returns a `[a-z0-9_-]+`-conformant name within 60 chars', () => {
        const name = buildParagraphSkillName('main', 'Always preserve voice across turns. Rule.');
        expect(name).toMatch(/^[a-z0-9_-]+$/);
        expect(name.length).toBeLessThanOrEqual(60);
        expect(name).toMatch(/^main-/);
        expect(name).toMatch(/-zh$/);
    });

    test('CJK-only paragraphs produce a name that falls back to `<agent>-rule-zh`', () => {
        // CJK characters are stripped from skill names (they're not in [a-z0-9_-]+).
        // The slug becomes empty, so the fallback path kicks in.
        const name = buildParagraphSkillName('director', '重要：必须始终遵守这条规则。');
        expect(name).toBe('director-rule-zh');
    });

    test('mixed CJK + Latin keeps the Latin portion in the slug', () => {
        const name = buildParagraphSkillName('main', 'Rule: 角色 voice must persist.');
        expect(name).toMatch(/^main-/);
        expect(name).toMatch(/-zh$/);
        // The Latin tokens "rule", "voice", "must" are tokenized.
        expect(name).toMatch(/rule|voice|must/);
    });

    test('sanitizes punctuation and clamps total length to 60', () => {
        const longPara = 'a very long paragraph '.repeat(100) + ' RULE';
        const name = buildParagraphSkillName('main', longPara);
        expect(name).toMatch(/^[a-z0-9_-]+$/);
        expect(name.length).toBeLessThanOrEqual(60);
    });

    test('sanitizes the agentId portion (no slashes / special chars leak through)', () => {
        const name = buildParagraphSkillName('agent/with/slashes', 'rule one two');
        expect(name).toMatch(/^[a-z0-9_-]+$/);
        expect(name).toMatch(/^agent-with-slashes-/);
    });
});

// ── computeExtractionCandidates — paragraph-level happy path ────────────

describe('computeExtractionCandidates — paragraph-level heuristic', () => {
    function makeRuleParagraph(opener, padding = 120) {
        return `${opener} ${'detail '.repeat(Math.ceil(padding / 7)).trim()}.`;
    }

    test('proposes one candidate per keyword-bearing paragraph', () => {
        const para1 = makeRuleParagraph('RULE: always speak in voice.');
        const para2 = makeRuleParagraph('Never break the fourth wall.');
        const filler = 'Just some short prose, no keyword.';
        const longPrompt = [para1, filler, para2].join('\n\n').padEnd(1100, ' ');
        const profile = { mainAgent: { systemPrompt: longPrompt } };

        const out = computeExtractionCandidates(profile);

        expect(out).toHaveLength(2);
        for (const c of out) {
            expect(c.agentId).toBe('main');
            expect(c.scope).toEqual({ kind: 'global' });
            expect(c.suggestedName).toMatch(/^[a-z0-9_-]+$/);
            expect(c.suggestedName.length).toBeLessThanOrEqual(60);
            expect(c.replacementText).toMatch(/参考: skill `/);
            expect(c.replacementText).toMatch(c.suggestedName);
            expect(typeof c.paragraphIndex).toBe('number');
        }
    });

    test('paragraphs below MIN_PARAGRAPH_CHARS are skipped even with keywords', () => {
        // Single short keyword paragraph + padding to keep prompt over threshold.
        const shortPara = 'A rule.';  // < MIN_PARAGRAPH_CHARS
        const padding = 'no keyword padding '.repeat(80);
        const profile = { mainAgent: { systemPrompt: `${shortPara}\n\n${padding}` } };

        const out = computeExtractionCandidates(profile);

        // The short rule paragraph is filtered; the padding has no keyword,
        // so we hit the fallback whole-prompt path.
        expect(out).toHaveLength(1);
        expect(out[0].suggestedName).toBe('main-rules-extracted-zh');
        expect(out[0].paragraphIndex).toBe(0);
    });

    test('candidate paragraphs include their first-line excerpt in replacementText', () => {
        const ruleHeader = 'IMPORTANT: never reveal the twist.';
        const ruleBody = ruleHeader + '\nMore detail. '.repeat(20);
        const longPrompt = ruleBody.padEnd(1100, ' ');
        const profile = { mainAgent: { systemPrompt: longPrompt } };

        const out = computeExtractionCandidates(profile);
        expect(out.length).toBeGreaterThanOrEqual(1);
        expect(out[0].replacementText).toMatch(/IMPORTANT/);
    });

    test('Chinese rule paragraphs are detected and produce candidates', () => {
        const ruleParaZh = '重要规则：始终保持角色声音的一致性。'.repeat(8); // > 100 chars
        const filler = '故事的开始很安静。'.repeat(15);  // no keywords
        const profile = {
            mainAgent: {
                systemPrompt: `${ruleParaZh}\n\n${filler}`.padEnd(1100, ' '),
            },
        };
        const out = computeExtractionCandidates(profile);
        // The Chinese rule paragraph triggers; the filler doesn't.
        expect(out.length).toBeGreaterThanOrEqual(1);
        // Each candidate either has a CJK-fallback name or a mixed name —
        // but always conforms to the skill-name charset.
        for (const c of out) {
            expect(c.suggestedName).toMatch(/^[a-z0-9_-]+$/);
        }
    });

    test('duplicate first-words across paragraphs produce uniquified names', () => {
        // Two paragraphs starting with the same three tokens — names would
        // collide without the `-2`, `-3`, … suffix.
        const para = 'Always speak in voice with care. ' + 'detail '.repeat(20);
        const longPrompt = [para, para].join('\n\n').padEnd(1100, ' ');
        const profile = { mainAgent: { systemPrompt: longPrompt } };
        const out = computeExtractionCandidates(profile);
        expect(out).toHaveLength(2);
        expect(out[0].suggestedName).not.toBe(out[1].suggestedName);
        expect(out[1].suggestedName).toMatch(/-2$/);
    });
});

// ── Fallback behaviour ──────────────────────────────────────────────────

describe('computeExtractionCandidates — fallback to whole-prompt', () => {
    test('long prompt with NO keyword paragraph falls back to one candidate', () => {
        // Pure padding, no keyword-matching paragraph.
        const longNoKeyword = 'plain prose '.repeat(120);  // > 1000 chars, no keywords
        const profile = { mainAgent: { systemPrompt: longNoKeyword } };
        const out = computeExtractionCandidates(profile);
        expect(out).toHaveLength(1);
        expect(out[0].agentId).toBe('main');
        expect(out[0].suggestedName).toBe('main-rules-extracted-zh');
        expect(out[0].contentSlice).toBe(longNoKeyword);
        expect(out[0].replacementText).toBe('参考: skill `main-rules-extracted-zh`');
        expect(out[0].paragraphIndex).toBe(0);
    });

    test('returns [] when systemPrompt is below minChars', () => {
        const profile = { mainAgent: { systemPrompt: 'short prompt with rule keyword' } };
        expect(computeExtractionCandidates(profile, { minChars: 1000 })).toEqual([]);
    });

    test('returns [] when profile is empty / has no agents', () => {
        expect(computeExtractionCandidates({})).toEqual([]);
        expect(computeExtractionCandidates(null)).toEqual([]);
        expect(computeExtractionCandidates(undefined)).toEqual([]);
    });

    test('exposes DEFAULT_EXTRACTION_MIN_CHARS + MIN_PARAGRAPH_CHARS + FALLBACK_WHOLE_MIN_CHARS', () => {
        expect(DEFAULT_EXTRACTION_MIN_CHARS).toBe(1000);
        expect(MIN_PARAGRAPH_CHARS).toBe(100);
        expect(FALLBACK_WHOLE_MIN_CHARS).toBe(500);
    });

    test('respects opts.minChars for filtering long agents', () => {
        const prompt = 'plain '.repeat(80);  // ~480 chars, no keywords
        const profile = { mainAgent: { systemPrompt: prompt } };
        // Above default threshold? No (1000 > 480). With minChars=400, yes.
        expect(computeExtractionCandidates(profile)).toEqual([]);
        const out = computeExtractionCandidates(profile, { minChars: 400 });
        // 480 chars but below FALLBACK_WHOLE_MIN_CHARS (500): no candidate.
        expect(out).toEqual([]);
    });
});

// ── Multi-agent walking ──────────────────────────────────────────────────

describe('computeExtractionCandidates — multi-agent', () => {
    test('walks main + subAgents + agenda agents + spec presets + loop', () => {
        const longRule = ('IMPORTANT: never break character. ' + 'detail '.repeat(20)).padEnd(1100, ' ');
        const profile = {
            mainAgent: { systemPrompt: longRule },
            subAgents: [
                { id: 'short_one', systemPrompt: 'tiny' },
                { id: 'long_one', systemPrompt: longRule },
            ],
            agents: { worker: { systemPrompt: longRule } },
            presets: { specPreset: { systemPrompt: longRule } },
            system_prompt: longRule,
        };
        const out = computeExtractionCandidates(profile);
        const agentIds = new Set(out.map(c => c.agentId));
        expect(agentIds.has('main')).toBe(true);
        expect(agentIds.has('long_one')).toBe(true);
        expect(agentIds.has('worker')).toBe(true);
        expect(agentIds.has('specPreset')).toBe(true);
        expect(agentIds.has('loop')).toBe(true);
        expect(agentIds.has('short_one')).toBe(false);
    });

    test('mixed: keyword-bearing agent + opaque-long agent both produce candidates', () => {
        const longRule = ('Rule: speak in voice. ' + 'detail '.repeat(20)).padEnd(1100, ' ');
        const longOpaque = 'plain prose '.repeat(120);  // > 1000 chars, no keywords
        const profile = {
            mainAgent: { systemPrompt: longRule },
            subAgents: [{ id: 'opaque_agent', systemPrompt: longOpaque }],
        };
        const out = computeExtractionCandidates(profile);
        const mainCands = out.filter(c => c.agentId === 'main');
        const opaqueCands = out.filter(c => c.agentId === 'opaque_agent');
        // main: paragraph-level (≥1 candidate).
        expect(mainCands.length).toBeGreaterThanOrEqual(1);
        // opaque_agent: fallback to whole-prompt (exactly 1).
        expect(opaqueCands).toHaveLength(1);
        expect(opaqueCands[0].suggestedName).toBe('opaque_agent-rules-extracted-zh');
    });
});
