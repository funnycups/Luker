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

    test('abort resolves complete with current buffer state (partial preserved)', async () => {
        // abort() is the third terminal state, distinct from commit (full
        // finalize pipeline) and discard (rollback). It signals the
        // kernel to KEEP the partial visible but SKIP the natural-
        // completion pipeline (emit MESSAGE_RECEIVED / persist /
        // autoContinue). The outcome shape carries the live buffer
        // state, not the originals — what the plugin streamed up to
        // the abort point is what the user sees.
        const h = createMessageEditorHandle({
            generationType: 'normal',
            originalText: 'orig',
            originalReasoning: 'origR',
            abortSignal: new AbortController().signal,
        });
        h.setText('partial output');
        h.setReasoning('partial reasoning');
        await h.abort();
        const outcome = await h.complete;
        expect(outcome).toEqual({
            status: 'aborted',
            finalText: 'partial output',
            finalReasoning: 'partial reasoning',
        });
    });

    test('abort force-flushes pending updates synchronously (mirrors commit)', async () => {
        // The kernel's `aborted` branch reads chat[slot] right after
        // handle.complete resolves; if the last setText hadn't flushed
        // yet, chat would be stale. So abort() — like commit() — must
        // flushNow before resolving the complete promise.
        const h = createMessageEditorHandle({
            generationType: 'normal',
            abortSignal: new AbortController().signal,
            flushIntervalMs: 1000,
        });
        const updates = [];
        h.setOnUpdate((text) => updates.push(text));
        h.setText('streamed before abort');
        expect(updates).toHaveLength(0);
        await h.abort();
        expect(updates).toContain('streamed before abort');
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

    test('three terminal states are mutually exclusive — each settle rejects the other two', async () => {
        // Commit / abort / discard are the three terminal states; once
        // a handle reaches any of them, the other two must throw on
        // subsequent calls. Re-calling the SAME terminal is a no-op
        // (idempotent) since the kernel's safe `complete.then(...)`
        // dispatch could in principle race a duplicate.
        // committed → abort throws, discard throws, commit no-ops
        const committed = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await committed.commit();
        await expect(committed.abort()).rejects.toMatchObject({ code: 'editor_committed' });
        await expect(committed.discard()).rejects.toMatchObject({ code: 'editor_committed' });
        await expect(committed.commit()).resolves.toBeUndefined();
        // aborted → commit throws, discard throws, abort no-ops
        const aborted = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await aborted.abort();
        await expect(aborted.commit()).rejects.toMatchObject({ code: 'editor_aborted' });
        await expect(aborted.discard()).rejects.toMatchObject({ code: 'editor_aborted' });
        await expect(aborted.abort()).resolves.toBeUndefined();
        // discarded → commit throws, abort throws, discard no-ops
        const discarded = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await discarded.discard();
        await expect(discarded.commit()).rejects.toMatchObject({ code: 'editor_discarded' });
        await expect(discarded.abort()).rejects.toMatchObject({ code: 'editor_discarded' });
        await expect(discarded.discard()).resolves.toBeUndefined();
    });

    test('setText after abort throws editor_aborted (mutations rejected post-settle)', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: new AbortController().signal });
        await h.abort();
        expect(() => h.setText('x')).toThrow(TakeoverError);
        let err;
        try { h.setText('x'); } catch (e) { err = e; }
        expect(err.code).toBe('editor_aborted');
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

describe('MessageEditorHandle — auto-abort on signal', () => {
    // Contract: when the caller provides an abortSignal, the handle must
    // self-settle into the `aborted` terminal state the moment that
    // signal fires — without waiting for the plugin to call .abort()
    // itself. This closes the dual-write window where a stop click
    // aborts the controller but the plugin's loop only checks the
    // signal at round boundaries; meanwhile the kernel is still
    // awaiting handle.complete and its setOnUpdate keeps mirroring
    // writes into chat[slot]. A quick "stop + regenerate" inside that
    // window lands a fresh takeover on the same slot and you get two
    // loops writing the same message body in alternation.

    test('signal abort after construction settles handle.complete with aborted status', async () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({
            generationType: 'normal',
            originalText: 'orig',
            originalReasoning: 'origR',
            abortSignal: ac.signal,
        });
        h.setText('partial');
        h.setReasoning('partial-r');
        expect(h.complete._settled).toBe(false);
        ac.abort();
        const outcome = await h.complete;
        expect(outcome).toEqual({
            status: 'aborted',
            finalText: 'partial',
            finalReasoning: 'partial-r',
        });
    });

    test('signal abort blocks subsequent setText / setReasoning with editor_aborted', async () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: ac.signal });
        ac.abort();
        await h.complete;
        let err1;
        try { h.setText('x'); } catch (e) { err1 = e; }
        expect(err1).toBeInstanceOf(TakeoverError);
        expect(err1.code).toBe('editor_aborted');
        let err2;
        try { h.setReasoning('x'); } catch (e) { err2 = e; }
        expect(err2.code).toBe('editor_aborted');
    });

    test('signal already aborted at construction time settles complete immediately', async () => {
        const ac = new AbortController();
        ac.abort();
        const h = createMessageEditorHandle({
            generationType: 'normal',
            originalText: 'orig',
            originalReasoning: '',
            abortSignal: ac.signal,
        });
        // Microtask drain — listener fires from constructor.
        const outcome = await h.complete;
        expect(outcome.status).toBe('aborted');
        // No writes happened, finalText is whatever the buffer was (originalText).
        expect(outcome.finalText).toBe('orig');
    });

    test('signal abort force-flushes pending updates before settling', async () => {
        // Same contract as explicit .abort(): the kernel reads
        // chat[slot] right after handle.complete resolves, so any
        // throttled setText that hadn't flushed yet must be visible
        // by the time the listener resolves complete.
        const ac = new AbortController();
        const h = createMessageEditorHandle({
            generationType: 'normal',
            abortSignal: ac.signal,
            flushIntervalMs: 1000,
        });
        const updates = [];
        h.setOnUpdate((text) => updates.push(text));
        h.setText('streamed before signal abort');
        expect(updates).toHaveLength(0);
        ac.abort();
        await h.complete;
        expect(updates).toContain('streamed before signal abort');
    });

    test('signal abort is no-op after commit (committed wins, complete unchanged)', async () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: ac.signal });
        h.setText('done');
        await h.commit();
        const before = await h.complete;
        ac.abort();
        const after = await h.complete;
        expect(before).toEqual(after);
        expect(after.status).toBe('committed');
    });

    test('signal abort is no-op after discard (discarded wins, complete unchanged)', async () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({
            generationType: 'normal',
            originalText: 'orig',
            abortSignal: ac.signal,
        });
        h.setText('partial');
        await h.discard();
        const before = await h.complete;
        ac.abort();
        const after = await h.complete;
        expect(before).toEqual(after);
        expect(after.status).toBe('discarded');
        expect(after.finalText).toBe('orig');
    });

    test('signal abort is idempotent with explicit handle.abort (first settle wins)', async () => {
        const ac = new AbortController();
        const h = createMessageEditorHandle({ generationType: 'normal', abortSignal: ac.signal });
        h.setText('first');
        await h.abort();
        const before = await h.complete;
        ac.abort();
        const after = await h.complete;
        expect(before).toEqual(after);
        expect(after.status).toBe('aborted');
        expect(after.finalText).toBe('first');
    });

    test('handle constructed without abortSignal still works (no listener wiring)', async () => {
        const h = createMessageEditorHandle({ generationType: 'normal' });
        h.setText('x');
        await h.commit();
        const outcome = await h.complete;
        expect(outcome.status).toBe('committed');
        expect(outcome.finalText).toBe('x');
    });
});

describe('isSettled()', () => {
    test('returns false on a fresh handle', () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        expect(handle.isSettled()).toBe(false);
    });

    test('returns true after commit()', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.commit();
        expect(handle.isSettled()).toBe(true);
    });

    test('returns true after abort()', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.abort();
        expect(handle.isSettled()).toBe(true);
    });

    test('returns true after discard()', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.discard();
        expect(handle.isSettled()).toBe(true);
    });

    test('returns true after abortSignal-driven settle', () => {
        const ctrl = new AbortController();
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
            abortSignal: ctrl.signal,
        });
        ctrl.abort();
        expect(handle.isSettled()).toBe(true);
    });
});

describe('appendReasoning(delta)', () => {
    test('appends to existing reasoning', () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            originalReasoning: 'seed',
            flushIntervalMs: 0,
        });
        let lastReasoning = null;
        handle.setOnUpdate((_text, reasoning) => { lastReasoning = reasoning; });
        handle.appendReasoning(' more');
        expect(handle.getReasoning()).toBe('seed more');
        expect(lastReasoning).toBe('seed more');
    });

    test('throws TakeoverError when delta is not a string', () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        expect(() => handle.appendReasoning(123)).toThrow(
            expect.objectContaining({ name: 'TakeoverError', code: 'invalid_argument' }),
        );
    });

    test('throws TakeoverError when handle is committed', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.commit();
        expect(() => handle.appendReasoning('x')).toThrow(
            expect.objectContaining({ name: 'TakeoverError', code: 'editor_committed' }),
        );
    });

    test('throws TakeoverError when handle is aborted', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.abort();
        expect(() => handle.appendReasoning('x')).toThrow(
            expect.objectContaining({ name: 'TakeoverError', code: 'editor_aborted' }),
        );
    });

    test('throws TakeoverError when handle is discarded', async () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            flushIntervalMs: 0,
        });
        await handle.discard();
        expect(() => handle.appendReasoning('x')).toThrow(
            expect.objectContaining({ name: 'TakeoverError', code: 'editor_discarded' }),
        );
    });

    test('empty delta is a no-op', () => {
        const handle = createMessageEditorHandle({
            generationType: 'normal',
            originalReasoning: 'seed',
            flushIntervalMs: 0,
        });
        const updates = [];
        handle.setOnUpdate((_t, r) => updates.push(r));
        handle.appendReasoning('');
        expect(handle.getReasoning()).toBe('seed');
        expect(updates).toEqual([]); // no flush scheduled when nothing changed
    });
});
