/**
 * One-click debug bundle export for troubleshooting.
 * Collects frontend-only signals (console buffer, perf marks, UA/viewport),
 * POSTs them to /api/debug/export so the server can assemble the full bundle
 * (backend logs, complete request-inspector ring buffer, runtime info) without
 * the browser having to stringify the whole thing. The response is streamed
 * straight to disk as the download.
 */
import { getFrontendLogsSnapshot } from './frontend-log-manager.js';
import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';

function collectClientPayload() {
    return {
        userAgent: navigator.userAgent,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        devicePixelRatio: window.devicePixelRatio,
        platform: navigator.platform,
        language: navigator.language,
        online: navigator.onLine,
        connectionType: navigator.connection?.effectiveType ?? 'unknown',
        memoryGB: navigator.deviceMemory ?? 'unknown',
        frontendLogs: getFrontendLogsSnapshot().entries,
        performanceMarks: performance.getEntriesByType('mark').map(m => ({
            name: m.name,
            startTime: m.startTime,
        })),
        performanceMeasures: performance.getEntriesByType('measure').map(m => ({
            name: m.name,
            startTime: m.startTime,
            duration: m.duration,
        })),
    };
}

export async function downloadDebugBundle() {
    const bridge = typeof window !== 'undefined' ? (window.LukerIOS || window.LukerAndroid) : null;
    if (bridge && typeof bridge.exportDiagnosticsBundle === 'function') {
        try {
            bridge.exportDiagnosticsBundle();
            toastr.success(t`Debug logs export started.`, t`Export started`);
        } catch (error) {
            console.error('[debug-export] native export failed', error);
            toastr.error(t`Failed to export debug logs.`);
        }
        return;
    }

    console.log('[debug-export] Requesting debug bundle from server...');

    const response = await fetch('/api/debug/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(collectClientPayload()),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const message = `Debug export failed: ${response.status} ${response.statusText} ${detail}`.trim();
        console.error('[debug-export]', message);
        toastr.error(message);
        throw new Error(message);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `luker-debug-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log('[debug-export] Debug bundle downloaded');
    toastr.success(t`Debug logs have been exported.`, t`Export complete`);
}

const debugMenuActions = new Map();
let debugMenuOutsideClickBound = false;
let debugMenuResizeBound = false;
const DEBUG_MENU_VIEWPORT_MARGIN_PX = 8;

/**
 * Align the diagnostics dropdown within the viewport so it never clips past
 * either horizontal edge when the trigger sits near the right side of the
 * screen on narrow viewports.
 * @param {HTMLElement} button
 * @param {HTMLElement} list
 * @param {number} [viewportWidth]
 */
export function positionDebugMenu(button, list, viewportWidth = window.innerWidth) {
    if (!button || !list || !viewportWidth) return;
    list.classList.remove('debug-menu-list--align-right');
    list.style.left = '';

    const buttonRect = button.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (!listRect.width) return;

    const maxRight = viewportWidth - DEBUG_MENU_VIEWPORT_MARGIN_PX;
    if (buttonRect.left + listRect.width <= maxRight) {
        return;
    }

    if (buttonRect.right - listRect.width >= DEBUG_MENU_VIEWPORT_MARGIN_PX) {
        list.classList.add('debug-menu-list--align-right');
        return;
    }

    const clampedLeft = Math.max(
        DEBUG_MENU_VIEWPORT_MARGIN_PX,
        maxRight - listRect.width,
    );
    list.style.left = `${clampedLeft - buttonRect.left}px`;
}

function closeDebugMenu() {
    const list = document.getElementById('debug-menu-list');
    if (list) {
        list.hidden = true;
    }
}

function runDebugMenuAction(action) {
    closeDebugMenu();
    const handler = debugMenuActions.get(action);
    if (handler) {
        handler();
    }
}

/**
 * Bind a handler to one entry of the diagnostics menu. Entries are addressed
 * by their `data-debug-action` value so the markup and the behavior can move
 * independently.
 * @param {string} action
 * @param {() => void} handler
 */
export function registerDebugMenuAction(action, handler) {
    debugMenuActions.set(action, handler);
}

/**
 * Reflect a boolean setting on a menu entry that acts as a toggle.
 * @param {string} action
 * @param {boolean} checked
 */
export function setDebugMenuToggleState(action, checked) {
    const item = document.querySelector(`#debug-menu-list [data-debug-action="${action}"]`);
    if (item) {
        item.setAttribute('aria-checked', checked ? 'true' : 'false');
    }
}

/**
 * Bind click behavior to the diagnostics button in User Settings.
 */
export function initDebugExportButton() {
    const button = document.getElementById('debug-export-btn');
    if (!button) return;

    registerDebugMenuAction('export-bundle', () => {
        downloadDebugBundle();
    });

    const list = document.getElementById('debug-menu-list');
    if (list && list.dataset.debugMenuBound !== 'true') {
        list.dataset.debugMenuBound = 'true';
        list.addEventListener('click', (event) => {
            const item = event.target.closest?.('[data-debug-action]');
            if (item) {
                runDebugMenuAction(item.dataset.debugAction);
            }
        });
    }

    // Listen on the way down so a click anywhere else closes the menu before
    // the element underneath reacts to it.
    if (!debugMenuOutsideClickBound) {
        debugMenuOutsideClickBound = true;
        document.addEventListener('click', (event) => {
            if (event.target.closest?.('#debug-export-btn') || event.target.closest?.('#debug-menu-list')) {
                return;
            }
            closeDebugMenu();
        }, true);
    }

    if (button.dataset.debugExportBound === 'true') return;

    button.dataset.debugExportBound = 'true';
    button.addEventListener('click', () => {
        if (list) {
            list.hidden = !list.hidden;
            if (!list.hidden) {
                positionDebugMenu(button, list);
            }
        }
    });

    if (!debugMenuResizeBound && typeof window !== 'undefined') {
        debugMenuResizeBound = true;
        window.addEventListener('resize', () => {
            if (list && !list.hidden) {
                positionDebugMenu(button, list);
            }
        });
    }
}
