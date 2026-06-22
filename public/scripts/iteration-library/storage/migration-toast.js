// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Shared "migration failed" toast helper for iter-studio session stores.
 *
 * The four adapter session-store.js modules used to duplicate this body
 * verbatim. Lifted here so a single STR change or toastr-call adjustment
 * lands in one place.
 *
 * Accepts the per-adapter ctx-shape variation: pass a resolved `ctx`
 * object directly (CEA/MG/orch case), or a `getContext` thunk (CPA case)
 * that resolves to `ctx` lazily — the helper auto-detects callables.
 *
 * On the rare path where the toast can't be shown (no `toastr`, no
 * `translate`), the failure stays a console.error in the calling
 * session-store, so users can still find it in devtools.
 */

import { STR } from '/scripts/iteration-library/ui/strings.js';

export function notifyMigrationFailed(ctxOrGetter, sessionTitle) {
    try {
        const ctx = typeof ctxOrGetter === 'function' ? ctxOrGetter() : ctxOrGetter;
        const translate = (ctx && typeof ctx.translate === 'function') ? ctx.translate : ((s) => s);
        const localized = translate(STR.migrationFailed_toast);
        const message = String(localized).replace('${0}', String(sessionTitle));
        if (typeof toastr !== 'undefined' && toastr && typeof toastr.error === 'function') {
            toastr.error(message);
        }
    } catch { /* best-effort UI surface */ }
}
