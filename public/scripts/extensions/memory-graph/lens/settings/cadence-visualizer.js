// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live pure-DOM animated visualizer illustrating extraction cadence and floor
// hiding for the currently selected Memory Graph settings.

import { h, clear, put } from '../../../../lens-shared/util.js';
import { i18n, i18nFormat } from '../i18n.js';
import { buildCadenceDemoFrames } from './settings-model.js';

const STEP_INTERVAL_MS = 2400;

function prefersReducedMotion() {
    return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Renders a compact loop-animated timeline showing how extraction triggers and
 * older chat messages hide under the current cadence/visibility parameters.
 *
 * @param {object} initialParams
 * @param {{ autoPlay?: boolean }} [options]
 */
export function createCadenceVisualizer(initialParams = {}, { autoPlay = true } = {}) {
    let frames = buildCadenceDemoFrames(initialParams);
    let stepIdx = 0;
    let playing = Boolean(autoPlay) && !prefersReducedMotion();
    let timer = 0;
    let destroyed = false;

    const el = h('div', { class: 'ml-cadence-demo', role: 'region', 'aria-label': i18n('Cadence & floor-hiding presets') });
    const headerLeft = h('div', { class: 'ml-cadence-demo-badges' });
    const controlsEl = h('div', { class: 'ml-cadence-demo-controls' });
    const trackEl = h('div', { class: 'ml-cadence-demo-track' });
    const captionEl = h('div', { class: 'ml-cadence-demo-caption' });
    const gapLegendItem = h('span', { class: 'ml-cadence-legend-item is-gap', hidden: true }, h('i', { class: 'ml-cadence-swatch' }), h('span', { text: i18n('Hidden before extract') }));
    const legendEl = h('div', { class: 'ml-cadence-demo-legend' },
        h('span', { class: 'ml-cadence-legend-item is-visible' }, h('i', { class: 'ml-cadence-swatch' }), h('span', { text: i18n('Visible') })),
        h('span', { class: 'ml-cadence-legend-item is-extracting' }, h('i', { class: 'ml-cadence-swatch' }), h('span', { text: i18n('Extracting') })),
        h('span', { class: 'ml-cadence-legend-item is-hidden' }, h('i', { class: 'ml-cadence-swatch' }), h('span', { text: i18n('Hidden (in graph)') })),
        gapLegendItem,
    );

    put(el,
        h('div', { class: 'ml-cadence-demo-head' }, headerLeft, controlsEl),
        trackEl,
        captionEl,
        legendEl,
    );

    function stopTimer() {
        if (timer) {
            clearInterval(timer);
            timer = 0;
        }
    }

    function ensureTimer() {
        stopTimer();
        if (destroyed || !playing || frames.length <= 1) return;
        timer = setInterval(() => {
            if (destroyed || !playing) {
                stopTimer();
                return;
            }
            if (!el.isConnected || el.hidden || el.closest?.('[hidden]')) return;
            stepIdx = (stepIdx + 1) % frames.length;
            renderFrame();
        }, STEP_INTERVAL_MS);
    }

    function renderControls() {
        clear(controlsEl);
        const playBtn = h('button', {
            type: 'button',
            class: 'ml-cadence-demo-toggle',
            title: playing ? i18n('Pause preview') : i18n('Play preview'),
            'aria-label': playing ? i18n('Pause preview') : i18n('Play preview'),
            'aria-pressed': String(playing),
            onClick: () => {
                if (playing) pause();
                else play();
            },
        }, playing ? '⏸' : '▶');

        const dots = h('div', { class: 'ml-cadence-demo-dots', role: 'tablist' },
            frames.map((f, idx) => h('button', {
                type: 'button',
                class: `ml-cadence-demo-dot ${idx === stepIdx ? 'is-active' : ''}`.trim(),
                title: i18nFormat('Step ${0}', f.step),
                'aria-label': i18nFormat('Step ${0}', f.step),
                'aria-selected': String(idx === stepIdx),
                onClick: () => {
                    playing = false;
                    stopTimer();
                    stepIdx = idx;
                    renderFrame();
                },
            })),
        );
        put(controlsEl, dots, playBtn);
    }

    function renderFrame() {
        const frame = frames[stepIdx] || frames[0];
        if (!frame) return;

        el.classList.toggle('has-gap', Boolean(frame.hasGap));
        gapLegendItem.hidden = !frame.hasGap;
        el.dataset.step = String(frame.step);

        clear(headerLeft);
        put(headerLeft,
            h('span', { class: 'ml-cadence-badge is-graph' },
                h('span', { class: 'ml-cadence-badge-k', text: `${i18n('Memory graph')}: ` }),
                h('strong', { text: frame.graphCovered })),
            h('span', { class: 'ml-cadence-badge is-window', text: frame.visibleLabel }),
        );

        clear(trackEl);
        const hiddenPills = [];
        const visiblePills = [];
        for (const msg of frame.messages) {
            const pill = h('span', {
                class: `ml-cadence-pill is-${msg.state} role-${msg.role}`,
                dataset: { state: msg.state, msgId: msg.id },
                text: msg.id,
            });
            if (msg.state === 'hidden-extracted' || msg.state === 'hidden-unextracted') {
                hiddenPills.push(pill);
            } else {
                visiblePills.push(pill);
            }
        }

        if (hiddenPills.length > 0) {
            put(trackEl,
                h('div', { class: 'ml-cadence-zone is-hidden-zone' }, ...hiddenPills),
                h('span', { class: 'ml-cadence-divider', 'aria-hidden': 'true' }),
            );
        }
        put(trackEl, h('div', { class: 'ml-cadence-zone is-visible-zone' }, ...visiblePills));

        captionEl.textContent = frame.caption;
        renderControls();
    }

    function setParams(params) {
        frames = buildCadenceDemoFrames(params);
        // When reduced motion is active, land on the first frame that shows hiding or gap.
        if (prefersReducedMotion()) {
            const idx = frames.findIndex(f => f.hasGap || f.messages.some(m => m.state === 'hidden-extracted'));
            stepIdx = idx >= 0 ? idx : Math.max(0, frames.length - 1);
        } else {
            stepIdx = 0;
        }
        renderFrame();
        ensureTimer();
    }

    function setStep(index) {
        if (!frames.length) return;
        stepIdx = ((Math.floor(Number(index) || 0) % frames.length) + frames.length) % frames.length;
        renderFrame();
    }

    function pause() {
        playing = false;
        stopTimer();
        renderControls();
    }

    function play() {
        playing = true;
        renderControls();
        ensureTimer();
    }

    function destroy() {
        destroyed = true;
        stopTimer();
    }

    if (prefersReducedMotion()) {
        const idx = frames.findIndex(f => f.hasGap || f.messages.some(m => m.state === 'hidden-extracted'));
        stepIdx = idx >= 0 ? idx : Math.max(0, frames.length - 1);
    }
    renderFrame();
    ensureTimer();

    return { el, setParams, setStep, pause, play, destroy };
}
