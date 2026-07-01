// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Sources of trail signals routed to the native LukerDebugTrail ring buffer.
// Five sources total: webconsole (via WebChromeClient.onConsoleMessage on the
// native side, no JS needed), webheap (1Hz performance.memory sampler here),
// render (console.info routed via onConsoleMessage), webcrash (window.onerror
// and unhandledrejection bridged here), and native (Kotlin-side markers).

let heapSamplerId = null;

function getBridge() {
    if (typeof window === 'undefined') return null;
    return window.LukerAndroid || null;
}

function hasBridge() {
    const bridge = getBridge();
    return Boolean(bridge && typeof bridge.pushDebugTrail === 'function');
}

function push(category, text) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.pushDebugTrail !== 'function') return;
    try {
        bridge.pushDebugTrail(category, String(text == null ? '' : text));
    } catch (_) {
        // Bridge errors must never propagate to the caller.
    }
}

function installCrashListeners() {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (event) => {
        const parts = [];
        if (event?.message) parts.push(event.message);
        if (event?.filename) parts.push(`${event.filename}:${event.lineno || 0}:${event.colno || 0}`);
        if (event?.error?.stack) parts.push(event.error.stack);
        push('webcrash', parts.join(' | '));
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason?.stack || event?.reason?.message || String(event?.reason);
        push('webcrash', `unhandledrejection ${reason}`);
    });
}

function startHeapSampler() {
    if (heapSamplerId !== null) return;
    if (typeof performance === 'undefined' || !performance.memory) return;
    const intervalFn = (typeof window !== 'undefined' && window.setInterval) || setInterval;
    heapSamplerId = intervalFn(() => {
        try {
            const m = performance.memory;
            push('webheap', `used=${m.usedJSHeapSize} total=${m.totalJSHeapSize} limit=${m.jsHeapSizeLimit}`);
        } catch (_) {
            // performance.memory access can occasionally throw under DevTools throttling.
        }
    }, 1000);
}

export function pushRenderMarker({ msgId, bytes, turn }) {
    if (!hasBridge()) return;
    // Routed via console.info → WebChromeClient.onConsoleMessage → LukerDebugTrail.
    console.info(`[render] msg=${msgId} bytes=${bytes} turn=${turn}`);
}

export function setAndroidDebugRecordingEnabled(enabled) {
    const bridge = getBridge();
    if (!bridge || typeof bridge.setDebugRecordingEnabled !== 'function') return;
    try {
        bridge.setDebugRecordingEnabled(Boolean(enabled));
    } catch (_) {
        // ignore
    }
}

export function initAndroidDebugTrail() {
    if (!hasBridge()) return;
    installCrashListeners();
    startHeapSampler();
}

export function isAndroidDebugTrailAvailable() {
    return hasBridge();
}
