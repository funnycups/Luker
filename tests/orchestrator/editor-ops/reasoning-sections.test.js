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
