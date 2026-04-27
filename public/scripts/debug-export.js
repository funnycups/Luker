/**
 * One-click debug bundle export for troubleshooting.
 * Collects frontend logs, backend logs, performance marks, and browser info,
 * redacts sensitive data, and downloads as JSON.
 */
import { getFrontendLogsSnapshot } from './frontend-log-manager.js';

const REDACT_PATTERNS = [
    // API keys: sk-... , Bearer ... , key=...
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: 'sk-***REDACTED***' },
    { pattern: /Bearer\s+[a-zA-Z0-9\-_\.]{20,}/g, replacement: 'Bearer ***REDACTED***' },
    { pattern: /(api[_-]?key|apikey|token|secret|password|passwd)\s*[=:]\s*["']?[^\s"',&]+/gi, replacement: '$1=***REDACTED***' },
    // JWT tokens
    { pattern: /eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/g, replacement: '***JWT-REDACTED***' },
    // Generic hex tokens (long strings of hex)
    { pattern: /\b[a-f0-9]{40,}\b/gi, replacement: '***HEX-TOKEN-REDACTED***' },
];

function redact(str) {
    let result = String(str);
    for (const { pattern, replacement } of REDACT_PATTERNS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

function redactObject(obj) {
    if (typeof obj === 'string') return redact(obj);
    if (Array.isArray(obj)) return obj.map(redactObject);
    if (obj && typeof obj === 'object') {
        const cleaned = {};
        for (const [key, value] of Object.entries(obj)) {
            cleaned[key] = redactObject(value);
        }
        return cleaned;
    }
    return obj;
}

async function fetchBackendLogs() {
    try {
        const response = await fetch('/api/debug/backend-logs');
        if (response.ok) return await response.json();
    } catch (e) {
        console.warn('[debug-export] Failed to fetch backend logs:', e.message);
    }
    return [];
}

export async function downloadDebugBundle() {
    console.log('[debug-export] Collecting debug bundle...');

    const bundle = {
        exportedAt: new Date().toISOString(),
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
        backendLogs: await fetchBackendLogs(),
    };

    const redacted = redactObject(bundle);
    const json = JSON.stringify(redacted, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
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
    toastr.success('调试日志已导出', '导出成功');
}

/**
 * Inject the export button into the UI.
 * Places it in the user settings panel under the debug logging toggle.
 */
export function initDebugExportButton() {
    const tryInject = () => {
        const checkbox = document.getElementById('frontend_debug_logging');
        if (!checkbox) {
            setTimeout(tryInject, 500);
            return;
        }

        if (document.getElementById('debug-export-btn')) return;

        const label = checkbox.closest('label');
        if (!label) return;

        const container = document.createElement('div');
        container.className = 'flex-container alignItemsCenter';
        container.style.marginTop = '8px';
        container.innerHTML = `
            <button id="debug-export-btn" class="menu_button" type="button">
                <i class="fa-solid fa-bug"></i> 导出调试日志
            </button>
        `;
        label.insertAdjacentElement('afterend', container);

        document.getElementById('debug-export-btn').addEventListener('click', () => {
            downloadDebugBundle();
        });
    };

    tryInject();
}
