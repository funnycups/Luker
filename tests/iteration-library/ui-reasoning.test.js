import { describe, it, expect } from '@jest/globals';
import {
    splitThinkTags,
    collectReasoning,
    resolveAssistantDisplay,
} from '../../public/scripts/iteration-library/ui/reasoning.js';

const T_OPEN = '<' + 'think' + '>';
const T_CLOSE = '<' + '/think' + '>';

describe('splitThinkTags', () => {
    it('extracts a single think block and leaves the body', () => {
        const { body, blocks } = splitThinkTags('before ' + T_OPEN + 'inner' + T_CLOSE + ' after');
        expect(blocks).toEqual(['inner']);
        expect(body).toBe('before  after');
    });

    it('extracts multiple blocks and the thought tag', () => {
        const { body, blocks } = splitThinkTags('a <thought>one</thought> b ' + T_OPEN + 'two' + T_CLOSE + ' c');
        expect(blocks).toEqual(['one', 'two']);
        expect(body).toBe('a  b  c');
    });

    it('is case-insensitive on the tag name', () => {
        const { blocks } = splitThinkTags('<Think>x</Think>');
        expect(blocks).toEqual(['x']);
    });

    it('returns the source untouched when there is no tag', () => {
        const { body, blocks } = splitThinkTags('plain text');
        expect(body).toBe('plain text');
        expect(blocks).toEqual([]);
    });
});

describe('collectReasoning', () => {
    it('prefers the reasoning string', () => {
        expect(collectReasoning({ reasoning: 'field', content: ' ' + T_OPEN + 'from tags' + T_CLOSE })).toBe('field');
    });

    it('falls back to reasoningBlocks thinking text', () => {
        expect(collectReasoning({
            reasoning: '',
            reasoningBlocks: [{ type: 'thinking', thinking: 'from blocks' }],
        })).toBe('from blocks');
    });

    it('falls back to reasoningDetails text/summary', () => {
        expect(collectReasoning({
            reasoningDetails: [{ type: 'reasoning.summary', summary: 'sum' }],
        })).toBe('sum');
    });

    it('joins reasoningBlocks and reasoningDetails text with a blank line', () => {
        expect(collectReasoning({
            reasoningBlocks: [{ thinking: 'block text' }],
            reasoningDetails: [{ summary: 'detail text' }],
        })).toBe('block text\n\ndetail text');
    });

    it('ignores redacted / encrypted blocks', () => {
        expect(collectReasoning({
            reasoningBlocks: [{ type: 'redacted_thinking', data: 'zzz' }],
            reasoningDetails: [{ type: 'reasoning.encrypted', data: 'zzz' }],
        })).toBe('');
    });

    it('falls back to literal think tags in the content', () => {
        expect(collectReasoning({ content: 'body ' + T_OPEN + 'tagged' + T_CLOSE + ' tail' })).toBe('tagged');
    });
});

describe('resolveAssistantDisplay', () => {
    it('strips think tags from the body and surfaces them as reasoning', () => {
        const { body, reasoning } = resolveAssistantDisplay({ content: 'body ' + T_OPEN + 'why' + T_CLOSE + ' tail' });
        expect(body).toBe('body  tail');
        expect(reasoning).toBe('why');
    });

    it('strips tags from the body even when a reasoning field exists', () => {
        const { body, reasoning } = resolveAssistantDisplay({ reasoning: 'field', content: 'x ' + T_OPEN + 'dup' + T_CLOSE + ' y' });
        expect(body).toBe('x  y');
        expect(reasoning).toBe('field');
    });

    it('returns an empty reasoning for a plain body', () => {
        const { body, reasoning } = resolveAssistantDisplay({ content: 'plain' });
        expect(body).toBe('plain');
        expect(reasoning).toBe('');
    });
});
