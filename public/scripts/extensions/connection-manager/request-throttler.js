import { t } from '../../i18n.js';

const WINDOW_MS = 60_000;

const windows = new Map();
const queues = new Map();
const pumpTimers = new Map();
const activeToasts = new Map();

function clampRpm(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(1, Math.floor(n));
}

function getWindow(key) {
    let w = windows.get(key);
    if (!w) { w = []; windows.set(key, w); }
    return w;
}

function evict(key, now) {
    const w = getWindow(key);
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < w.length && w[i] <= cutoff) i++;
    if (i > 0) w.splice(0, i);
    return w;
}

function timeUntilSlot(key, rpm, now) {
    if (rpm <= 0) return 0;
    const w = evict(key, now);
    if (w.length < rpm) return 0;
    return Math.max(0, w[w.length - rpm] + WINDOW_MS - now);
}

function recordRequest(key, now) {
    getWindow(key).push(now);
}

function getQueue(key) {
    let q = queues.get(key);
    if (!q) { q = []; queues.set(key, q); }
    return q;
}

function makeAbortError(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

function schedulePump(key) {
    if (pumpTimers.has(key)) return;
    const q = queues.get(key);
    if (!q || q.length === 0) return;
    const head = q[0];
    const wait = timeUntilSlot(key, head.rpm, Date.now());
    if (wait <= 0) {
        pump(key);
        return;
    }
    const timer = setTimeout(() => {
        pumpTimers.delete(key);
        pump(key);
    }, wait + 5);
    pumpTimers.set(key, timer);
}

function pump(key) {
    const existing = pumpTimers.get(key);
    if (existing) { clearTimeout(existing); pumpTimers.delete(key); }

    const q = queues.get(key);
    if (!q) return;

    while (q.length > 0) {
        const head = q[0];
        const now = Date.now();
        const wait = timeUntilSlot(key, head.rpm, now);
        if (wait > 0) break;

        q.shift();
        if (head.signal && head.abortHandler) {
            head.signal.removeEventListener('abort', head.abortHandler);
        }
        recordRequest(key, now);
        head.resolve();
    }

    if (q.length === 0) {
        queues.delete(key);
        hideToast(key);
    } else {
        refreshToast(key);
        schedulePump(key);
    }
}

function buildToastContent(label, qLen, seconds) {
    const div = document.createElement('div');
    div.className = 'request-throttler-toast';
    const msg = document.createElement('span');
    msg.className = 'request-throttler-message';
    msg.textContent = t`Profile ${label} · queued ${qLen} · next in ${seconds}s`;
    div.appendChild(msg);
    return { root: div, messageEl: msg };
}

function refreshToast(key) {
    const q = queues.get(key);
    if (!q || q.length === 0) { hideToast(key); return; }

    const head = q[0];
    const seconds = Math.max(0, Math.ceil(timeUntilSlot(key, head.rpm, Date.now()) / 1000));
    const label = head.label || key;

    const existing = activeToasts.get(key);
    if (existing) {
        existing.messageEl.textContent =
            t`Profile ${label} · queued ${q.length} · next in ${seconds}s`;
        return;
    }

    const { root, messageEl } = buildToastContent(label, q.length, seconds);
    const toast = toastr.info($(root), t`API rate limit`, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: false,
        escapeHtml: false,
        preventDuplicates: false,
    });
    const intervalId = setInterval(() => {
        const q2 = queues.get(key);
        if (!q2 || q2.length === 0) { hideToast(key); return; }
        const head2 = q2[0];
        const secs = Math.max(0, Math.ceil(timeUntilSlot(key, head2.rpm, Date.now()) / 1000));
        const lbl = head2.label || key;
        messageEl.textContent =
            t`Profile ${lbl} · queued ${q2.length} · next in ${secs}s`;
    }, 500);
    activeToasts.set(key, { toast, messageEl, intervalId });
}

function hideToast(key) {
    const entry = activeToasts.get(key);
    if (!entry) return;
    activeToasts.delete(key);
    clearInterval(entry.intervalId);
    if (entry.toast) toastr.clear(entry.toast, { force: true });
}

/**
 * Wait until the next request to `key` is allowed under `rpm` requests/minute.
 * Records the request timestamp on success.
 * @param {string} key Bucket identifier (typically profile id)
 * @param {number|null|undefined} rpm Requests per minute. 0/null/undefined disables throttling.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.label] Human-readable name shown in the wait toast.
 */
export async function acquire(key, rpm, { signal, label } = {}) {
    const limit = clampRpm(rpm);
    if (limit <= 0) return;
    if (!key) return;
    if (signal?.aborted) throw makeAbortError(signal);

    const now = Date.now();
    if (timeUntilSlot(key, limit, now) <= 0) {
        recordRequest(key, now);
        return;
    }

    return new Promise((resolve, reject) => {
        const waiter = { rpm: limit, label, signal, abortHandler: null, resolve, reject };
        const q = getQueue(key);
        q.push(waiter);

        if (signal) {
            waiter.abortHandler = () => {
                const idx = q.indexOf(waiter);
                if (idx >= 0) q.splice(idx, 1);
                const timer = pumpTimers.get(key);
                if (timer) { clearTimeout(timer); pumpTimers.delete(key); }
                if (q.length === 0) {
                    queues.delete(key);
                    hideToast(key);
                } else {
                    refreshToast(key);
                    schedulePump(key);
                }
                reject(makeAbortError(signal));
            };
            signal.addEventListener('abort', waiter.abortHandler, { once: true });
        }

        refreshToast(key);
        schedulePump(key);
    });
}

export const __testing = { clampRpm, timeUntilSlot, windows, queues };
