import { describe, expect, test, jest } from '@jest/globals';
import { createMessageEditorHandle } from '../../../public/scripts/message-takeover.js';
import {
    ensureReasoningSection,
    appendToReasoningSection,
    markReasoningSectionStatus,
    EditorOpsError,
} from '../../../public/scripts/extensions/orchestrator/editor-ops.js';

function setup(initialReasoning = '') {
    const chat = [{ mes: '', extra: { reasoning: initialReasoning }, is_user: false }];
    const emit = jest.fn(async () => {});
    const handle = createMessageEditorHandle({
        generationType: 'normal',
        originalReasoning: initialReasoning,
        flushIntervalMs: 0,
    });
    handle.setOnUpdate((text, reasoning) => {
        chat[0].mes = text;
        chat[0].extra.reasoning = reasoning;
    });
    return { chat, handle };
}

describe('ensureReasoningSection', () => {
    test('creates a fresh section at end with running status', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        expect(chat[0].extra.reasoning).toBe('### [subagent-0] (running)\n');
    });

    test('appends after existing content with a blank line', () => {
        const { chat, handle } = setup('### [main]\nstart\n');
        ensureReasoningSection(handle, 'subagent-0');
        // Layout: previous content (trailing newlines normalized) → '\n\n' separator → new section header → '\n'.
        expect(chat[0].extra.reasoning).toBe('### [main]\nstart\n\n### [subagent-0] (running)\n');
    });

    test('idempotent — second call leaves text unchanged', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        const after1 = chat[0].extra.reasoning;
        ensureReasoningSection(handle, 'subagent-0');
        expect(chat[0].extra.reasoning).toBe(after1);
    });

    test('different ids create distinct sections', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        ensureReasoningSection(handle, 'subagent-1');
        const reasoning = chat[0].extra.reasoning;
        expect(reasoning).toContain('### [subagent-0]');
        expect(reasoning).toContain('### [subagent-1]');
        expect(reasoning.indexOf('subagent-0')).toBeLessThan(reasoning.indexOf('subagent-1'));
    });

    test('rejects empty id', () => {
        const { handle } = setup();
        expect(() => ensureReasoningSection(handle, '')).toThrow(EditorOpsError);
    });
});

describe('appendToReasoningSection', () => {
    test('appends to existing section body', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        appendToReasoningSection(handle, 'subagent-0', 'Hello');
        appendToReasoningSection(handle, 'subagent-0', ', world.');
        expect(chat[0].extra.reasoning).toBe('### [subagent-0] (running)\nHello, world.');
    });

    test('creates section if it does not exist (lossless start)', () => {
        const { chat, handle } = setup();
        appendToReasoningSection(handle, 'lazy-0', 'first chunk');
        expect(chat[0].extra.reasoning).toBe('### [lazy-0] (running)\nfirst chunk');
    });

    test('two concurrent sections do not interleave at the character level', () => {
        // Simulate two stream chunk handlers calling appendToReasoningSection
        // alternately. JS single-threaded event loop guarantees each call's
        // read-modify-write is atomic, so the per-section bodies stay
        // contiguous.
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'critic-0');
        ensureReasoningSection(handle, 'planner-1');

        // Interleaved chunks (what would happen with two parallel
        // async generators yielding to the same event loop).
        appendToReasoningSection(handle, 'critic-0', 'The ');
        appendToReasoningSection(handle, 'planner-1', 'Outline: ');
        appendToReasoningSection(handle, 'critic-0', 'pacing ');
        appendToReasoningSection(handle, 'planner-1', '1. open, ');
        appendToReasoningSection(handle, 'critic-0', 'drags.');
        appendToReasoningSection(handle, 'planner-1', '2. close.');

        const reasoning = chat[0].extra.reasoning;
        // Each section's body is one contiguous run — no characters from
        // the other stream wedged in.
        expect(reasoning).toContain('### [critic-0] (running)\nThe pacing drags.');
        expect(reasoning).toContain('### [planner-1] (running)\nOutline: 1. open, 2. close.');
        // The two sections appear in dispatch order, critic-0 first.
        expect(reasoning.indexOf('critic-0')).toBeLessThan(reasoning.indexOf('planner-1'));
    });

    test('rejects non-string delta', () => {
        const { handle } = setup();
        expect(() => appendToReasoningSection(handle, 'a', 123)).toThrow(EditorOpsError);
    });

    test('empty delta is a no-op', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'a');
        const before = chat[0].extra.reasoning;
        appendToReasoningSection(handle, 'a', '');
        expect(chat[0].extra.reasoning).toBe(before);
    });
});

describe('markReasoningSectionStatus', () => {
    test('replaces running status with done (empty)', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        appendToReasoningSection(handle, 'subagent-0', 'done body');
        markReasoningSectionStatus(handle, 'subagent-0', '');
        expect(chat[0].extra.reasoning).toBe('### [subagent-0]\ndone body');
    });

    test('replaces running with an error suffix', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        markReasoningSectionStatus(handle, 'subagent-0', 'error: timeout');
        expect(chat[0].extra.reasoning).toContain('### [subagent-0] (error: timeout)');
    });

    test('keeps body intact when only changing status', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'subagent-0');
        appendToReasoningSection(handle, 'subagent-0', 'line1\nline2');
        markReasoningSectionStatus(handle, 'subagent-0', '');
        expect(chat[0].extra.reasoning).toBe('### [subagent-0]\nline1\nline2');
    });

    test('throws if section not found', () => {
        const { handle } = setup();
        expect(() => markReasoningSectionStatus(handle, 'missing', '')).toThrow(EditorOpsError);
    });
});

describe('appendToReasoningSection performance', () => {
    test('1000 short appends to a section after a 100KB seed completes in < 200ms', () => {
        const seed = '### [seed]\n' + 'x'.repeat(100 * 1024) + '\n\n### [target] (running)\n';
        const { handle } = setup(seed);
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            appendToReasoningSection(handle, 'target', 'abcd');
        }
        const elapsed = performance.now() - start;
        // The slice+concat path on a 100KB+ string scales linearly with reasoning length,
        // so 1000 iterations of slice (100KB), concat, setReasoning would take >> 200ms
        // even on a fast machine. The cached path is amortized O(delta.length).
        expect(elapsed).toBeLessThan(200);
        // Sanity: text is correct.
        const r = handle.getReasoning();
        expect(r.endsWith('abcd'.repeat(1000))).toBe(true);
        expect(r.startsWith('### [seed]\n')).toBe(true);
    });

    test('cache invalidates when markReasoningSectionStatus is called between appends', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'a');
        appendToReasoningSection(handle, 'a', 'first');
        markReasoningSectionStatus(handle, 'a', 'done');
        appendToReasoningSection(handle, 'a', '-second');
        // After status change to 'done', the next append must still land in section 'a'
        // even though the cached endOffset is stale.
        expect(chat[0].extra.reasoning).toBe('### [a] (done)\nfirst-second');
    });

    test('cache invalidates when setReasoning is called between appends', () => {
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'a');
        appendToReasoningSection(handle, 'a', 'one');
        handle.setReasoning('### [a]\nreset');
        appendToReasoningSection(handle, 'a', '-two');
        expect(chat[0].extra.reasoning).toBe('### [a]\nreset-two');
    });

    test('two interleaved sections still write to their own bodies', () => {
        // Section 'a' is no longer at the tail once 'b' is created, so 'a' appends fall
        // into the slow path. The cached fast path applies only to 'b' (the tail section).
        // Both sections' bodies must stay contiguous regardless of which path runs.
        const { chat, handle } = setup();
        ensureReasoningSection(handle, 'a');
        ensureReasoningSection(handle, 'b');
        appendToReasoningSection(handle, 'a', 'A1');
        appendToReasoningSection(handle, 'b', 'B1');
        appendToReasoningSection(handle, 'a', 'A2');
        appendToReasoningSection(handle, 'b', 'B2');
        // Matches the existing slice/concat behavior: section 'a' body is appended
        // immediately before the next section's header, with a single '\n' separator.
        // (The blank line that ensureReasoningSection placed gets consumed by
        // findSectionEnd's trailing-newline walkback when section 'a' has zero body.
        // After the first append it's stable.)
        expect(chat[0].extra.reasoning).toBe(
            '### [a] (running)\nA1A2\n### [b] (running)\nB1B2',
        );
    });

    test('after first slow-path bootstrap, subsequent appends to a tail section hit the fast path', () => {
        const { handle } = setup();
        // Spy on the two paths.
        let setCount = 0, appendCount = 0;
        const origSet = handle.setReasoning.bind(handle);
        const origAppend = handle.appendReasoning.bind(handle);
        handle.setReasoning = (...a) => { setCount++; return origSet(...a); };
        handle.appendReasoning = (...a) => { appendCount++; return origAppend(...a); };

        ensureReasoningSection(handle, 'sub');
        for (let i = 0; i < 100; i++) {
            appendToReasoningSection(handle, 'sub', `c${i}`);
        }
        // ensure → 1 setReasoning
        // first append → 1 setReasoning (slow path bootstrap; cache miss)
        // appends 2..100 → 99 appendReasoning (fast path)
        expect(setCount).toBe(2);
        expect(appendCount).toBe(99);
    });
});
