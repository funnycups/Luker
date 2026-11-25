/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from '@jest/globals';
import { createPresetTarget } from '../../public/scripts/workbench/targets/preset.js';

describe('preset iteration preview', () => {
    test('renders complete prompt text with its order and generation parameters', () => {
        const content = `${'The ledger records the entire watch. '.repeat(40)}Final ledger entry. <img src="invalid">`;
        const live = {
            temp_openai: 0.65,
            openai_max_tokens: 730,
            prompts: [{ identifier: 'ledger', name: 'Ledger', role: 'system', content }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'ledger', enabled: true }] }],
        };
        const before = JSON.stringify(live);
        const target = createPresetTarget();
        expect(target.renderPreview).toEqual(expect.any(Function));
        const node = target.renderPreview({ base: live, ai: live });
        expect(node.textContent).toContain('Ledger');
        expect(node.textContent).toContain(content);
        expect(node.textContent).toContain('Entry order');
        expect(node.textContent).toContain('ledger');
        expect(node.textContent).toContain('Generation parameters');
        expect(node.textContent).toContain('"temp_openai": 0.65');
        expect(node.textContent).toContain('"openai_max_tokens": 730');
        expect(node.querySelector('img')).toBeNull();
        expect(JSON.stringify(live)).toBe(before);
    });

    test('does not render a preset before its working copy is loaded', () => {
        const target = createPresetTarget();
        expect(target.renderPreview).toEqual(expect.any(Function));
        expect(target.renderPreview({ base: null, ai: null })).toBeNull();
    });
});
