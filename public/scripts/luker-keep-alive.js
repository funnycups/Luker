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

// Audio mode: armed (resources built, not playing) vs active (playing).
// A 1Hz OscillatorNode -> tiny gain -> AudioContext.destination keeps Chromium
// from throttling the tab; a real <audio> element + MediaSession metadata
// registers a media session so the OS treats us as foreground media. Both must
// run together — osc alone fails to surface a MediaSession card, <audio> alone
// gets decoder-throttled in background.
let audioCtx = null;
let audioOscillator = null;
let audioGain = null;
let audioEl = null;
let audioActive = false;
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

async function startOscillator() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    audioGain = audioCtx.createGain();
    audioGain.gain.value = 0.0001;
    audioOscillator = audioCtx.createOscillator();
    audioOscillator.frequency.value = 1;
    audioOscillator.connect(audioGain).connect(audioCtx.destination);
    audioOscillator.start();
    // Suspend immediately so the oscillator doesn't claim audio focus / surface a
    // playing-media notification while we're just armed and idle. Resumed in
    // setAudioActiveInternal(true) once a generation actually starts.
    try { await audioCtx.suspend(); } catch (_) { /* noop */ }
}

async function stopOscillator() {
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

function onAudioEnded() {
    if (audioActive) audioEl?.play().catch(() => { /* noop */ });
}

function onAudioPause() {
    if (audioActive) {
        setTimeout(() => {
            if (audioActive) audioEl?.play().catch(() => { /* noop */ });
        }, 500);
    }
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

function ensureMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Luker',
            artist: 'Background keep-alive',
        });
        navigator.mediaSession.setActionHandler('play',  () => audioEl?.play().catch(() => {}));
        navigator.mediaSession.setActionHandler('pause', () => audioEl?.play().catch(() => {}));
    } catch (error) {
        console.warn('[Luker] MediaSession setup failed', error);
    }
}

function clearMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.playbackState = 'none';
    } catch (_) { /* noop */ }
}

// Arm: build the oscillator + <audio> element while we still have a user
// gesture, so later setAudioKeepAliveActive() calls (driven by GENERATION_*
// events) can play() without a fresh gesture. Priming with a play→pause cycle
// gives Chrome the "user has authorized this element" record. The oscillator
// stays suspended and the audio element stays paused — nothing surfaces a
// media notification until setAudioKeepAliveActive(true) flips us into active.
async function armAudio() {
    if (audioEl) return;
    await startOscillator();
    audioEl = new Audio(SILENT_AUDIO_URL);
    audioEl.loop = true;
    audioEl.volume = 0.001;
    audioEl.preload = 'auto';
    attachAudioListeners();
    try {
        await audioEl.play();
        audioEl.pause();
    } catch (error) {
        await disarmAudio();
        throw error;
    }
}

async function disarmAudio() {
    audioActive = false;
    clearMediaSession();
    detachAudioListeners();
    if (audioEl) {
        try { audioEl.pause(); } catch (_) { /* noop */ }
        try { audioEl.src = ''; } catch (_) { /* noop */ }
        audioEl = null;
    }
    await stopOscillator();
}

async function setAudioActiveInternal(shouldBeActive) {
    if (activeMode !== 'audio' || !audioEl) return;
    if (shouldBeActive === audioActive) return;
    audioActive = shouldBeActive;
    if (shouldBeActive) {
        if (audioCtx?.state === 'suspended') {
            try { await audioCtx.resume(); } catch (_) { /* noop */ }
        }
        try { await audioEl.play(); } catch (error) {
            console.warn('[Luker] Failed to start audio keep-alive playback', error);
            audioActive = false;
            try { await audioCtx?.suspend(); } catch (_) { /* noop */ }
            return;
        }
        ensureMediaSession();
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = 'playing'; } catch (_) { /* noop */ }
        }
    } else {
        try { audioEl.pause(); } catch (_) { /* noop */ }
        // Clearing metadata makes the lock-screen card disappear entirely;
        // just flipping playbackState to 'paused' would leave a stale "paused"
        // card visible on Android.
        clearMediaSession();
        if (audioCtx?.state === 'running') {
            try { await audioCtx.suspend(); } catch (_) { /* noop */ }
        }
    }
}

// ---------- Page lifecycle (re-arm after OS unsuspends) ----------

function resumeIfNeeded() {
    if (activeMode === 'audio' && audioActive) {
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
        await disarmAudio();
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
            await armAudio();
            activeMode = 'audio';
            attachPageLifecycleListeners();
            return 'audio';
        } catch (error) {
            console.warn('[Luker] Failed to arm audio keep-alive', error);
            try { await disarmAudio(); } catch (_) { /* noop */ }
            activeMode = 'off';
            throw error;
        }
    }

    activeMode = 'off';
    return 'off';
}

/**
 * Start or stop the silent audio playback for the audio mode. Only meaningful
 * when activeMode === 'audio' — a no-op otherwise. Designed to be called from
 * GENERATION_STARTED / GENERATION_ENDED handlers so the lock-screen card and
 * audio-focus claim only appear while a message is being generated.
 *
 * @param {boolean} shouldBeActive
 */
export async function setAudioKeepAliveActive(shouldBeActive) {
    await setAudioActiveInternal(!!shouldBeActive);
}

/**
 * Whether the audio keep-alive is currently playing (and thus showing a
 * lock-screen media card).
 */
export function isAudioKeepAliveActive() {
    return audioActive;
}

export function initKeepAlive() {
    platform = resolvePlatform();
    return platform;
}
