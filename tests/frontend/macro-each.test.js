import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * End-to-end tests for {{each}} block iteration. These run inside a real
 * SillyTavern page so they exercise the full macro engine (lexer, parser,
 * walker, dynamicMacros lookup) — not just the pure iteration helpers.
 */
test.describe('{{each}} macro', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Helper: evaluate a macro string in the page context against a fresh
     * env (only `dynamicMacros` and the bare minimum required structure).
     */
    async function evaluateEach(page, input) {
        return await page.evaluate(async (text) => {
            /** @type {import('../../public/scripts/macros/engine/MacroEngine.js')} */
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const env = {
                content: text,
                contentHash: 0,
                names: { user: 'User', char: 'Character', group: '', groupNotMuted: '', notChar: '' },
                character: {},
                system: { model: '' },
                functions: { postProcess: (s) => s },
                dynamicMacros: {},
                extra: {},
            };
            return MacroEngine.evaluate(text, env);
        }, input);
    }

    test('iterates a JSON object literal', async ({ page }) => {
        const out = await evaluateEach(page, '{{each::{"a":1,"b":2}}}{{loop_key}}={{loop_value}};{{/each}}');
        // Object.entries preserves insertion order for string keys.
        expect(out).toBe('a=1;b=2;');
    });

    test('iterates a JSON array literal with index keys', async ({ page }) => {
        const out = await evaluateEach(page, '{{each::["x","y","z"]}}{{loop_key}}:{{loop_value}};{{/each}}');
        expect(out).toBe('0:x;1:y;2:z;');
    });

    test('drills into object values via {{loop_value::path}}', async ({ page }) => {
        const out = await evaluateEach(page, '{{each::{"alice":{"hp":50},"bob":{"hp":30}}}}{{loop_key}}@{{loop_value::hp}};{{/each}}');
        expect(out).toBe('alice@50;bob@30;');
    });

    test('drills with multi-segment path', async ({ page }) => {
        const out = await evaluateEach(page, '{{each::[{"name":"Alice","stats":{"atk":7}},{"name":"Bob","stats":{"atk":9}}]}}{{loop_value::name}}/{{loop_value::stats.atk}};{{/each}}');
        expect(out).toBe('Alice/7;Bob/9;');
    });

    test('iterates a variable holding JSON-stringified data', async ({ page }) => {
        const out = await page.evaluate(async () => {
            const { MacroEngine } = await import('./scripts/macros/engine/MacroEngine.js');
            const ctx = Luker.getContext();
            ctx.variables.local.set('npcs_test', '{"alice":{"hp":50},"bob":{"hp":30}}');
            try {
                const env = {
                    content: '', contentHash: 0,
                    names: { user: 'U', char: 'C', group: '', groupNotMuted: '', notChar: '' },
                    character: {}, system: { model: '' },
                    functions: { postProcess: (s) => s },
                    dynamicMacros: {}, extra: {},
                };
                return MacroEngine.evaluate('{{each::npcs_test}}{{loop_key}}={{loop_value::hp}};{{/each}}', env);
            } finally {
                ctx.variables.local.del('npcs_test');
            }
        });
        expect(out).toBe('alice=50;bob=30;');
    });

    test('returns empty string for empty object', async ({ page }) => {
        const out = await evaluateEach(page, '<<{{each::{}}}item;{{/each}}>>');
        expect(out).toBe('<<>>');
    });

    test('returns empty string for empty array', async ({ page }) => {
        const out = await evaluateEach(page, '<<{{each::[]}}item;{{/each}}>>');
        expect(out).toBe('<<>>');
    });

    test('returns empty string for missing variable', async ({ page }) => {
        const out = await evaluateEach(page, '<<{{each::nonexistent_var_for_each_test}}item;{{/each}}>>');
        expect(out).toBe('<<>>');
    });

    test('returns empty string for malformed JSON', async ({ page }) => {
        const out = await evaluateEach(page, '<<{{each::{not json}}}item;{{/each}}>>');
        expect(out).toBe('<<>>');
    });

    test('returns empty string for primitive container reference', async ({ page }) => {
        const out = await evaluateEach(page, '<<{{each::"hello"}}x{{/each}}>>');
        expect(out).toBe('<<>>');
    });

    test('nested {{each}} shadows outer loop_key / loop_value', async ({ page }) => {
        const out = await evaluateEach(
            page,
            '{{each::{"alice":{"items":["sword","shield"]},"bob":{"items":["bow"]}}}}{{loop_key}}: {{each::{{loop_value::items}}}}{{loop_value}},{{/each}};{{/each}}',
        );
        expect(out).toBe('alice: sword,shield,;bob: bow,;');
    });

    test('iteration body can use other macros (e.g. {{if}})', async ({ page }) => {
        const out = await evaluateEach(
            page,
            '{{each::[{"name":"a","alive":"true"},{"name":"b","alive":""}]}}{{loop_value::name}}={{if {{loop_value::alive}}}}ok{{else}}ko{{/if}};{{/each}}',
        );
        expect(out).toBe('a=ok;b=ko;');
    });

    test('loop_key / loop_value are not visible outside the each block', async ({ page }) => {
        const out = await evaluateEach(
            page,
            'before:{{loop_key}}|{{each::["x"]}}inside:{{loop_key}}{{/each}}|after:{{loop_key}}',
        );
        // Outside, loop_key is not registered: macro is unknown so it's
        // returned verbatim. Inside, it resolves to '0'.
        expect(out).toBe('before:{{loop_key}}|inside:0|after:{{loop_key}}');
    });
});
