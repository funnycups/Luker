/**
 * IterationStudio — popup orchestrator (IDE-style).
 *
 * `openIterationStudio(adapter, context, settings, root)` opens the popup,
 * wires event handlers, runs LLM turns, and blocks until dismissed.
 *
 * All mode-specific behavior routes through the adapter. The shell only
 * knows about Session shape and the LLM round-trip + apply flow.
 */

import { POPUP_TYPE, Popup } from '../popup.js';
import { isAbortError } from '../extensions/orchestrator/abort-utils.js';
import { registerOp as editsRegisterOp, getRegisteredOp as editsGetRegisteredOp } from '../lib/edits/index.js';

import { i18n, i18nFormat } from './i18n.js';
import { buildIterationStudioPopupHtml } from './template.js';
import { bindZoomOverlayHandlers } from './zoom-overlay.js';
import {
    createEmptySession,
    defineAdapter,
} from './session.js';
import {
    renderShell,
    renderHistoryList,
    renderReferenceSelect,
} from './render.js';
import {
    runIterationTurn,
    applyPendingApproval,
    rejectPendingApproval,
    rollbackToMessage,
    buildAutoContinuePrompt,
} from './runner.js';
import { ensureStorageWipeOnce } from './storage-migration.js';

let activeAbortController = null;

/**
 * Build the facade adapters use to register their custom edits-lib ops.
 *
 * The facade wraps the engine's `registerOp` with a `getRegisteredOp` guard
 * so that re-opening the same studio popup never re-registers (or fails on
 * duplicate) the same op handler.
 */
export function makeCustomOpsRegistryFacade() {
    return {
        registerOp(name, handler) {
            if (editsGetRegisteredOp(name)) return;
            editsRegisterOp(name, handler);
        },
    };
}

/**
 * Test-only helper: exercise the `registerCustomOps` invocation without
 * mounting a Popup. Mirrors what `openIterationStudio` does post-validation.
 */
export async function runRegisterCustomOpsForTest(adapter, facade) {
    if (typeof adapter.registerCustomOps === 'function') {
        adapter.registerCustomOps(facade);
    }
}

async function loadOrCreateSession(adapter) {
    const scope = adapter.sessionScope();
    const metas = (await adapter.listSessions(scope)) || [];
    if (metas.length > 0) {
        const newest = metas[0];
        const loaded = await adapter.loadSession(scope, newest.id);
        if (loaded) return loaded;
    }
    const fresh = createEmptySession(adapter);
    await adapter.saveSession(scope, fresh);
    return fresh;
}

async function loadReferenceCandidates(adapter, session) {
    if (typeof adapter.listReferences !== 'function') return [];
    try {
        return adapter.listReferences(session) || [];
    } catch (_e) { return []; }
}

export async function openIterationStudio(adapter, context, settings, root) {
    defineAdapter(adapter);
    if (typeof adapter.ensureStyles === 'function') {
        try { adapter.ensureStyles(adapter.popupClassName || ''); } catch { /* ignore */ }
    }

    const customOpsFacade = makeCustomOpsRegistryFacade();
    if (typeof adapter.registerCustomOps === 'function') {
        adapter.registerCustomOps(customOpsFacade);
    }

    await ensureStorageWipeOnce(adapter);

    const session = await loadOrCreateSession(adapter);
    const references = await loadReferenceCandidates(adapter, session);

    const popupId = `luker_iter_studio_${adapter.id}_${Date.now()}`;
    const popupHtml = buildIterationStudioPopupHtml({
        popupId, layout: adapter.layout, popupClassName: adapter.popupClassName || '',
        title: adapter.title,
    });
    const popup = new Popup(popupHtml, POPUP_TYPE.DISPLAY, '', {
        wide: adapter.layout === 'split', large: adapter.layout === 'split', allowVerticalScrolling: true,
        okButton: false, cancelButton: false,
    });

    const state = {
        adapter, context, settings, session,
        reference: null, referenceId: '',
        isBusy: false, root: null, popupId,
    };

    const promise = popup.show();
    state.root = jQuery(`#${popupId}`).closest('.popup');
    bindZoomOverlayHandlers(state.root, popupId);

    async function rerender() {
        await renderShell(adapter, state.root, state.session, {
            reference: state.reference, isBusy: state.isBusy,
        });
        await renderHistoryList(adapter, state.root, await adapter.listSessions(adapter.sessionScope()));
        renderReferenceSelect(adapter, state.root, references, state.referenceId);
    }

    function bindEvents() {
        const root = state.root;
        root.off('.iterStudio');

        root.on('input.iterStudio', '[data-iter-input]', function () {
            state._input = String(jQuery(this).val() || '');
        });
        root.on('change.iterStudio', '[data-iter-reference-select]', async function () {
            state.referenceId = String(jQuery(this).val() || '');
            state.reference = state.referenceId && typeof adapter.loadReference === 'function'
                ? await adapter.loadReference(state.referenceId)
                : null;
            await rerender();
        });
        root.on('click.iterStudio', '[data-iter-action="send-or-stop"]', async function () {
            if (state.isBusy) {
                try { activeAbortController?.abort(); } catch { /* ignore */ }
                return;
            }
            await sendInput();
        });
        root.on('click.iterStudio', '[data-iter-action="approve-pending"]', async function () {
            state.isBusy = true; await rerender();
            try {
                await applyPendingApproval(adapter, state.session);
                await adapter.saveSession(adapter.sessionScope(), state.session);
            } finally {
                state.isBusy = false; await rerender();
            }
        });
        root.on('click.iterStudio', '[data-iter-action="reject-pending"]', async function () {
            rejectPendingApproval(state.session); await adapter.saveSession(adapter.sessionScope(), state.session); await rerender();
        });
        root.on('click.iterStudio', '[data-iter-action="rollback-to-message"]', async function () {
            const id = String(jQuery(this).attr('data-iter-message-id') || '');
            if (!id) return;
            state.isBusy = true; await rerender();
            try {
                await rollbackToMessage(adapter, state.session, id);
                await adapter.saveSession(adapter.sessionScope(), state.session);
            } finally {
                state.isBusy = false; await rerender();
            }
        });
        root.on('click.iterStudio', '[data-iter-action="clear-history"]', async function () {
            if (!confirm(i18n('Clear all session history for this scope?'))) return;
            const scope = adapter.sessionScope();
            for (const m of await adapter.listSessions(scope)) {
                await adapter.deleteSession(scope, m.id);
            }
            state.session = createEmptySession(adapter);
            await adapter.saveSession(scope, state.session);
            await rerender();
        });
        root.on('click.iterStudio', '[data-iter-action="new-session"]', async function () {
            state.session = createEmptySession(adapter);
            await adapter.saveSession(adapter.sessionScope(), state.session);
            await rerender();
        });
        root.on('click.iterStudio', '[data-iter-action="load-session"]', async function () {
            const id = String(jQuery(this).attr('data-iter-session-id') || '');
            if (!id) return;
            const loaded = await adapter.loadSession(adapter.sessionScope(), id);
            if (loaded) { state.session = loaded; await rerender(); }
        });
        root.on('click.iterStudio', '[data-iter-action="delete-session"]', async function () {
            const id = String(jQuery(this).attr('data-iter-session-id') || '');
            if (!id) return;
            await adapter.deleteSession(adapter.sessionScope(), id);
            if (state.session?.id === id) {
                state.session = createEmptySession(adapter);
                await adapter.saveSession(adapter.sessionScope(), state.session);
            }
            await rerender();
        });
        root.on('click.iterStudio', '[data-iter-action="close"]', async function () { popup?.completeCancelled?.(); });
        if (typeof adapter.handleAction === 'function') {
            root.on('click.iterStudio', '[data-iter-custom-action]', async function () {
                const id = String(jQuery(this).attr('data-iter-custom-action') || '');
                if (!id) return;
                try {
                    await adapter.handleAction(id, { session: state.session, root: state.root, popupId });
                } catch (e) {
                    console.warn(`[iter-studio:${adapter.id}] handleAction failed`, e);
                }
                await adapter.saveSession(adapter.sessionScope(), state.session);
                await rerender();
            });
        }
    }

    async function sendInput() {
        const text = String(state._input || '').trim();
        if (!text) return;
        state._input = '';
        state.root.find('[data-iter-input]').val('');
        state.isBusy = true; await rerender();
        activeAbortController = new AbortController();
        try {
            const turn = await runIterationTurn(adapter, context, settings, state.session, text,
                activeAbortController.signal, { reference: state.reference });
            await adapter.saveSession(adapter.sessionScope(), state.session);
            if (turn?.autoApplied && turn?.executionResult?.continueRequested) {
                const auto = buildAutoContinuePrompt(adapter, turn.executionResult);
                await runIterationTurn(adapter, context, settings, state.session, auto,
                    activeAbortController.signal, { reference: state.reference, auto: true, appendUserMessage: false });
                await adapter.saveSession(adapter.sessionScope(), state.session);
            }
        } catch (error) {
            if (!isAbortError(error)) {
                toastr.error(i18nFormat('Iteration failed: ${0}', String(error?.message || error)));
            }
        } finally {
            state.isBusy = false; activeAbortController = null;
            await rerender();
        }
    }

    bindEvents();
    await rerender();
    await promise;
}
