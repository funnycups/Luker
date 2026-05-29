// Locale bootstrap for the simulation-review module. Each plugin that
// uses the module calls ensureSimulationReviewLocaleData() once on
// initialization so the sim.* keys flow through SillyTavern's
// translate() lookup. Without this hook the bundled zh-cn / zh-tw
// tables in this directory are never registered and translate() falls
// back to the English fallback string passed by the caller.

import { addLocaleData } from '../../../i18n.js';

import enLocale from './en.js';
import zhCnLocale from './zh-cn.js';
import zhTwLocale from './zh-tw.js';

let registered = false;

/**
 * Registers the simulation-review locale bundles with SillyTavern's
 * i18n system. Idempotent — repeated calls are no-ops, so it is safe
 * for each plugin to call once at bootstrap.
 */
export function ensureSimulationReviewLocaleData() {
    if (registered) return;
    registered = true;
    try {
        addLocaleData('en', enLocale);
        addLocaleData('zh-cn', zhCnLocale);
        addLocaleData('zh-tw', zhTwLocale);
    } catch (err) {
        // Don't break extension bootstrap if i18n init hasn't happened
        // yet for some reason; the popup will degrade to the fallback
        // strings supplied by the callers.
        registered = false;
        console.warn('[simulation-review/i18n] failed to register locale data', err);
    }
}
