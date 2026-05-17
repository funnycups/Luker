import { describe, expect, test } from '@jest/globals';
import { createMessageEditorHandle, TakeoverError, GENERATE_TAKEOVER_DISPATCH } from '../public/scripts/message-takeover.js';
import { event_types } from '../public/scripts/events.js';

describe('MessageEditorHandle — buffer semantics', () => {
    test('setText / getText round-trip; no chat / emit dependencies', () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({
            generationType: 'normal',
            originalText: '',
            originalReasoning: '',
            abortSignal: ac.signal,
            owner: 'test',
        });
        expect(h.getText()).toBe('');
        h.setText('hello');
        expect(h.getText()).toBe('hello');
        h.setText('hello world');
        expect(h.getText()).toBe('hello world');
    });

    test('setReasoning round-trip', () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        h.setReasoning('thinking...');
        expect(h.getReasoning()).toBe('thinking...');
    });

    test('continue requires originalText prefix', () => {
        const h = createMessageEditorHandle({ generationType: 'continue', originalText: 'Hello ', abortSignal: new AbortController().signal });
        expect(() => h.setText('Bye there')).toThrow(TakeoverError);
        expect(() => h.setText('Hello world')).not.toThrow();
    });

    test('commit resolves complete with committed shape', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        h.setText('done');
        h.setReasoning('rsn');
        await h.commit();
        expect(h.complete._settled).toBe(true);
        const outcome = await h.complete;
        expect(outcome).toEqual({ status: 'committed', finalText: 'done', finalReasoning: 'rsn' });
    });

    test('discard resolves complete with originals', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', originalText: 'orig', originalReasoning: 'origR', abortSignal: new AbortController().signal });
        h.setText('partial');
        await h.discard();
        const outcome = await h.complete;
        expect(outcome).toEqual({ status: 'discarded', finalText: 'orig', finalReasoning: 'origR' });
    });

    test('setOnUpdate fires on subsequent writes (throttled)', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal, flushIntervalMs: 5 });
        const updates = [];
        h.setOnUpdate((text, reasoning) => updates.push({ text, reasoning }));
        h.setText('first');
        h.setText('second');
        await new Promise(r => setTimeout(r, 20));
        // throttle coalesces; we get at least the final value
        expect(updates.length).toBeGreaterThanOrEqual(1);
        expect(updates[updates.length - 1].text).toBe('second');
    });

    test('commit force-flushes pending updates synchronously', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal, flushIntervalMs: 1000 });
        const updates = [];
        h.setOnUpdate((text) => updates.push(text));
        h.setText('flushed');
        expect(updates).toHaveLength(0);          // not yet flushed (throttle 1000ms)
        await h.commit();
        expect(updates).toContain('flushed');     // commit force-flushed
    });

    test('setText after commit throws editor_committed', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await h.commit();
        expect(() => h.setText('x')).toThrow(TakeoverError);
    });

    test('setText after discard throws editor_discarded', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await h.discard();
        expect(() => h.setText('x')).toThrow(TakeoverError);
    });

    test('abortSignal exposed on handle is the same one passed in', () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: ac.signal });
        expect(h.abortSignal).toBe(ac.signal);
    });

    test('commit() after discard() throws editor_discarded', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await h.discard();
        await expect(h.commit()).rejects.toThrow(TakeoverError);
        await expect(h.commit()).rejects.toMatchObject({ code: 'editor_discarded' });
    });

    test('setText with non-string throws invalid_argument', () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        let err;
        try { h.setText(123); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(TakeoverError);
        expect(err.code).toBe('invalid_argument');
    });

    test('setReasoning with non-string throws invalid_argument', () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        let err;
        try { h.setReasoning(null); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(TakeoverError);
        expect(err.code).toBe('invalid_argument');
    });

    test('TakeoverError exposes code/cause/details with null defaults', () => {
        const bare = new TakeoverError('some_code', 'msg');
        expect(bare.name).toBe('TakeoverError');
        expect(bare.code).toBe('some_code');
        expect(bare.cause).toBeNull();
        expect(bare.details).toBeNull();

        const cause = new Error('root');
        const full = new TakeoverError('other_code', 'msg', { cause, details: { x: 1 } });
        expect(full.cause).toBe(cause);
        expect(full.details).toEqual({ x: 1 });
    });

    test('GENERATE_TAKEOVER_DISPATCH re-export equals event_types constant', () => {
        expect(GENERATE_TAKEOVER_DISPATCH).toBe(event_types.GENERATE_TAKEOVER_DISPATCH);
        expect(typeof GENERATE_TAKEOVER_DISPATCH).toBe('string');
    });

    test('continue with empty originalText accepts any setText (degenerate prefix)', () => {
        const h = createMessageEditorHandle({ generationType: 'continue', originalText: '', abortSignal: new AbortController().signal });
        expect(() => h.setText('anything')).not.toThrow();
        expect(() => h.setText('')).not.toThrow();
    });
});
