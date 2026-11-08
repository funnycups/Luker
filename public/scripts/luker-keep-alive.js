// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { disposePipView, getPipViewStream, setPipViewLive } from './luker-pip-view.js';

const SILENT_VIDEO_URL = '/sounds/silent.mp4';
const SILENT_AUDIO_URL = '/sounds/silent-keepalive.m4a';

/** @typedef {'off'|'android'|'harmony'|'ios'|'pip'|'audio'} KeepAliveMode */
/** @typedef {'android'|'harmony'|'ios'|'web'|'unsupported'} KeepAlivePlatform */

let platform = 'unsupported';
/** @type {KeepAliveMode} */
let activeMode = 'off';
let stateChangeCallback = null;

// PiP state
let pipVideo = null;
let pipListenersAttached = false;
// The live view failed to open once in this session; later entries use the
// silent video. Not persisted: a reload retries the live view.
let pipViewFailed = false;
let pipEntryPending = false;

// Audio mode runs in a single binary state: built when entered, fully torn
// down when exited. A 1Hz OscillatorNode running through near-zero gain into
// AudioContext.destination keeps Chromium from throttling the tab; a real
// <audio> element with a MediaSession registers a media session so the OS
// treats this tab as foreground media.
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

// The HarmonyOS shell holds a dataTransfer continuous task only while the page
// reports an in-flight generation and the app is in the background.
function hasHarmonyKeepAliveBridge() {
    return typeof window !== 'undefined'
        && typeof window.LukerHarmony === 'object'
        && window.LukerHarmony !== null
        && typeof window.LukerHarmony.setGenerationActive === 'function';
}

// The iOS shell holds a background task only while the page reports an
// in-flight generation. The task is best effort: the system may end it at any
// time, so the page treats this exactly like the HarmonyOS lease.
function hasIOSKeepAliveBridge() {
    return typeof window !== 'undefined'
        && typeof window.LukerIOS === 'object'
        && window.LukerIOS !== null
        && typeof window.LukerIOS.setGenerationActive === 'function';
}

// iOS Home Screen web apps report PiP as enabled, but WebKit never actually
// opens the window there (https://bugs.webkit.org/show_bug.cgi?id=303885).
// navigator.standalone is only defined by iOS WebKit.
function isIOSHomeScreenApp() {
    return typeof navigator !== 'undefined' && navigator.standalone === true;
}

function hasPipSupport() {
    return typeof document !== 'undefined'
        && !isIOSHomeScreenApp()
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
    if (hasHarmonyKeepAliveBridge()) return 'harmony';
    if (hasIOSKeepAliveBridge()) return 'ios';
    if (hasPipSupport() || hasAudioSupport()) return 'web';
    return 'unsupported';
}

// ---------- PiP ----------

function ensurePipVideo() {
    if (pipVideo) return pipVideo;
    const video = document.createElement('video');
    const viewStream = pipViewFailed ? null : getPipViewStream();
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('autopictureinpicture', '');
    video.preload = 'auto';
    if (viewStream) {
        video.srcObject = viewStream;
        // Start muted so the frames flow and metadata is ready before the
        // user picks PiP, without taking over the audio session yet.
        video.muted = true;
        video.addEventListener('loadeddata', () => {
            if (!pipEntryPending && activeMode !== 'pip' && !isInPip(video)) video.pause();
        }, { once: true });
    } else {
        video.src = SILENT_VIDEO_URL;
        // iOS refuses PiP on muted media; near-zero volume keeps it inaudible.
        video.muted = false;
    }
    video.volume = 0.0001;
    video.setAttribute('aria-hidden', 'true');
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:160px;height:90px;pointer-events:none;opacity:0;';
    document.body.appendChild(video);
    pipVideo = video;
    if (viewStream) video.play().catch(() => { /* noop */ });
    return video;
}

// The live view failed to open PiP: drop the element so this session falls
// back to the silent video. A reload retries the live view.
function abandonPipView() {
    if (!pipVideo || pipVideo.srcObject === null) return;
    pipViewFailed = true;
    detachPipListeners();
    try { pipVideo.pause(); } catch (_) { /* noop */ }
    pipVideo.srcObject = null;
    pipVideo.remove();
    pipVideo = null;
    disposePipView();
}

function isInPip(video) {
    return !!video && (document.pictureInPictureElement === video
        || video.webkitPresentationMode === 'picture-in-picture');
}

function onLeavePip() {
    setPipViewLive(false);
    // The hidden element keeps decoding otherwise; pause it until the next
    // entry runs inside a user gesture. An entry in progress keeps playing.
    if (pipVideo && !pipEntryPending) {
        try { pipVideo.pause(); } catch (_) { /* noop */ }
    }
    if (activeMode !== 'pip') return;
    activeMode = 'off';
    notifyStateChange();
}

function onPresentationModeChanged() {
    if (pipVideo && pipVideo.webkitPresentationMode !== 'picture-in-picture') onLeavePip();
}

function attachPipListeners() {
    if (pipListenersAttached || !pipVideo) return;
    pipVideo.addEventListener('leavepictureinpicture', onLeavePip);
    pipVideo.addEventListener('webkitpresentationmodechanged', onPresentationModeChanged);
    pipListenersAttached = true;
}

function detachPipListeners() {
    if (!pipListenersAttached || !pipVideo) return;
    pipVideo.removeEventListener('leavepictureinpicture', onLeavePip);
    pipVideo.removeEventListener('webkitpresentationmodechanged', onPresentationModeChanged);
    pipListenersAttached = false;
}

// WebKit only opens PiP when the request is made synchronously inside the
// user's tap and the video already has metadata. Both play() and the PiP
// request are therefore issued in the same synchronous turn — never after an
// await. On iOS the legacy webkitSetPresentationMode() is used when available:
// it is the path Safari itself uses and is more reliable than the standard
// API there. The video is primed by primePipKeepAlive() on an earlier tap.
//
// The legacy API reports the outcome only through an event. The bound keeps a
// transition that never reports back from leaving the setting toggle pending;
// a missed entry stays retryable.
const PIP_ENTRY_TIMEOUT_MS = 3000;
function waitForPipEntry(video) {
    return new Promise((resolve, reject) => {
        if (isInPip(video)) {
            resolve();
            return;
        }
        const done = () => {
            clearTimeout(timer);
            video.removeEventListener('webkitpresentationmodechanged', check);
            video.removeEventListener('enterpictureinpicture', check);
        };
        const check = () => {
            if (!isInPip(video)) return;
            done();
            resolve();
        };
        const timer = setTimeout(() => {
            done();
            if (isInPip(video)) resolve();
            else reject(new Error('Picture-in-Picture did not open'));
        }, PIP_ENTRY_TIMEOUT_MS);
        video.addEventListener('webkitpresentationmodechanged', check);
        video.addEventListener('enterpictureinpicture', check);
    });
}

async function enterPip() {
    const video = ensurePipVideo();
    attachPipListeners();
    if (isInPip(video)) return;
    if (video.srcObject) {
        // Only a failure with the stream fully ready says the device can't do
        // the live view; an early tap just needs another try.
        const ready = video.readyState >= HTMLMediaElement.HAVE_METADATA;
        setPipViewLive(true);
        pipEntryPending = true;
        try {
            await enterPipOn(video);
        } catch (error) {
            // The presentation event can trail the timeout; a window that did
            // open is a success.
            if (!isInPip(video)) {
                setPipViewLive(false);
                if (ready) abandonPipView();
                throw error;
            }
        } finally {
            pipEntryPending = false;
        }
        return;
    }
    await enterPipOn(video);
}

async function enterPipOn(video) {
    // The silent fallback is a network media element; requesting PiP while it
    // is still HAVE_NOTHING rejects with InvalidStateError on WebKit.
    if (!video.srcObject && video.readyState === HTMLMediaElement.HAVE_NOTHING) {
        video.load();
    }
    video.muted = false;
    const playPromise = video.play();
    if (typeof video.webkitSetPresentationMode === 'function'
        && typeof video.webkitSupportsPresentationMode === 'function'
        && video.webkitSupportsPresentationMode('picture-in-picture')) {
        video.webkitSetPresentationMode('picture-in-picture');
        await Promise.all([playPromise, waitForPipEntry(video)]);
        return;
    }
    const pipPromise = video.requestPictureInPicture();
    await Promise.all([playPromise, pipPromise]);
}

async function exitPip() {
    setPipViewLive(false);
    try {
        if (document.pictureInPictureElement === pipVideo && pipVideo) {
            await document.exitPictureInPicture();
        } else if (pipVideo?.webkitPresentationMode === 'picture-in-picture') {
            pipVideo.webkitSetPresentationMode('inline');
        }
    } catch (error) {
        // Teardown still proceeds; the element is paused and released below.
        console.warn('[Luker] Failed to close the PiP window', error);
    } finally {
        if (pipVideo) {
            try { pipVideo.pause(); } catch (_) { /* noop */ }
        }
    }
}

// Keep-alive is leaving PiP for good: release the captured stream, the
// canvas and the audio context instead of keeping them alive for a reopen.
function releasePipResources() {
    detachPipListeners();
    if (pipVideo) {
        try { pipVideo.pause(); } catch (_) { /* noop */ }
        pipVideo.srcObject = null;
        pipVideo.remove();
        pipVideo = null;
    }
    disposePipView();
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
    audioGain.gain.value = 0.001;
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
        // WebKit can skip the presentation-mode event when the user taps the
        // PiP window to return; reconcile against the real window state.
        if (activeMode === 'pip' && !isInPip(pipVideo)) onLeavePip();
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
 * Whether the PiP window is open right now. Safari can leave
 * webkitPresentationMode stale, so callers use the document-level check
 * instead of trusting the last mode the page set.
 */
export function isPipWindowOpen() {
    return isInPip(pipVideo);
}

/**
 * Drop the primed PiP video and live view without changing the active mode.
 * Used when the user picks the audio mode after the chooser primed PiP.
 */
export function releasePipKeepAlive() {
    releasePipResources();
}

/**
 * Whether the page runs inside a Luker app shell that provides native keep-alive.
 */
export function hasNativeKeepAliveBridge() {
    return hasAndroidKeepAliveBridge() || hasHarmonyKeepAliveBridge() || hasIOSKeepAliveBridge();
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
 * Start loading the PiP video so a later setKeepAliveMode('pip') can request
 * PiP synchronously. Call from a user-gesture handler: iOS only loads media
 * data inside a gesture.
 */
export function primePipKeepAlive() {
    if (!hasPipSupport()) return;
    const video = ensurePipVideo();
    if (!video.srcObject && video.readyState === HTMLMediaElement.HAVE_NOTHING) {
        video.load();
    }
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
    const target = desired === 'android' || desired === 'harmony' || desired === 'ios' || desired === 'pip' || desired === 'audio' ? desired : 'off';

    // Switching away from the current mode: tear down first.
    if (activeMode === 'pip' && target !== 'pip') {
        await exitPip();
        releasePipResources();
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
    if (activeMode === 'harmony' && target !== 'harmony') {
        try {
            window.LukerHarmony.setGenerationActive(false);
        } catch (error) {
            console.warn('[Luker] Failed to release HarmonyOS background keep-alive', error);
        }
    }
    if (activeMode === 'ios' && target !== 'ios') {
        try {
            window.LukerIOS.setGenerationActive(false);
        } catch (error) {
            console.warn('[Luker] Failed to release iOS background keep-alive', error);
        }
    }

    const wasWebMode = activeMode === 'pip' || activeMode === 'audio';
    const willBeWebMode = target === 'pip' || target === 'audio';
    if (wasWebMode && !willBeWebMode) {
        detachPageLifecycleListeners();
    }

    if (target === 'off') {
        releasePipResources();
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

    if (target === 'harmony') {
        if (platform !== 'harmony') {
            activeMode = 'off';
            return 'off';
        }
        try {
            window.LukerHarmony.setGenerationActive(true);
            activeMode = 'harmony';
            return 'harmony';
        } catch (error) {
            console.warn('[Luker] Failed to hold HarmonyOS background keep-alive', error);
            activeMode = 'off';
            return 'off';
        }
    }

    if (target === 'ios') {
        if (platform !== 'ios') {
            activeMode = 'off';
            return 'off';
        }
        try {
            window.LukerIOS.setGenerationActive(true);
            activeMode = 'ios';
            return 'ios';
        } catch (error) {
            console.warn('[Luker] Failed to hold iOS background keep-alive', error);
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

/**
 * Prime the PiP video on the next tap. Only needed when the saved setting
 * keeps PiP enabled across reloads; enabling it through the toggle already
 * builds the video inside that click.
 * @param {boolean} enabled
 */
export function setPipPrimingEnabled(enabled) {
    pipPrimingEnabled = Boolean(enabled);
    if (pipPrimingEnabled) armPipPriming();
}

// iOS only loads media inside a user gesture, and PiP can only open once the
// video has metadata. Load the tiny silent video on the first tap anywhere so
// it is ready long before the user picks Picture-in-Picture.
let pipPrimingEnabled = false;
let pipPrimingArmed = false;
function armPipPriming() {
    if (!pipPrimingEnabled || pipPrimingArmed || typeof document === 'undefined') return;
    if (platform !== 'web' || !hasPipSupport()) return;
    pipPrimingArmed = true;
    const prime = () => {
        document.removeEventListener('touchend', prime, true);
        document.removeEventListener('click', prime, true);
        pipPrimingArmed = false;
        if (!pipPrimingEnabled) return;
        primePipKeepAlive();
    };
    document.addEventListener('touchend', prime, true);
    document.addEventListener('click', prime, true);
}
