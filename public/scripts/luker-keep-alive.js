// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

const SILENT_VIDEO_URL = '/sounds/silent.mp4';

/** @typedef {'off'|'android'|'pip'|'audio'} KeepAliveMode */
/** @typedef {'android'|'web'|'unsupported'} KeepAlivePlatform */

let platform = 'unsupported';
/** @type {KeepAliveMode} */
let activeMode = 'off';
let stateChangeCallback = null;

// PiP state
let pipVideo = null;
let pipListenersAttached = false;

// Audio state
let audioCtx = null;
let audioOscillator = null;
let audioGain = null;
let audioMediaElement = null;
let audioMediaListenersAttached = false;

// Heartbeat worker (keeps the main thread "alive" past hidden-tab throttling)
let heartbeatWorker = null;
let heartbeatWorkerBlobUrl = null;

// Web Lock (Chromium uses lock holding as a "the page is doing work" hint)
let webLockAbortController = null;

// Page lifecycle listeners (re-arm audio after the OS suspends us)
let pageLifecycleListenersAttached = false;

function hasAndroidKeepAliveBridge() {
    return typeof window !== 'undefined'
        && typeof window.LukerAndroid === 'object'
        && typeof window.LukerAndroid.setBackgroundKeepAliveEnabled === 'function';
}

function hasPipSupport() {
    return typeof document !== 'undefined'
        && 'pictureInPictureEnabled' in document
        && document.pictureInPictureEnabled === true
        && typeof HTMLVideoElement !== 'undefined'
        && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
}

function hasAudioSupport() {
    if (typeof window === 'undefined') return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    return typeof Ctx === 'function' && typeof Audio === 'function';
}

function resolvePlatform() {
    if (hasAndroidKeepAliveBridge()) return 'android';
    if (hasPipSupport() || hasAudioSupport()) return 'web';
    return 'unsupported';
}

// ---------- PiP ----------

function ensurePipVideo() {
    if (pipVideo) return pipVideo;
    const video = document.createElement('video');
    video.src = SILENT_VIDEO_URL;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    // iOS refuses PiP on muted media; near-zero volume keeps it inaudible.
    video.muted = false;
    video.volume = 0.0001;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:160px;height:90px;pointer-events:none;opacity:0;';
    document.body.appendChild(video);
    pipVideo = video;
    return video;
}

function onLeavePip() {
    if (activeMode !== 'pip') return;
    activeMode = 'off';
    notifyStateChange();
}

function attachPipListeners() {
    if (pipListenersAttached || !pipVideo) return;
    pipVideo.addEventListener('leavepictureinpicture', onLeavePip);
    pipListenersAttached = true;
}

function detachPipListeners() {
    if (!pipListenersAttached || !pipVideo) return;
    pipVideo.removeEventListener('leavepictureinpicture', onLeavePip);
    pipListenersAttached = false;
}

async function enterPip() {
    const video = ensurePipVideo();
    attachPipListeners();
    if (document.pictureInPictureElement === video) return;
    await video.play();
    await video.requestPictureInPicture();
}

async function exitPip() {
    try {
        if (document.pictureInPictureElement === pipVideo && pipVideo) {
            await document.exitPictureInPicture();
        }
    } finally {
        if (pipVideo) {
            try { pipVideo.pause(); } catch (_) { /* noop */ }
        }
    }
}

// ---------- Audio ----------

function ensureAudioGraph() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioOscillator = audioCtx.createOscillator();
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0.0001;
    audioOscillator.frequency.value = 1;
    audioOscillator.connect(audioGain).connect(audioCtx.destination);
    audioOscillator.start();
}

function onAudioMediaEnded() {
    if (activeMode === 'audio') {
        audioMediaElement?.play().catch(() => { /* noop */ });
    }
}

function onAudioMediaPaused() {
    // Browsers pause backgrounded <audio> on their own; this is what kills keep-alive
    // unless we re-arm it. The 500ms delay avoids fighting a real user pause from the
    // MediaSession card (which we want to override too, but the delay smooths things).
    if (activeMode !== 'audio') return;
    setTimeout(() => {
        if (activeMode !== 'audio') return;
        audioMediaElement?.play().catch(() => { /* noop */ });
    }, 500);
}

function ensureAudioElement() {
    if (audioMediaElement) return audioMediaElement;
    const el = new Audio(SILENT_VIDEO_URL);
    el.loop = true;
    el.volume = 0.0001;
    el.preload = 'auto';
    el.setAttribute('aria-hidden', 'true');
    audioMediaElement = el;
    return el;
}

function attachAudioMediaListeners() {
    if (audioMediaListenersAttached || !audioMediaElement) return;
    audioMediaElement.addEventListener('ended', onAudioMediaEnded);
    audioMediaElement.addEventListener('pause', onAudioMediaPaused);
    audioMediaListenersAttached = true;
}

function detachAudioMediaListeners() {
    if (!audioMediaListenersAttached || !audioMediaElement) return;
    audioMediaElement.removeEventListener('ended', onAudioMediaEnded);
    audioMediaElement.removeEventListener('pause', onAudioMediaPaused);
    audioMediaListenersAttached = false;
}

function installMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
        if (typeof MediaMetadata === 'function') {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Luker',
                artist: 'Background keep-alive',
            });
        }
        // Refuse the user's pause request to keep the keep-alive running.
        // When the user wants to stop, they toggle the setting off in Luker.
        navigator.mediaSession.setActionHandler('play', () => {
            audioMediaElement?.play().catch(() => { /* noop */ });
        });
        navigator.mediaSession.setActionHandler('pause', () => {
            audioMediaElement?.play().catch(() => { /* noop */ });
        });
    } catch (_) { /* noop */ }
}

function clearMediaSessionHandlers() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
    } catch (_) { /* noop */ }
}

async function enterAudio() {
    ensureAudioGraph();
    if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch (_) { /* noop */ }
    }
    const el = ensureAudioElement();
    attachAudioMediaListeners();
    await el.play();
    installMediaSessionHandlers();
}

async function exitAudio() {
    clearMediaSessionHandlers();
    detachAudioMediaListeners();
    if (audioMediaElement) {
        try { audioMediaElement.pause(); } catch (_) { /* noop */ }
    }
    if (audioCtx && audioCtx.state === 'running') {
        try { await audioCtx.suspend(); } catch (_) { /* noop */ }
    }
}

// ---------- Heartbeat worker ----------

function startHeartbeatWorker() {
    if (heartbeatWorker || typeof Worker !== 'function') return;
    const code = "let t=null;self.onmessage=e=>{if(e.data==='start')t=setInterval(()=>{self.postMessage('ping');try{fetch(self.location.origin||'/',{method:'HEAD',mode:'no-cors'}).catch(()=>{})}catch(_){}},15000);else if(e.data==='stop'){clearInterval(t);t=null;}};";
    try {
        const blob = new Blob([code], { type: 'application/javascript' });
        heartbeatWorkerBlobUrl = URL.createObjectURL(blob);
        heartbeatWorker = new Worker(heartbeatWorkerBlobUrl);
        heartbeatWorker.onmessage = resumeIfNeeded;
        heartbeatWorker.onerror = () => {
            stopHeartbeatWorker();
            if (activeMode !== 'off') setTimeout(startHeartbeatWorker, 1000);
        };
        heartbeatWorker.postMessage('start');
    } catch (_) { /* noop */ }
}

function stopHeartbeatWorker() {
    try { heartbeatWorker?.postMessage('stop'); } catch (_) { /* noop */ }
    try { heartbeatWorker?.terminate(); } catch (_) { /* noop */ }
    heartbeatWorker = null;
    if (heartbeatWorkerBlobUrl) {
        try { URL.revokeObjectURL(heartbeatWorkerBlobUrl); } catch (_) { /* noop */ }
        heartbeatWorkerBlobUrl = null;
    }
}

// ---------- Web Lock ----------

function acquireWebLock() {
    if (typeof navigator === 'undefined' || !('locks' in navigator)) return;
    releaseWebLock();
    try {
        webLockAbortController = new AbortController();
        navigator.locks
            .request('luker-keep-alive', { signal: webLockAbortController.signal }, () => new Promise(() => { /* never resolve */ }))
            .catch((error) => {
                if (error?.name !== 'AbortError') {
                    console.warn('[Luker] Web Lock request failed', error);
                }
            });
    } catch (_) { /* noop */ }
}

function releaseWebLock() {
    try { webLockAbortController?.abort(); } catch (_) { /* noop */ }
    webLockAbortController = null;
}

// ---------- Page lifecycle (re-arm after OS unsuspends) ----------

function resumeIfNeeded() {
    if (activeMode === 'audio') {
        if (audioCtx?.state === 'suspended') {
            audioCtx.resume().catch(() => { /* noop */ });
        }
        if (audioMediaElement?.paused) {
            audioMediaElement.play().catch(() => { /* noop */ });
        }
    }
    if (activeMode === 'pip' && pipVideo?.paused) {
        pipVideo.play().catch(() => { /* noop */ });
    }
}

function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
        resumeIfNeeded();
    }
}

function attachPageLifecycleListeners() {
    if (pageLifecycleListenersAttached) return;
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', resumeIfNeeded);
    pageLifecycleListenersAttached = true;
}

function detachPageLifecycleListeners() {
    if (!pageLifecycleListenersAttached) return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('resume', resumeIfNeeded);
    pageLifecycleListenersAttached = false;
}

// ---------- Notification ----------

function notifyStateChange() {
    if (typeof stateChangeCallback === 'function') {
        try { stateChangeCallback(activeMode); } catch (_) { /* noop */ }
    }
}

// ---------- Public API ----------

/**
 * @returns {KeepAlivePlatform}
 */
export function getKeepAlivePlatform() {
    return platform;
}

/**
 * @returns {KeepAliveMode} the keep-alive mode currently in effect.
 */
export function getActiveKeepAliveMode() {
    return activeMode;
}

/**
 * Whether the current device exposes any keep-alive mechanism we can drive.
 */
export function isKeepAliveSupported() {
    return platform !== 'unsupported';
}

/**
 * Which web modes the current device can run (only meaningful when platform === 'web').
 * @returns {{pip: boolean, audio: boolean}}
 */
export function getAvailableWebModes() {
    return { pip: hasPipSupport(), audio: hasAudioSupport() };
}

/**
 * Register a callback invoked when the active mode changes outside of an explicit
 * setKeepAliveMode() call (e.g. user closed the PiP window via the OS UI).
 * Only one callback is retained.
 */
export function onKeepAliveStateChanged(callback) {
    stateChangeCallback = typeof callback === 'function' ? callback : null;
}

/**
 * Switch the keep-alive mode. Must be called inside a user-gesture handler when
 * switching to a web mode — browsers block PiP/audio start otherwise.
 *
 * @param {KeepAliveMode} desired
 * @returns {Promise<KeepAliveMode>} the final mode (may be 'off' if entry failed)
 */
export async function setKeepAliveMode(desired) {
    const target = desired === 'android' || desired === 'pip' || desired === 'audio' ? desired : 'off';

    // Switching away from the current mode: tear down first.
    if (activeMode === 'pip' && target !== 'pip') {
        await exitPip();
    }
    if (activeMode === 'audio' && target !== 'audio') {
        await exitAudio();
    }
    if (activeMode === 'android' && target !== 'android') {
        try {
            window.LukerAndroid.setBackgroundKeepAliveEnabled(false);
        } catch (error) {
            console.warn('[Luker] Failed to disable Android background keep-alive', error);
        }
    }

    // Web-mode supplements: tear down when leaving any web mode entirely.
    const wasWebMode = activeMode === 'pip' || activeMode === 'audio';
    const willBeWebMode = target === 'pip' || target === 'audio';
    if (wasWebMode && !willBeWebMode) {
        stopHeartbeatWorker();
        releaseWebLock();
        detachPageLifecycleListeners();
    }

    if (target === 'off') {
        activeMode = 'off';
        return 'off';
    }

    if (target === 'android') {
        if (platform !== 'android') {
            activeMode = 'off';
            return 'off';
        }
        try {
            window.LukerAndroid.setBackgroundKeepAliveEnabled(true);
            activeMode = 'android';
            return 'android';
        } catch (error) {
            console.warn('[Luker] Failed to enable Android background keep-alive', error);
            activeMode = 'off';
            return 'off';
        }
    }

    if (target === 'pip') {
        if (!hasPipSupport()) {
            activeMode = 'off';
            return 'off';
        }
        try {
            await enterPip();
            activeMode = 'pip';
            if (!wasWebMode) {
                startHeartbeatWorker();
                acquireWebLock();
                attachPageLifecycleListeners();
            }
            return 'pip';
        } catch (error) {
            console.warn('[Luker] Failed to enter PiP for keep-alive', error);
            detachPipListeners();
            activeMode = 'off';
            throw error;
        }
    }

    if (target === 'audio') {
        if (!hasAudioSupport()) {
            activeMode = 'off';
            return 'off';
        }
        try {
            await enterAudio();
            activeMode = 'audio';
            if (!wasWebMode) {
                startHeartbeatWorker();
                acquireWebLock();
                attachPageLifecycleListeners();
            }
            return 'audio';
        } catch (error) {
            console.warn('[Luker] Failed to start audio keep-alive', error);
            try { await exitAudio(); } catch (_) { /* noop */ }
            activeMode = 'off';
            throw error;
        }
    }

    activeMode = 'off';
    return 'off';
}

export function initKeepAlive() {
    platform = resolvePlatform();
    return platform;
}
