import { createActivityPill } from './activity-pill.js';
import { createSyncActivityState } from './sync-activity-state.js';
import { t } from './i18n.js';

const state = createSyncActivityState();
let observer = null;

/** Install the single activity observer before the first admitted status. */
export function initializeSyncActivity() {
    if (observer) return observer.dispose;
    const pill = createActivityPill({
        id: 'luker-sync-activity-pill',
        className: 'sync-activity-pill',
        onOpen: async () => {
            const { openDataWindow } = await import('./data-window.js');
            await openDataWindow({ tab: 'sync' });
        },
        onError: error => {
            console.error('[sync] could not open Sync', error);
            toastr.error(String(error?.message || error), t`Failed to open Sync`);
        },
    });

    function render() {
        const view = state.getView();
        const names = ids => ids.map(id => view.labels[id]).join(', ');
        const text = [];
        if (view.runningBackendIds.length) text.push(t`Syncing: ${names(view.runningBackendIds)}`);
        if (view.failedBackendIds.length) text.push(t`Sync failed: ${names(view.failedBackendIds)}`);
        if (view.attentionBackendIds.length) text.push(t`Sync needs attention: ${names(view.attentionBackendIds)}`);
        if (view.unknown) text.push(t`Sync status unavailable`);
        const running = view.runningBackendIds.length > 0;
        pill.update({
            visible: view.visible,
            text: text.join(' · '),
            tone: view.unknown ? 'unknown' : view.failedBackendIds.length ? 'error' : view.attentionBackendIds.length ? 'attention' : 'running',
            loading: running,
        });
        document.dispatchEvent(new CustomEvent('sync-activity-updated', { detail: { running } }));
    }
    const onStatus = event => { state.acceptStatus(event.detail); render(); };
    const onFailure = () => { state.failStatusRead(); render(); };
    document.addEventListener('sync-status-updated', onStatus);
    document.addEventListener('sync-status-read-failed', onFailure);
    function dispose() {
        if (observer?.dispose !== dispose) return;
        document.removeEventListener('sync-status-updated', onStatus);
        document.removeEventListener('sync-status-read-failed', onFailure);
        pill.destroy();
        observer = null;
    }
    observer = { render, dispose };
    render();
    return dispose;
}

/** Pair actual manual request ownership with its real terminal outcome. */
export function beginSyncActivity({ backendId, label }) {
    initializeSyncActivity();
    const token = state.beginRequest({ backendId, label });
    observer.render();
    return outcome => {
        state.finishRequest(token, outcome);
        observer?.render();
    };
}

export function syncActivityNeedsAttention() {
    return state.getView().attentionBackendIds.length > 0;
}
