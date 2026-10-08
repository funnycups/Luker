// public/scripts/extensions/orchestrator/run-panel/panel.js
/**
 * Orchestrator run-panel wrapper — thin config over the shared panel.
 */

import { createRunPanel } from '/scripts/run-panel/panel.js';
import store from '../run-state/store.js';
import { i18nFormat } from '../i18n.js';

const panel = createRunPanel({
    store,
    t: i18nFormat,
    idPrefix: 'luker-orch-run-panel',
    defaultCollapsedKinds: ['messages_dump'],
    exportFilename: ({ runId, mode }) =>
        `orch-run-${runId}-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
});

export function initRunPanel() {
    panel.init();
}

export function openRunPanel(_context) {
    panel.open();
}
