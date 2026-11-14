// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The orchestrator's notes panel, shown as a lens tab.

import { h } from '../../../lens-shared/util.js';

export function createNotesView(app) {
    const el = h('div', { class: 'ol-setup' });
    return {
        el,
        render() {
            void Promise.resolve(app.source.mountNotes?.(el)).catch(err => app.notify(String(err?.message || err), { error: true }));
        },
    };
}
