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
    const bridge = typeof window !== 'undefined' ? window.LukerAndroid : null;
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

/**
 * Bind click behavior to the export button in User Settings.
 */
export function initDebugExportButton() {
    const button = document.getElementById('debug-export-btn');
    if (!button) return;
    if (button.dataset.debugExportBound === 'true') return;

    button.dataset.debugExportBound = 'true';
    button.addEventListener('click', () => {
        downloadDebugBundle();
    });
}
