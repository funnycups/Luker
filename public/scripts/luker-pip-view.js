// SPDX-License-Identifier: AGPL-3.0-or-later

// Draws what the Picture-in-Picture keep-alive window shows: the current
// character, the generation status and the tail of the reply being written.
// The canvas is turned into a MediaStream (plus a near-silent audio track, like
// the silent fallback video) that the keep-alive <video> plays.

import { t } from './i18n.js';

const WIDTH = 960;
const HEIGHT = 540;
const PAD = 44;
const AVATAR = 112;
const TEXT_FONT_SIZE = 34;
const TEXT_LINE_HEIGHT = 48;
const TEXT_LINES = 4;
const RENDER_INTERVAL_MS = 250;
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif';

/** @typedef {'idle'|'generating'|'done'|'stopped'} PipStatus */

const state = {
    name: '',
    avatarUrl: '',
    /** @type {PipStatus} */
    status: 'idle',
    text: '',
};

let canvas = null;
let ctx = null;
let stream = null;
let videoTrack = null;
let audioCtx = null;
let audioOscillator = null;
let audioGain = null;
let avatarImg = null;
let avatarImgUrl = '';
let renderTimer = null;
let lastRenderAt = 0;
let heartbeatTimer = null;
const HEARTBEAT_MS = 1000;

export function isPipViewSupported() {
    return typeof document !== 'undefined'
        && typeof HTMLCanvasElement !== 'undefined'
        && typeof HTMLCanvasElement.prototype.captureStream === 'function'
        && typeof MediaStream === 'function';
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.body || document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

// Theme colors may carry alpha; the PiP frame has nothing behind it.
function opaque(color) {
    const match = /^rgba?\(([^)]+)\)$/i.exec(color);
    if (!match) return color;
    const [r, g, b] = match[1].split(/[\s,/]+/);
    return `rgb(${r}, ${g}, ${b})`;
}

function cleanText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_`#>~]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function wrapTail(text, maxWidth, maxLines) {
    const lines = [];
    let line = '';
    for (const ch of text) {
        const next = line + ch;
        if (ctx.measureText(next).width > maxWidth && line) {
            lines.push(line);
            line = ch.trimStart();
        } else {
            line = next;
        }
    }
    if (line) lines.push(line);
    return lines.slice(-maxLines);
}

function statusLabel() {
    const count = cleanText(state.text).length;
    switch (state.status) {
        case 'generating': return count ? t`Generating · ${count} chars` : t`Generating`;
        case 'done': return count ? t`Done · ${count} chars` : t`Done`;
        case 'stopped': return t`Stopped`;
        default: return t`Ready`;
    }
}

function ensureAvatar() {
    if (state.avatarUrl === avatarImgUrl) return;
    avatarImgUrl = state.avatarUrl;
    avatarImg = null;
    if (!avatarImgUrl) return;
    const img = new Image();
    img.onload = () => {
        if (avatarImgUrl === state.avatarUrl) {
            avatarImg = img;
            scheduleRender();
        }
    };
    img.src = avatarImgUrl;
}

function draw() {
    if (!ctx) return;
    const bg = opaque(cssVar('--SmartThemeBlurTintColor', 'rgb(23, 23, 23)'));
    const fg = cssVar('--SmartThemeBodyColor', 'rgb(220, 220, 210)');
    const dim = cssVar('--SmartThemeEmColor', 'rgb(145, 145, 145)');
    const accent = cssVar('--SmartThemeQuoteColor', 'rgb(225, 138, 36)');

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Avatar
    const ax = PAD;
    const ay = PAD;
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax + AVATAR / 2, ay + AVATAR / 2, AVATAR / 2, 0, Math.PI * 2);
    ctx.clip();
    if (avatarImg) {
        const s = Math.min(avatarImg.naturalWidth, avatarImg.naturalHeight);
        const sx = (avatarImg.naturalWidth - s) / 2;
        const sy = (avatarImg.naturalHeight - s) / 4;
        ctx.drawImage(avatarImg, sx, sy, s, s, ax, ay, AVATAR, AVATAR);
    } else {
        ctx.fillStyle = dim;
        ctx.fillRect(ax, ay, AVATAR, AVATAR);
        ctx.fillStyle = bg;
        ctx.font = `600 52px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(Array.from(state.name || '?')[0], ax + AVATAR / 2, ay + AVATAR / 2 + 2);
    }
    ctx.restore();

    // Name + status
    const tx = ax + AVATAR + 32;
    const maxNameWidth = WIDTH - tx - PAD;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = fg;
    ctx.font = `600 46px ${FONT_STACK}`;
    let name = state.name || 'Luker';
    while (ctx.measureText(name).width > maxNameWidth && name.length > 1) {
        name = name.slice(0, -2) + '…';
    }
    ctx.fillText(name, tx, ay + 50);

    const generating = state.status === 'generating';
    ctx.fillStyle = generating ? accent : dim;
    ctx.beginPath();
    ctx.arc(tx + 8, ay + 89, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `500 32px ${FONT_STACK}`;
    ctx.fillText(statusLabel(), tx + 28, ay + 100);

    // Reply tail
    const text = cleanText(state.text).slice(-600);
    if (text) {
        ctx.font = `400 ${TEXT_FONT_SIZE}px ${FONT_STACK}`;
        ctx.fillStyle = fg;
        const lines = wrapTail(text, WIDTH - PAD * 2, TEXT_LINES);
        const top = HEIGHT - PAD - TEXT_LINE_HEIGHT * TEXT_LINES + TEXT_FONT_SIZE;
        lines.forEach((line, i) => {
            ctx.globalAlpha = lines.length === TEXT_LINES && i === 0 ? 0.45 : 1;
            ctx.fillText(line, PAD, top + (TEXT_LINES - lines.length + i) * TEXT_LINE_HEIGHT);
        });
        ctx.globalAlpha = 1;
    }

    videoTrack?.requestFrame?.();
}

function render() {
    renderTimer = null;
    lastRenderAt = Date.now();
    ensureAvatar();
    draw();
}

function scheduleRender() {
    if (!canvas || renderTimer) return;
    const wait = Math.max(0, RENDER_INTERVAL_MS - (Date.now() - lastRenderAt));
    renderTimer = setTimeout(render, wait);
}

/**
 * While the PiP window is open, redraw once a second even without changes so
 * the stream keeps delivering frames (WebKit shows nothing until frames flow).
 * @param {boolean} live
 */
export function setPipViewLive(live) {
    if (live) {
        if (!canvas) return;
        if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => { /* noop */ });
        render();
        if (!heartbeatTimer) heartbeatTimer = setInterval(render, HEARTBEAT_MS);
    } else {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        // The window is closed: release the audio session until the next
        // entry, which runs inside a user gesture and may resume it.
        if (audioCtx?.state === 'running') audioCtx.suspend().catch(() => { /* noop */ });
    }
}

/**
 * @returns {PipStatus} what the window is currently showing.
 */
export function getPipViewStatus() {
    return state.status;
}

/**
 * Update what the window shows. Cheap to call on every streamed token.
 * @param {Partial<typeof state>} patch
 */
export function updatePipView(patch) {
    Object.assign(state, patch);
    scheduleRender();
}

/**
 * Build (once) the stream the keep-alive video plays. Must first run inside a
 * user gesture so the audio context is allowed to start.
 * @returns {MediaStream|null}
 */
export function getPipViewStream() {
    if (stream) {
        if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => { /* noop */ });
        return stream;
    }
    if (!isPipViewSupported()) return null;
    try {
        canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        // WebKit only captures frames from a canvas that is in the document.
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:160px;height:90px;pointer-events:none;opacity:0.01;';
        document.body.appendChild(canvas);
        ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D canvas is unavailable');
        // captureStream(0) + requestFrame() pushes a frame exactly when we
        // redraw, which keeps working while the page is in the background.
        stream = canvas.captureStream(0);
        videoTrack = stream.getVideoTracks()[0] || null;
        if (typeof videoTrack?.requestFrame !== 'function') {
            stream = canvas.captureStream(4);
            videoTrack = stream.getVideoTracks()[0] || null;
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (typeof Ctx === 'function') {
            audioCtx = new Ctx();
            audioGain = audioCtx.createGain();
            audioGain.gain.value = 0.001;
            audioOscillator = audioCtx.createOscillator();
            audioOscillator.frequency.value = 1;
            const dest = audioCtx.createMediaStreamDestination();
            audioOscillator.connect(audioGain).connect(dest);
            audioOscillator.start();
            dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
            audioCtx.resume().catch(() => { /* noop */ });
        }
        render();
        return stream;
    } catch (error) {
        console.warn('[Luker] PiP view unavailable', error);
        disposePipView();
        return null;
    }
}

/**
 * Tear down the canvas, the captured stream and the audio context. The next
 * getPipViewStream() rebuilds them; that call must run inside a user gesture.
 */
export function disposePipView() {
    if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    try { audioOscillator?.stop(); } catch (_) { /* noop */ }
    try { audioOscillator?.disconnect(); } catch (_) { /* noop */ }
    audioOscillator = null;
    try { audioGain?.disconnect(); } catch (_) { /* noop */ }
    audioGain = null;
    if (audioCtx) {
        audioCtx.close().catch(() => { /* noop */ });
        audioCtx = null;
    }
    stream?.getTracks().forEach((track) => {
        try { track.stop(); } catch (_) { /* noop */ }
    });
    stream = null;
    videoTrack = null;
    canvas?.remove();
    canvas = null;
    ctx = null;
    avatarImg = null;
    avatarImgUrl = '';
    lastRenderAt = 0;
}
