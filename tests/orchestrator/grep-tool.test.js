import { describe, test, expect } from '@jest/globals';
import { gatherGrepMatches } from '../../public/scripts/extensions/orchestrator/grep-tool.js';

function singleUnit(content, prefix = '') {
    return [{ prefix, content }];
}

describe('gatherGrepMatches', () => {
    test('matches a literal word in a single-unit corpus and emits grep -n shape', () => {
        const result = gatherGrepMatches(singleUnit('hello world\nfoo bar\nhello again'), 'hello');
        expect(result).toEqual({ ok: true, output: '1: hello world\n3: hello again' });
    });

    test('multi-match on a single line collapses to one emitted entry', () => {
        const result = gatherGrepMatches(singleUnit('foo foo foo\nbar'), 'foo');
        expect(result).toEqual({ ok: true, output: '1: foo foo foo' });
    });

    test('zero matches returns empty output string', () => {
        const result = gatherGrepMatches(singleUnit('nothing here\nnope'), 'absent');
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('invalid regex returns ok=false with escape hint', () => {
        const result = gatherGrepMatches(singleUnit('whatever'), '[unclosed');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid regex/);
        expect(result.error).toMatch(/escape regex metacharacters/);
    });

    test('missing g flag is auto-injected (otherwise exec loop would only find first match)', () => {
        const result = gatherGrepMatches(singleUnit('a\nb\nc'), '.', 'm');
        // Without auto-g, only line 1 would match. With auto-g, all three lines match.
        expect(result).toEqual({ ok: true, output: '1: a\n2: b\n3: c' });
    });

    test('zero-width pattern (^) does not infinite loop and matches every line', () => {
        const result = gatherGrepMatches(singleUnit('a\nb'), '^', 'gm');
        expect(result).toEqual({ ok: true, output: '1: a\n2: b' });
    });

    test('empty content returns empty output', () => {
        const result = gatherGrepMatches(singleUnit(''), 'anything');
        expect(result).toEqual({ ok: true, output: '' });
    });

    test('non-empty prefix is prepended with colon and emits grep file:lineno: shape', () => {
        const corpus = [
            { prefix: 'floor_1 [user]', content: 'hi there' },
            { prefix: 'floor_2 [assistant]', content: 'reply line\nmore' },
        ];
        const result = gatherGrepMatches(corpus, 'reply');
        expect(result).toEqual({ ok: true, output: 'floor_2 [assistant]:1: reply line' });
    });

    test('multi-unit corpus restarts lineno at 1 per unit', () => {
        const corpus = [
            { prefix: 'A', content: 'x\ny\nx' },
            { prefix: 'B', content: 'x' },
        ];
        const result = gatherGrepMatches(corpus, 'x');
        expect(result).toEqual({ ok: true, output: 'A:1: x\nA:3: x\nB:1: x' });
    });

    test('unicode (chinese + emoji) line numbers and content survive scan', () => {
        const result = gatherGrepMatches(singleUnit('第一行\n第二行 🐉\n第三行'), '第');
        expect(result).toEqual({ ok: true, output: '1: 第一行\n2: 第二行 🐉\n3: 第三行' });
    });

    test('flags parameter respects case-insensitive opt-in', () => {
        const result = gatherGrepMatches(singleUnit('Hello\nhello\nHELLO'), 'hello', 'gmi');
        expect(result).toEqual({ ok: true, output: '1: Hello\n2: hello\n3: HELLO' });
    });

    test('caller can pass an iterable (generator) as corpus', () => {
        function* gen() {
            yield { prefix: 'g', content: 'one\ntwo' };
        }
        const result = gatherGrepMatches(gen(), 'two');
        expect(result).toEqual({ ok: true, output: 'g:2: two' });
    });
});
