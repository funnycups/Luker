import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { t } from '../../i18n.js';

/**
 * Threshold in milliseconds for declaring a single regex execution catastrophic.
 * Anything longer than this on one script is treated as ReDoS-suspect and the script
 * is paused for the rest of the session.
 */
export const REGEX_HARD_THRESHOLD_MS = 500;

/**
 * Maximum length of the pattern preview shown in the popup, in characters.
 */
const PATTERN_PREVIEW_MAX = 200;

/** @type {Set<string>} Script ids paused for the rest of this session. */
const pausedScripts = new Set();

/** @type {Set<string>} Script ids whose popup has already been shown this session. */
const popupShownScripts = new Set();

/**
 * Script ids the user has explicitly opted into running slowly.
 * Once added, the script is never auto-paused and the popup never re-fires for it,
 * even if subsequent executions exceed the hard threshold.
 *
 * @type {Set<string>}
 */
const userAllowedSlowScripts = new Set();

/**
 * @typedef {object} RegexScriptStats
 * @property {number} hits
 * @property {number} totalMs
 * @property {number} peakMs
 * @property {string} name
 * @property {string} pattern
 */

/** @type {Map<string, RegexScriptStats>} */
const stats = new Map();

/** @type {string[]} Queue of script ids waiting for popup display. */
const popupQueue = [];
let popupQueueProcessing = false;

/**
 * Event dispatched when the user clicks "Edit" inside the slow-script popup.
 * The regex extension's `index.js` listens for this on `window` and navigates
 * to the regex editor for the given script id.
 */
export const REGEX_OPEN_SCRIPT_EVENT = 'luker:regex:open-script';

/**
 * @param {string|null|undefined} scriptId
 * @returns {boolean}
 */
export function isRegexScriptPaused(scriptId) {
    if (!scriptId) return false;
    return pausedScripts.has(String(scriptId));
}

/**
 * @param {string|null|undefined} scriptId
 * @returns {void}
 */
export function pauseRegexScript(scriptId) {
    if (!scriptId) return;
    pausedScripts.add(String(scriptId));
}

/**
 * @param {string|null|undefined} scriptId
 * @returns {boolean} true if the script was paused before
 */
export function unpauseRegexScript(scriptId) {
    if (!scriptId) return false;
    return pausedScripts.delete(String(scriptId));
}

/**
 * Clears all session state for the given script id: pause, popup-shown flag,
 * user-accepted-slow flag, and stats. Call this when a script is edited and
 * saved, since the stored pattern may have changed and the previous evaluation
 * no longer applies.
 *
 * @param {string|null|undefined} scriptId
 * @returns {void}
 */
export function resetRegexScriptState(scriptId) {
    if (!scriptId) return;
    const id = String(scriptId);
    pausedScripts.delete(id);
    popupShownScripts.delete(id);
    userAllowedSlowScripts.delete(id);
    stats.delete(id);
}

/**
 * @param {string|null|undefined} scriptId
 * @returns {RegexScriptStats|undefined}
 */
export function getRegexScriptStats(scriptId) {
    if (!scriptId) return undefined;
    return stats.get(String(scriptId));
}

/**
 * Records a single regex execution. If the elapsed time crosses the hard threshold,
 * the script is auto-paused and the user is notified via popup (once per session).
 *
 * @param {{id?:string, scriptName?:string, findRegex?:string}|null|undefined} script
 * @param {number} elapsedMs
 * @returns {void}
 */
export function recordRegexExecution(script, elapsedMs) {
    if (!script || !script.id) return;
    const id = String(script.id);
    let entry = stats.get(id);
    if (!entry) {
        entry = { hits: 0, totalMs: 0, peakMs: 0, name: '', pattern: '' };
        stats.set(id, entry);
    }
    entry.hits += 1;
    entry.totalMs += elapsedMs;
    if (elapsedMs > entry.peakMs) entry.peakMs = elapsedMs;
    if (script.scriptName) entry.name = String(script.scriptName);
    if (script.findRegex) entry.pattern = String(script.findRegex);

    if (elapsedMs >= REGEX_HARD_THRESHOLD_MS && !pausedScripts.has(id)) {
        if (userAllowedSlowScripts.has(id)) {
            // The user has explicitly accepted that this script is slow. Track
            // stats but do not auto-pause and do not surface a popup.
            return;
        }
        pausedScripts.add(id);
        console.warn('[Regex] Pausing script due to slow execution', {
            id,
            name: entry.name,
            elapsedMs: Math.round(elapsedMs),
            peakMs: Math.round(entry.peakMs),
            totalMs: Math.round(entry.totalMs),
            hits: entry.hits,
        });
        if (!popupShownScripts.has(id)) {
            popupShownScripts.add(id);
            queuePopup(id);
        }
    }
}

/**
 * @param {string} scriptId
 */
function queuePopup(scriptId) {
    popupQueue.push(scriptId);
    if (popupQueueProcessing) return;
    popupQueueProcessing = true;
    setTimeout(processPopupQueue, 0);
}

async function processPopupQueue() {
    try {
        while (popupQueue.length > 0) {
            const id = popupQueue.shift();
            try {
                await showRegexSlowPopup(id);
            } catch (error) {
                console.warn('[Regex] Failed to show slow-script popup', { id, error });
            }
        }
    } finally {
        popupQueueProcessing = false;
    }
}

/**
 * @param {string} scriptId
 */
async function showRegexSlowPopup(scriptId) {
    const entry = stats.get(scriptId);
    if (!entry) return;

    const peakMs = Math.round(entry.peakMs);
    const totalMs = Math.round(entry.totalMs);
    const truncatedPattern = truncatePattern(entry.pattern, PATTERN_PREVIEW_MAX);
    const displayName = entry.name || scriptId;

    const container = buildPopupContent({
        name: displayName,
        peakMs,
        totalMs,
        hits: entry.hits,
        truncatedPattern,
        wasTruncated: entry.pattern.length > PATTERN_PREVIEW_MAX,
    });

    const result = await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        okButton: t`Got it`,
        cancelButton: false,
        customButtons: [
            { text: t`Edit`, result: POPUP_RESULT.CUSTOM2 },
            {
                text: t`Allow anyway`,
                result: POPUP_RESULT.CUSTOM1,
                tooltip: t`This script will no longer be auto-paused, even if it remains slow.`,
            },
        ],
        wide: false,
        allowVerticalScrolling: true,
        defaultResult: POPUP_RESULT.AFFIRMATIVE,
    });

    if (result === POPUP_RESULT.CUSTOM1) {
        // The user explicitly accepted the slow execution. From now on, do not
        // auto-pause this script and do not surface another popup for it.
        userAllowedSlowScripts.add(scriptId);
        unpauseRegexScript(scriptId);
        console.info('[Regex] Script re-enabled by user (will not auto-pause again)', { id: scriptId, name: displayName });
    } else if (result === POPUP_RESULT.CUSTOM2) {
        // Defer to next tick so the current popup fully closes before the editor opens
        setTimeout(() => {
            try {
                window.dispatchEvent(new CustomEvent(REGEX_OPEN_SCRIPT_EVENT, {
                    detail: { id: scriptId },
                }));
            } catch (error) {
                console.warn('[Regex] Failed to dispatch open-script event', { id: scriptId, error });
            }
        }, 0);
    }
}

/**
 * @param {string} pat
 * @param {number} max
 * @returns {string}
 */
function truncatePattern(pat, max) {
    if (!pat) return '';
    if (pat.length <= max) return pat;
    return pat.slice(0, max);
}

/**
 * Builds the popup body using DOM APIs (textContent only) to avoid any HTML injection.
 *
 * @param {{name:string, peakMs:number, totalMs:number, hits:number, truncatedPattern:string, wasTruncated:boolean}} params
 * @returns {HTMLElement}
 */
function buildPopupContent({ name, peakMs, totalMs, hits, truncatedPattern, wasTruncated }) {
    const container = document.createElement('div');
    container.classList.add('regex-redos-warn');

    const heading = document.createElement('h4');
    heading.textContent = t`Regex script is slow`;
    container.appendChild(heading);

    const summary = document.createElement('p');
    summary.textContent = t`Script "${name}" took ${peakMs}ms on a single message and was paused for this session.`;
    container.appendChild(summary);

    const cause = document.createElement('p');
    cause.textContent = t`This usually indicates catastrophic backtracking. Common causes: leading [\\s\\S]* / .*, nested quantifiers, unbounded lookahead.`;
    container.appendChild(cause);

    const advice = document.createElement('p');
    advice.textContent = t`Suggestion: review or replace the pattern.`;
    container.appendChild(advice);

    if (truncatedPattern) {
        const details = document.createElement('details');
        const detailsSummary = document.createElement('summary');
        detailsSummary.textContent = t`Pattern preview`;
        details.appendChild(detailsSummary);

        const pre = document.createElement('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-all';
        const code = document.createElement('code');
        code.textContent = wasTruncated ? truncatedPattern + '…' : truncatedPattern;
        pre.appendChild(code);
        details.appendChild(pre);
        container.appendChild(details);
    }

    const meta = document.createElement('p');
    meta.classList.add('opacity50p');
    meta.textContent = t`Hits this session: ${hits} · Total time: ${totalMs}ms`;
    container.appendChild(meta);

    return container;
}
