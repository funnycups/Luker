/**
 * Behaviour-equivalence + perf regression tests for the SlashCommandParser
 * hot-path rewrites in public/scripts/slash-commands/SlashCommandParser.js.
 *
 * Background: any slash command whose argument is a long opaque blob
 * (e.g. a base64 payload, a quoted multi-KB string) makes the parser
 * walk one char at a time through testSymbol / endOfText /
 * testNamedArgument / isInsideMacroBraces. Each helper used to read
 * `this.text.slice(...)` (sometimes with a `/^...$/s` regex on top)
 * which copied the entire tail of the document per call — O(N²) on
 * argument length. On a ~32 KB argument that worked out to tens of
 * seconds of main-thread block per command.
 *
 * The rewrites count chars / scan from the current index directly. This
 * file pins two things:
 *
 *   1. Every (input, state) we can think of returns the same answer as
 *      the original implementation, which is inlined here as an oracle.
 *   2. The cost of the helpers scales linearly with input length, not
 *      quadratically. A 32 KB scan completes well under a second; the
 *      ratio between 8 KB and 32 KB stays close to 4x rather than 16x.
 *
 * The tests intentionally exercise the helpers as pure functions over a
 * (text, index, jumpedEscapeSequence) tuple — the SlashCommandParser class
 * pulls in browser-only dependencies (power_user, hljs, etc.) that jest
 * can't resolve. The rewritten helpers don't depend on any other parser
 * state, so testing the algorithm in isolation is faithful to what runs
 * in production.
 */

import { describe, test, expect } from '@jest/globals';

//
// === Original implementations (copied from pre-fix source) ===========
//
// These mirror the algorithms that shipped in SillyTavern's release
// branch before the perf rewrite. They are intentionally written exactly
// the way the original code expressed them, including the costly slices
// and regexes, so a parity test against the new code is meaningful.
//

function origTestSymbolStrict(state, sequence, offset = 0) {
    const escapeOffset = state.jumpedEscapeSequence ? -1 : 0;
    const escapes = state.text.slice(state.index + offset + escapeOffset).replace(/^(\\*).*$/s, '$1').length;
    const test = (sequence instanceof RegExp)
        ? (text) => new RegExp(`^${sequence.source}`).test(text)
        : (text) => text.startsWith(sequence);
    if (test(state.text.slice(state.index + offset + escapeOffset + escapes))) {
        if (escapes == 0) return { matched: true, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
        if (!state.jumpedEscapeSequence && offset == 0) {
            return { matched: false, indexAdvance: 1, jumped: true };
        }
        return { matched: false, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
    }
    return { matched: undefined, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
}

function origTestSymbolLoose(state, sequence, offset = 0) {
    const escapeOffset = state.jumpedEscapeSequence ? -1 : 0;
    const escapes = state.text[state.index + offset + escapeOffset] == '\\' ? 1 : 0;
    const test = (sequence instanceof RegExp)
        ? (text) => new RegExp(`^${sequence.source}`).test(text)
        : (text) => text.startsWith(sequence);
    if (test(state.text.slice(state.index + offset + escapeOffset + escapes))) {
        if (escapes == 0) return { matched: true, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
        if (!state.jumpedEscapeSequence && offset == 0) {
            return { matched: false, indexAdvance: 1, jumped: true };
        }
        return { matched: false, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
    }
    return { matched: undefined, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
}

function origEndOfText(state) {
    if (state.index >= state.text.length) return true;
    const ch = state.text[state.index];
    const ahead = state.text.slice(state.index + 1);
    return /\s/.test(ch) && /^\s+$/.test(ahead);
}

function origIsInsideMacroBraces(state) {
    const textBehind = state.text.slice(0, state.index);
    let depth = 0;
    for (let i = 0; i < textBehind.length; i++) {
        if (textBehind[i] === '{' && textBehind[i + 1] === '{') {
            depth++;
            i++;
        } else if (textBehind[i] === '}' && textBehind[i + 1] === '}') {
            depth = Math.max(0, depth - 1);
            i++;
        }
    }
    return depth > 0;
}

function origStartUnnamedArgsOffset(state) {
    // Original: this.index - (/\s(\s*)$/s.exec(this.behind)?.[1]?.length ?? 0)
    // We return only the subtractive offset for direct comparison.
    const behind = state.text.slice(0, state.index);
    const m = /\s(\s*)$/s.exec(behind);
    return (m?.[1]?.length ?? 0);
}

function origTestNamedArgument(state) {
    const ch = state.text[state.index];
    const ahead = state.text.slice(state.index + 1);
    return /^(\w+)=/.test(`${ch}${ahead}`);
}

//
// === New implementations (mirrors the rewrites in SlashCommandParser.js) ====
//

// Sticky-regex cache (same shape as parser's getStickyRegex).
const STICKY_CACHE = new Map();
function getSticky(regex) {
    const key = regex.source;
    let cached = STICKY_CACHE.get(key);
    if (!cached) {
        const flags = (regex.flags || '').replace(/[gy]/g, '') + 'y';
        cached = new RegExp(regex.source, flags);
        STICKY_CACHE.set(key, cached);
    }
    return cached;
}

function newTestSymbolStrict(state, sequence, offset = 0) {
    const escapeOffset = state.jumpedEscapeSequence ? -1 : 0;
    const start = state.index + offset + escapeOffset;
    const len = state.text.length;
    let escapes = 0;
    if (start >= 0) {
        while (start + escapes < len && state.text.charCodeAt(start + escapes) === 0x5C) {
            escapes++;
        }
    }
    const matchAt = start + escapes;
    let matched;
    if (sequence instanceof RegExp) {
        if (matchAt < 0 || matchAt > len) matched = false;
        else {
            const sticky = getSticky(sequence);
            sticky.lastIndex = matchAt;
            matched = sticky.test(state.text);
        }
    } else {
        matched = matchAt >= 0 && state.text.startsWith(sequence, matchAt);
    }
    if (matched) {
        if (escapes == 0) return { matched: true, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
        if (!state.jumpedEscapeSequence && offset == 0) {
            return { matched: false, indexAdvance: 1, jumped: true };
        }
        return { matched: false, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
    }
    return { matched: undefined, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
}

function newTestSymbolLoose(state, sequence, offset = 0) {
    const escapeOffset = state.jumpedEscapeSequence ? -1 : 0;
    const start = state.index + offset + escapeOffset;
    const escapes = (start >= 0 && start < state.text.length && state.text.charCodeAt(start) === 0x5C) ? 1 : 0;
    const matchAt = start + escapes;
    const len = state.text.length;
    let matched;
    if (sequence instanceof RegExp) {
        if (matchAt < 0 || matchAt > len) matched = false;
        else {
            const sticky = getSticky(sequence);
            sticky.lastIndex = matchAt;
            matched = sticky.test(state.text);
        }
    } else {
        matched = matchAt >= 0 && state.text.startsWith(sequence, matchAt);
    }
    if (matched) {
        if (escapes == 0) return { matched: true, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
        if (!state.jumpedEscapeSequence && offset == 0) {
            return { matched: false, indexAdvance: 1, jumped: true };
        }
        return { matched: false, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
    }
    return { matched: undefined, indexAdvance: 0, jumped: state.jumpedEscapeSequence };
}

function newEndOfText(state) {
    const len = state.text.length;
    if (state.index >= len) return true;
    if (state.index + 1 >= len) return false;
    for (let i = state.index; i < len; i++) {
        if (!/\s/.test(state.text[i])) return false;
    }
    return true;
}

function newIsInsideMacroBraces(state) {
    const limit = state.index;
    const text = state.text;
    let depth = 0;
    for (let i = 0; i < limit; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 0x7B && i + 1 < limit && text.charCodeAt(i + 1) === 0x7B) {
            depth++;
            i++;
        } else if (ch === 0x7D && i + 1 < limit && text.charCodeAt(i + 1) === 0x7D) {
            if (depth > 0) depth--;
            i++;
        }
    }
    return depth > 0;
}

function newStartUnnamedArgsOffset(state) {
    let trailingWs = 0;
    for (let i = state.index - 1; i >= 0; i--) {
        if (/\s/.test(state.text[i])) trailingWs++;
        else break;
    }
    return trailingWs > 0 ? trailingWs - 1 : 0;
}

function newTestNamedArgument(state) {
    const text = state.text;
    const len = text.length;
    let i = state.index;
    const start = i;
    while (i < len) {
        const c = text.charCodeAt(i);
        if ((c >= 0x30 && c <= 0x39)
            || (c >= 0x41 && c <= 0x5A)
            || c === 0x5F
            || (c >= 0x61 && c <= 0x7A)) {
            i++;
        } else {
            break;
        }
    }
    return i > start && i < len && text.charCodeAt(i) === 0x3D;
}

//
// === Parity tests ====================================================
//

function s(text, index = 0, jumped = false) {
    return { text, index, jumpedEscapeSequence: jumped };
}

const TEST_SEQUENCES_STR = ['|', '/', '{:', ':}', '()', '"', '[', ']', '/*', '*|', '/parser-flag ', '/:'];
const TEST_SEQUENCES_RE = [/\s/, /\/breakpoint\s*\|/, /\/break(\s|\||$)/, /\/[/#]/];

describe('SlashCommandParser hot-path rewrites — strict-escaping testSymbol parity', () => {
    const cases = [
        '',
        'foo',
        '|',
        '\\|',
        '\\\\|',
        '\\\\\\|',
        '\\\\\\\\|',
        '/echo abc | /echo def',
        '/echo abc \\| /echo def',
        '/echo abc \\\\| /echo def',
        '/echo abc \\\\\\| /echo def',
        '/echo title=\\:} \\{: | /echo title=\\{: \\:}',
        '   ',
        '{{macro}}',
        '/run :{ /echo nested :}',
        '\\\\\\\\\\\\\\\\\\\\|',
    ];

    test.each(cases)('strict-mode parity for %j', (text) => {
        for (let idx = 0; idx <= text.length + 1; idx++) {
            for (const jumped of [false, true]) {
                for (const offset of [0, 1, 2]) {
                    // The (idx + offset - 1) < 0 branch is unreachable in
                    // a real parser run: jumpedEscapeSequence is only set
                    // *after* `index++` advances past a backslash, so
                    // index >= 1 whenever jumped is true. The original
                    // code's behavior there happens to be defined (slice
                    // of a negative index yields the tail) but parses no
                    // meaningful state — we skip it rather than replicate
                    // the accidental behavior in the rewrite.
                    if (jumped && (idx + offset) === 0) continue;
                    for (const seq of [...TEST_SEQUENCES_STR, ...TEST_SEQUENCES_RE]) {
                        const a = origTestSymbolStrict(s(text, idx, jumped), seq, offset);
                        const b = newTestSymbolStrict(s(text, idx, jumped), seq, offset);
                        expect({ idx, jumped, offset, seq: String(seq), got: b }).toEqual({ idx, jumped, offset, seq: String(seq), got: a });
                    }
                }
            }
        }
    });

    test.each(cases)('loose-mode parity for %j', (text) => {
        for (let idx = 0; idx <= text.length + 1; idx++) {
            for (const jumped of [false, true]) {
                for (const offset of [0, 1, 2]) {
                    if (jumped && (idx + offset) === 0) continue;
                    for (const seq of [...TEST_SEQUENCES_STR, ...TEST_SEQUENCES_RE]) {
                        const a = origTestSymbolLoose(s(text, idx, jumped), seq, offset);
                        const b = newTestSymbolLoose(s(text, idx, jumped), seq, offset);
                        expect({ idx, jumped, offset, seq: String(seq), got: b }).toEqual({ idx, jumped, offset, seq: String(seq), got: a });
                    }
                }
            }
        }
    });
});

describe('SlashCommandParser hot-path rewrites — endOfText parity', () => {
    const cases = ['', ' ', '  ', 'x', ' x', 'x ', '   x', 'x   ', '\t\n', 'abc def', '   '];
    test.each(cases)('endOfText parity for %j', (text) => {
        for (let idx = 0; idx <= text.length + 1; idx++) {
            const orig = origEndOfText(s(text, idx));
            const fresh = newEndOfText(s(text, idx));
            expect({ idx, got: fresh }).toEqual({ idx, got: orig });
        }
    });
});

describe('SlashCommandParser hot-path rewrites — isInsideMacroBraces parity', () => {
    const cases = [
        '',
        '{{a',
        '{{a}}',
        '{{a}}{{b',
        '{{nested{{deep}}still-open',
        '}}}}}',          // never opened — should not go negative
        '{{{{}}}}',       // depth 2 then back to 0
        '/echo {{macro:foo}} | /echo bar',
        'a{b{{c}',        // single { mixed with double
    ];
    test.each(cases)('isInsideMacroBraces parity for %j', (text) => {
        for (let idx = 0; idx <= text.length + 1; idx++) {
            const a = origIsInsideMacroBraces(s(text, idx));
            const b = newIsInsideMacroBraces(s(text, idx));
            expect({ idx, got: b }).toEqual({ idx, got: a });
        }
    });
});

describe('SlashCommandParser hot-path rewrites — startUnnamedArgs offset parity', () => {
    const cases = ['', '   ', 'abc', 'abc ', 'abc   ', 'abc\n\t ', '\t', '\t\t\t', 'abc def', 'abc def   '];
    test.each(cases)('startUnnamedArgs offset parity for %j', (text) => {
        for (let idx = 0; idx <= text.length; idx++) {
            const a = origStartUnnamedArgsOffset(s(text, idx));
            const b = newStartUnnamedArgsOffset(s(text, idx));
            expect({ idx, got: b }).toEqual({ idx, got: a });
        }
    });
});

describe('SlashCommandParser hot-path rewrites — testNamedArgument parity', () => {
    const cases = ['', '=', 'a=', 'a=b', 'abc=def', '_x=1', '0=v', '0a=v', 'a b=v', '中=x', 'a-b=v', 'a_=v', ' =v'];
    test.each(cases)('testNamedArgument parity for %j', (text) => {
        for (let idx = 0; idx <= text.length + 1; idx++) {
            const a = origTestNamedArgument(s(text, idx));
            const b = newTestNamedArgument(s(text, idx));
            expect({ idx, got: b }).toEqual({ idx, got: a });
        }
    });
});

//
// === Perf regression =================================================
//
// Worst case: a long argument with no whitespace, no '|' separator, no
// named-arg '=', no macro braces. We don't run testSymbol against the
// full parser loop here (that would require importing the parser);
// instead we simulate the per-char loop pattern that drove the cost: a
// single "scan to whitespace" pass over the argument.

function simulateScanToWhitespace_orig(text) {
    // Mimic the original parseValue inner loop: for each char position,
    // check testSymbolStrict(/\s/). The cost we want to expose lives
    // entirely inside testSymbol; the rest of the per-char work is a
    // constant factor.
    let i = 0;
    while (i < text.length) {
        const r = origTestSymbolStrict(s(text, i, false), /\s/, 0);
        if (r.matched === true) break;
        i++;
    }
    return i;
}

function simulateScanToWhitespace_new(text) {
    let i = 0;
    while (i < text.length) {
        const r = newTestSymbolStrict(s(text, i, false), /\s/, 0);
        if (r.matched === true) break;
        i++;
    }
    return i;
}

function time(fn) {
    const t0 = process.hrtime.bigint();
    const out = fn();
    const t1 = process.hrtime.bigint();
    return { result: out, ms: Number(t1 - t0) / 1e6 };
}

describe('SlashCommandParser hot-path rewrites — perf regression', () => {
    test('new implementation finishes 32 KB scan in < 200ms (under-budget proof)', () => {
        // Base64-shaped: alphanumerics + '+', '/', '='. No whitespace, no '|'.
        const KB = 1024;
        const base = 'A'.repeat(64) + 'b'.repeat(64) + '+/=0123456789';
        const text = base.repeat(Math.ceil((32 * KB) / base.length)).slice(0, 32 * KB);
        const { result, ms } = time(() => simulateScanToWhitespace_new(text));
        expect(result).toBe(text.length); // never finds whitespace, returns length
        // 200 ms is an order of magnitude tighter than what the original
        // slice/regex implementation could achieve on a 32 KB input —
        // pure O(N²) would land in the tens of seconds range.
        expect(ms).toBeLessThan(200);
    });

    test('scaling is sub-quadratic: 32 KB / 8 KB ratio < 8x', () => {
        const big = 'A'.repeat(32 * 1024);
        const small = 'A'.repeat(8 * 1024);
        const a = time(() => simulateScanToWhitespace_new(big));
        const b = time(() => simulateScanToWhitespace_new(small));
        // Pure O(N) would predict 4x. Allow generous slack for cache / JIT
        // warm-up noise — anything below 8x decisively rules out O(N^2),
        // which would predict 16x.
        // Guard against measurement noise on warm caches making `b.ms` ~0.
        const ratio = a.ms / Math.max(b.ms, 0.05);
        expect(ratio).toBeLessThan(8);
    });
});
