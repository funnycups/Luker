// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

const SILENT_VIDEO_URL = '/sounds/silent.mp4';
const SILENT_AUDIO_URL = '/sounds/silent-keepalive.m4a';

/** @typedef {'off'|'android'|'pip'|'audio'} KeepAliveMode */
/** @typedef {'android'|'web'|'unsupported'} KeepAlivePlatform */

let platform = 'unsupported';
/** @type {KeepAliveMode} */
let activeMode = 'off';
let stateChangeCallback = null;

// PiP state
let pipVideo = null;
let pipListenersAttached = false;

// Audio mode runs in a single binary state: built when entered, fully torn
// down when exited. A 1Hz OscillatorNode running through near-zero gain into
// AudioContext.destination keeps Chromium from throttling the tab; a real
// <audio> element with a MediaSession registers a media session so the OS
// treats this tab as foreground media. Toggling either of them off mid-session
// (e.g. "play only while generating") makes the OS reclaim the session a few
// minutes after screen-off — testing confirmed this.
let audioCtx = null;
let audioOscillator = null;
let audioGain = null;
let audioEl = null;
let audioListenersAttached = false;

// Page lifecycle listeners (re-arm audio after the OS unsuspends us)
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
    return typeof Ctx === 'function';
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

function onAudioEnded() {
    audioEl?.play().catch(() => { /* noop */ });
}

function onAudioPause() {
    setTimeout(() => audioEl?.play().catch(() => { /* noop */ }), 500);
}

function attachAudioListeners() {
    if (audioListenersAttached || !audioEl) return;
    audioEl.addEventListener('ended', onAudioEnded);
    audioEl.addEventListener('pause', onAudioPause);
    audioListenersAttached = true;
}

function detachAudioListeners() {
    if (!audioListenersAttached || !audioEl) return;
    audioEl.removeEventListener('ended', onAudioEnded);
    audioEl.removeEventListener('pause', onAudioPause);
    audioListenersAttached = false;
}

async function enterAudio() {
    if (audioEl) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0.0001;
    audioOscillator = audioCtx.createOscillator();
    audioOscillator.frequency.value = 1;
    audioOscillator.connect(audioGain).connect(audioCtx.destination);
    audioOscillator.start();

    audioEl = new Audio(SILENT_AUDIO_URL);
    audioEl.loop = true;
    audioEl.volume = 0.001;
    audioEl.preload = 'auto';
    attachAudioListeners();
    try {
        await audioEl.play();
    } catch (error) {
        await exitAudio();
        throw error;
    }

    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: 'Luker',
                artist: 'Background keep-alive',
            });
            navigator.mediaSession.setActionHandler('play',  () => audioEl?.play().catch(() => {}));
            navigator.mediaSession.setActionHandler('pause', () => audioEl?.play().catch(() => {}));
            navigator.mediaSession.playbackState = 'playing';
        } catch (error) {
            console.warn('[Luker] MediaSession setup failed', error);
        }
    }
}

async function exitAudio() {
    detachAudioListeners();
    if (audioEl) {
        try { audioEl.pause(); } catch (_) { /* noop */ }
        try { audioEl.src = ''; } catch (_) { /* noop */ }
        audioEl = null;
    }
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.setActionHandler('play', null);
            navigator.mediaSession.setActionHandler('pause', null);
            navigator.mediaSession.playbackState = 'none';
        } catch (_) { /* noop */ }
    }
    try { audioOscillator?.stop(); } catch (_) { /* noop */ }
    try { audioOscillator?.disconnect(); } catch (_) { /* noop */ }
    audioOscillator = null;
    try { audioGain?.disconnect(); } catch (_) { /* noop */ }
    audioGain = null;
    if (audioCtx) {
        try { await audioCtx.close(); } catch (_) { /* noop */ }
        audioCtx = null;
    }
}

// ---------- Page lifecycle (re-arm after OS unsuspends) ----------

function resumeIfNeeded() {
    if (activeMode === 'audio') {
        if (audioCtx?.state === 'suspended') {
            audioCtx.resume().catch(() => { /* noop */ });
        }
        if (audioEl?.paused) {
            audioEl.play().catch(() => { /* noop */ });
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

    const wasWebMode = activeMode === 'pip' || activeMode === 'audio';
    const willBeWebMode = target === 'pip' || target === 'audio';
    if (wasWebMode && !willBeWebMode) {
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
            attachPageLifecycleListeners();
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
            attachPageLifecycleListeners();
            return 'audio';
        } catch (error) {
            console.warn('[Luker] Failed to enter audio keep-alive', error);
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
