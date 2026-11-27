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

/**
 * Computes controller and timer ownership for a single `generateInternal` call
 * so prompt estimates (`dryRun`) and background `quiet` prompts never replace
 * a live foreground generation's controller or timing state.
 */
export function resolveGenerationOwnership({
    type,
    dryRun = false,
    isSendPress = false,
    abortController = null,
    quietAbortController = null,
    externalSignal = null,
    generationStarted = null,
    now = () => new Date(),
}) {
    const sharesInFlightController = type === 'quiet'
        && isSendPress
        && Boolean(abortController)
        && !abortController.signal.aborted;

    const nextGenerationStarted = (!dryRun && type !== 'quiet')
        ? now()
        : generationStarted;

    let nextAbortController = abortController;
    if (!dryRun && type !== 'quiet' && !(abortController && externalSignal)) {
        nextAbortController = new AbortController();
    }

    let nextQuietAbortController = quietAbortController;
    let generationAbortController;
    if (dryRun) {
        generationAbortController = new AbortController();
    } else if (type === 'quiet') {
        nextQuietAbortController = new AbortController();
        generationAbortController = nextQuietAbortController;
    } else {
        generationAbortController = nextAbortController;
    }

    const isGenerationAborted = () => Boolean(
        generationAbortController?.signal?.aborted
        || (externalSignal && typeof externalSignal === 'object' && 'aborted' in externalSignal && externalSignal.aborted),
    );

    return {
        sharesInFlightController,
        abortController: nextAbortController,
        quietAbortController: nextQuietAbortController,
        generationAbortController,
        generationStarted: nextGenerationStarted,
        isGenerationAborted,
    };
}

/**
 * Extends the active generation timer when continuing an existing message.
 * Dry runs leave both live and message timestamps untouched.
 */
export function computeContinuedGenerationStart({
    dryRun = false,
    isContinue = false,
    lastMessage = null,
    now = () => new Date(),
}) {
    if (dryRun || !isContinue || !lastMessage) {
        return null;
    }
    const prevFinished = lastMessage.gen_finished;
    const prevStarted = lastMessage.gen_started;
    if (!prevFinished || !prevStarted) {
        return null;
    }
    const timePassed = Number(prevFinished) - Number(prevStarted);
    const started = new Date(now().getTime() - timePassed);
    lastMessage.gen_started = started;
    return started;
}

/**
 * Aborts both the active foreground controller and any background quiet controller.
 */
export function abortGenerationControllers({ abortController = null, quietAbortController = null, reason = 'Clicked stop button' }) {
    let stopped = false;
    if (abortController) {
        abortController.abort(reason);
        stopped = true;
    }
    if (quietAbortController) {
        quietAbortController.abort(reason);
        stopped = true;
    }
    return stopped;
}

/**
 * Executes the kernel-side message takeover lifecycle (placeholder acquisition,
 * live streaming updates, and committed/aborted/discarded finalization) fenced
 * by foreground controller identity and chat transition epoch.
 */
export async function runTakeoverLifecycle({
    type,
    handle,
    isContinue = false,
    isImpersonate = false,
    genEpoch,
    myAbortController,
    getAbortController,
    getChatTransitionEpoch,
    getChat,
    powerUser = {},
    now = () => new Date(),
    getMessageTimeStamp,
    getGeneratingApi,
    getGeneratingModel,
    acquireTakeoverPlaceholder,
    rollbackTakeoverPlaceholder,
    applyPostGenerationText,
    resolveAssistantTokenCount,
    extractMessageById,
    redrawMessageBubble,
    hideSwipeButtons,
    showSwipeButtons,
    appendChatMessages,
    saveChatConditional,
    isLastLukerReplyPersistedByServerForApi,
    emitEvent,
    unblockThisGeneration,
    triggerAutoContinue,
}) {
    const isStale = () => getAbortController() !== myAbortController || getChatTransitionEpoch() !== genEpoch;
    const emptyTakeoverResult = () => Object.defineProperties(new String(''), {
        fromTakeover: { value: true },
    });

    const gen_started = now();
    hideSwipeButtons();

    // ── 1. Acquire/push placeholder per type ──
    const placeholderId = await acquireTakeoverPlaceholder(type);
    if (isStale()) {
        try { handle.setOnUpdate?.(null); } catch { /* idempotent */ }
        return emptyTakeoverResult();
    }
    const initialChat = getChat();
    const originalText = String(initialChat[placeholderId]?.mes ?? '');
    const originalReasoning = String(initialChat[placeholderId]?.extra?.reasoning ?? '');
    if (initialChat[placeholderId]) {
        initialChat[placeholderId].gen_started = gen_started;
    }

    // ── 2. Wire onUpdate → live redraw + chat mutation ──
    handle.setOnUpdate?.((text, reasoning) => {
        if (isStale()) return;
        const liveChat = getChat();
        if (!liveChat[placeholderId]) return;
        liveChat[placeholderId].mes = String(text ?? '');
        if (!liveChat[placeholderId].extra) liveChat[placeholderId].extra = {};
        liveChat[placeholderId].extra.reasoning = String(reasoning ?? '');
        liveChat[placeholderId].gen_finished = now();
        redrawMessageBubble(placeholderId);
        emitEvent(event_types.MESSAGE_UPDATED, placeholderId);
    });

    // ── 3. Wait for plugin handle to settle ──
    const outcome = await handle.complete;
    try { handle.setOnUpdate?.(null); } catch { /* idempotent */ }

    if (isStale()) {
        return emptyTakeoverResult();
    }
    showSwipeButtons();

    // ── 4. Route by outcome ──
    if (outcome.status === 'committed') {
        const cleanedText = applyPostGenerationText(outcome.finalText, isImpersonate, isContinue);
        const finalReasoning = String(outcome.finalReasoning ?? '');
        const liveChat = getChat();
        const slot = liveChat[placeholderId];

        if (slot) {
            slot.mes = cleanedText;
            if (!slot.extra) slot.extra = {};
            slot.extra.reasoning = finalReasoning;
            slot.extra.reasoning_duration = null;
            slot.extra.api = getGeneratingApi();
            slot.extra.model = getGeneratingModel();
            slot.gen_started = gen_started;
            slot.gen_finished = now();
            slot.send_date = getMessageTimeStamp();
            if (powerUser.message_token_count_enabled) {
                const tokenCountText = (finalReasoning || '') + cleanedText;
                slot.extra.token_count = await resolveAssistantTokenCount(tokenCountText);
                if (isStale()) {
                    return emptyTakeoverResult();
                }
            }
            if (Array.isArray(slot.swipes) && typeof slot.swipe_id === 'number') {
                slot.swipes[slot.swipe_id] = slot.mes;
                if (Array.isArray(slot.swipe_info)) {
                    slot.swipe_info[slot.swipe_id] = {
                        send_date: slot.send_date,
                        gen_started: slot.gen_started,
                        gen_finished: slot.gen_finished,
                        extra: structuredClone(slot.extra),
                    };
                }
            }
        }

        extractMessageById(placeholderId);
        redrawMessageBubble(placeholderId);

        const activeController = getAbortController();
        const isAborted = activeController && activeController.signal.aborted;
        const serverPersistedReply = isLastLukerReplyPersistedByServerForApi();
        const canUseIncrementalAppend = !isAborted
            && type === 'normal'
            && placeholderId === liveChat.length - 1
            && liveChat[placeholderId]
            && !liveChat[placeholderId].is_user
            && !serverPersistedReply;
        if (serverPersistedReply) {
            // Server already has it; nothing to do.
        } else if (canUseIncrementalAppend) {
            const appended = await appendChatMessages([liveChat[placeholderId]]);
            if (!appended && !isStale()) {
                await saveChatConditional();
            }
        } else {
            await saveChatConditional();
        }
        if (isStale()) {
            return emptyTakeoverResult();
        }

        unblockThisGeneration(type);

        await emitEvent(event_types.MESSAGE_RECEIVED, placeholderId, type);
        if (isStale()) {
            return emptyTakeoverResult();
        }
        await emitEvent(event_types.CHARACTER_MESSAGE_RENDERED, placeholderId, type);

        if (!isStale()) {
            triggerAutoContinue?.(cleanedText, false);
        }
        return Object.defineProperties(new String(cleanedText), {
            fromTakeover: { value: true },
        });
    }

    if (outcome.status === 'aborted') {
        const cleanedText = applyPostGenerationText(outcome.finalText, isImpersonate, isContinue);
        const finalReasoning = String(outcome.finalReasoning ?? '');
        const liveChat = getChat();
        const slot = liveChat[placeholderId];
        if (slot) {
            slot.mes = cleanedText;
            if (!slot.extra) slot.extra = {};
            slot.extra.reasoning = finalReasoning;
            slot.extra.reasoning_duration = null;
            slot.extra.api = getGeneratingApi();
            slot.extra.model = getGeneratingModel();
            slot.gen_started = gen_started;
            slot.gen_finished = now();
            slot.send_date = getMessageTimeStamp();
            if (Array.isArray(slot.swipes) && typeof slot.swipe_id === 'number') {
                slot.swipes[slot.swipe_id] = slot.mes;
            }
        }
        extractMessageById(placeholderId);
        redrawMessageBubble(placeholderId);
        unblockThisGeneration(type);
        return Object.defineProperties(new String(cleanedText), {
            fromTakeover: { value: true },
        });
    }

    // status === 'discarded'
    try {
        await rollbackTakeoverPlaceholder(placeholderId, type, originalText, originalReasoning);
    } catch (rollbackErr) {
        console.error('[takeover] rollback failed', rollbackErr);
    }
    if (isStale()) {
        return emptyTakeoverResult();
    }
    try {
        await emitEvent(event_types.GENERATION_STOPPED);
    } catch (emitErr) {
        console.error('[takeover] failed to emit GENERATION_STOPPED', emitErr);
    }
    unblockThisGeneration(type);
    return emptyTakeoverResult();
}
