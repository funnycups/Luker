import { event_types } from './events.js';

export const GENERATE_TAKEOVER_DISPATCH = event_types.GENERATE_TAKEOVER_DISPATCH;

export class TakeoverError extends Error {
    constructor(code, message, { cause = null, details = null } = {}) {
        super(message);
        this.name = 'TakeoverError';
        this.code = code;
        this.cause = cause;
        this.details = details;
    }
}

const VALID_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);

export function createMessageEditorHandle(opts = {}) {
    const {
        generationType,
        originalText = '',
        originalReasoning = '',
        abortSignal,
        flushIntervalMs = 33,
        owner = 'unknown',
    } = opts;

    if (!VALID_GENERATION_TYPES.has(generationType)) {
        throw new TakeoverError(
            'invalid_generation_type',
            `opts.generationType required, one of ${[...VALID_GENERATION_TYPES].join(', ')}; got ${String(generationType)}`,
        );
    }

    const signal = abortSignal instanceof AbortSignal
        ? abortSignal
        : new AbortController().signal;

    const state = {
        text: String(originalText),
        reasoning: String(originalReasoning),
        originalText: String(originalText),
        originalReasoning: String(originalReasoning),
        generationType,
        committed: false,
        aborted: false,
        discarded: false,
        pendingFlush: false,
        flushTimer: null,
        onUpdate: null,
        completeResolve: null,
        completeSettled: false,
        owner,
    };
    const completePromise = new Promise((resolve) => {
        state.completeResolve = (v) => { state.completeSettled = true; resolve(v); };
    });
    // Diagnostic flag for kernel/test code to peek at promise state without
    // awaiting. NOT part of the plugin-facing contract — plugins should
    // `await handle.complete` or chain off it instead of branching on this.
    Object.defineProperty(completePromise, '_settled', {
        get: () => state.completeSettled,
        configurable: true,
    });

    function assertOpen() {
        if (state.committed) throw new TakeoverError('editor_committed', 'editor committed; mutation rejected');
        if (state.aborted) throw new TakeoverError('editor_aborted', 'editor aborted; mutation rejected');
        if (state.discarded) throw new TakeoverError('editor_discarded', 'editor discarded; mutation rejected');
    }

    function assertContinueAllows(newText) {
        if (state.generationType !== 'continue') return;
        if (!newText.startsWith(state.originalText)) {
            throw new TakeoverError(
                'invalid_op_for_continue',
                `setText in 'continue' must keep originalText prefix; got ${JSON.stringify(newText.slice(0, 32))}…`,
                { details: { originalPrefix: state.originalText.slice(0, 64) } },
            );
        }
    }

    function scheduleFlush() {
        if (state.flushTimer) return;
        if (!state.onUpdate) return;
        if (flushIntervalMs <= 0) {
            // Immediate mode — call onUpdate synchronously instead of via
            // setTimeout. Used by tests and any caller that wants chat /
            // adapter state visible on the next assertion line without
            // an `await` dance.
            state.pendingFlush = false;
            try { state.onUpdate(state.text, state.reasoning); } catch (e) {
                console.warn('[message-takeover] onUpdate threw during immediate flush', e);
            }
            return;
        }
        state.flushTimer = setTimeout(() => {
            state.flushTimer = null;
            state.pendingFlush = false;
            if (!state.onUpdate) return;
            try { state.onUpdate(state.text, state.reasoning); } catch (e) {
                console.warn('[message-takeover] onUpdate threw during scheduled flush', e);
            }
        }, flushIntervalMs);
    }

    function flushNow() {
        if (state.flushTimer) {
            clearTimeout(state.flushTimer);
            state.flushTimer = null;
        }
        state.pendingFlush = false;
        if (state.onUpdate) {
            try { state.onUpdate(state.text, state.reasoning); } catch (e) {
                console.warn('[message-takeover] onUpdate threw during flushNow', e);
            }
        }
    }

    // Signal-driven auto-abort. When the caller passes an abortSignal,
    // a stop click on it must settle this handle into the `aborted`
    // terminal state immediately — without waiting for the plugin's
    // loop to notice (round-boundary checks can be seconds late when
    // a long tool is in flight). This closes the dual-write race:
    // a fast stop+regenerate would otherwise spawn a new takeover on
    // the same chat slot while this handle's setOnUpdate keeps firing,
    // producing the two-agents-alternating bug. No-op if the handle is
    // already settled (commit / discard / explicit abort wins) so the
    // mutual-exclusivity contract of the three terminals still holds.
    function settleAbortedFromSignal() {
        if (state.committed || state.aborted || state.discarded) return;
        state.aborted = true;
        flushNow();
        state.completeResolve({
            status: 'aborted',
            finalText: state.text,
            finalReasoning: state.reasoning,
        });
    }
    // `signal` (line 34) is already normalised: either the caller's
    // abortSignal, or a fresh never-aborts fallback. Either way it's a
    // real AbortSignal we can listen on without first checking shape.
    if (signal.aborted) {
        settleAbortedFromSignal();
    } else {
        signal.addEventListener('abort', settleAbortedFromSignal, { once: true });
    }

    return {
        getText() { return state.text; },
        getReasoning() { return state.reasoning; },
        isSettled() { return state.committed || state.aborted || state.discarded; },
        setText(text) {
            if (typeof text !== 'string') throw new TakeoverError('invalid_argument', `setText requires string; got ${typeof text}`);
            assertOpen();
            assertContinueAllows(text);
            state.text = text;
            state.pendingFlush = true;
            scheduleFlush();
        },
        setReasoning(text) {
            if (typeof text !== 'string') throw new TakeoverError('invalid_argument', `setReasoning requires string; got ${typeof text}`);
            assertOpen();
            state.reasoning = text;
            state.pendingFlush = true;
            scheduleFlush();
        },
        appendReasoning(delta) {
            if (typeof delta !== 'string') throw new TakeoverError('invalid_argument', `appendReasoning requires string; got ${typeof delta}`);
            if (delta.length === 0) return;
            assertOpen();
            state.reasoning += delta;
            state.pendingFlush = true;
            scheduleFlush();
        },
        async commit() {
            if (state.committed) return;
            if (state.aborted) throw new TakeoverError('editor_aborted', 'cannot commit an aborted handle');
            if (state.discarded) throw new TakeoverError('editor_discarded', 'cannot commit a discarded handle');
            state.committed = true;
            flushNow();
            state.completeResolve({
                status: 'committed',
                finalText: state.text,
                finalReasoning: state.reasoning,
            });
        },
        async abort() {
            // Mid-turn abort: preserve whatever the plugin streamed so
            // far (last setText/setReasoning state is pushed to the kernel
            // via a final onUpdate flush) but signal the kernel to skip
            // the natural-completion finalize pipeline (MESSAGE_RECEIVED
            // emit, persistence, autoContinue). Mirrors ST core
            // streaming's `isStreamFinished`-gated path: a stopped stream
            // keeps the partial visible without running finalize.
            //
            // Plugins should call this when the user clicked stop and
            // they want partial output retained — NOT for completion
            // (use commit) or rollback (use discard).
            if (state.aborted) return;
            if (state.committed) throw new TakeoverError('editor_committed', 'cannot abort a committed handle');
            if (state.discarded) throw new TakeoverError('editor_discarded', 'cannot abort a discarded handle');
            state.aborted = true;
            flushNow();
            state.completeResolve({
                status: 'aborted',
                finalText: state.text,
                finalReasoning: state.reasoning,
            });
        },
        async discard() {
            if (state.discarded) return;
            if (state.committed) throw new TakeoverError('editor_committed', 'cannot discard a committed handle');
            if (state.aborted) throw new TakeoverError('editor_aborted', 'cannot discard an aborted handle');
            state.discarded = true;
            if (state.flushTimer) clearTimeout(state.flushTimer);
            state.flushTimer = null;
            state.pendingFlush = false;
            state.completeResolve({
                status: 'discarded',
                finalText: state.originalText,
                finalReasoning: state.originalReasoning,
            });
        },
        setOnUpdate(fn) {
            state.onUpdate = typeof fn === 'function' ? fn : null;
            if (state.pendingFlush && state.onUpdate) flushNow();
        },
        get complete() { return completePromise; },
        get abortSignal() { return signal; },
    };
}
