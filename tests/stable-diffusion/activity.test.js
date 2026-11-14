/**
 * @jest-environment jsdom
 */
import { jest } from '@jest/globals';
import {
    createImageActivity,
    formatImageActivityPill,
    formatImageActivitySummary,
} from '../../public/scripts/extensions/stable-diffusion/activity.js';

const t = text => String(text);
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

beforeAll(() => {
    if (!globalThis.matchMedia) {
        globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
    }
    if (!globalThis.requestAnimationFrame) {
        globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    }
    if (!globalThis.CSS) globalThis.CSS = {};
    if (typeof globalThis.CSS.escape !== 'function') {
        globalThis.CSS.escape = value => String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, character => `\\${character}`);
    }
});

function roundLabel(roundId = 'image-job-1') {
    return document.querySelector(`#luker-sd-run-panel [data-round-id="${roundId}"] .round-label`)?.textContent?.trim() ?? '';
}

function pillLabel() {
    return document.querySelector('#luker-sd-run-panel-pill .activity-pill-label')?.textContent ?? '';
}

test('pill view switches from prompt generation to image generation, then reports failures', () => {
    const now = performance.now();
    const prompting = formatImageActivityPill({ rounds: [
        { status: 'running', sections: [], startedAt: now - 5000 },
    ] }, t);
    expect(prompting).toMatchObject({ visible: true, text: 'Generating prompt', tone: 'running', loading: true });
    expect(prompting.detail).toMatch(/^0:0[45]$/);

    const generating = formatImageActivityPill({ rounds: [
        { status: 'running', sections: [{ id: 'prompt' }], startedAt: now - 1000 },
        { status: 'running', sections: [], startedAt: now - 2000 },
    ] }, t);
    expect(generating.text).toBe('Generating image · 2');

    const failed = formatImageActivityPill({ rounds: [
        { status: 'failed', sections: [], startedAt: now - 1000 },
        { status: 'failed', sections: [], startedAt: now - 1000 },
    ] }, t);
    expect(failed).toMatchObject({ visible: true, text: 'Image generation failed · 2', tone: 'error', loading: false });

    const acknowledgedFailure = formatImageActivityPill({ rounds: [
        { status: 'failed', sections: [], startedAt: now - 1000 },
    ] }, t, { acknowledged: true });
    expect(acknowledgedFailure.visible).toBe(false);

    const retrying = formatImageActivityPill({ rounds: [
        { id: 'round-1', status: 'running', sections: [{ id: 'round-1-prompt' }], startedAt: now - 3000 },
    ] }, t, { retryStates: new Map([['round-1', { attempt: 1, maxRetries: 3 }]]) });
    expect(retrying).toMatchObject({ visible: true, text: 'Retrying · 1/3', tone: 'attention', loading: true });

    expect(formatImageActivityPill({ rounds: [{ status: 'done', sections: [] }] }, t).visible).toBe(false);
});

test('summary counts jobs and failures', () => {
    expect(formatImageActivitySummary({ rounds: [] }, t)).toBe('Tasks: 0');
    expect(formatImageActivitySummary({ rounds: [{ status: 'done' }, { status: 'failed' }] }, t)).toBe('Tasks: 2 · 1 failed');
});

test('capsule appears before the prompt request and the panel shows prompt plus image', () => {
    const activity = createImageActivity({ translate: t });
    try {
        const job = activity.beginJob({ kind: 'generation' });
        const panel = document.getElementById('luker-sd-run-panel');
        const pill = document.getElementById('luker-sd-run-panel-pill');
        expect(panel.dataset.state).toBe('closed');
        expect(pill.hidden).toBe(false);
        expect(pillLabel()).toBe('Generating prompt');
        expect(roundLabel()).toBe('Generation #1 ·');

        job.setPrompt('a brass spyglass laid across a folded reef chart');
        expect(pillLabel()).toBe('Generating image');

        job.setImage('/user/images/result.png');
        job.finish('done');

        expect(pill.hidden).toBe(true);
        const image = document.querySelector('#luker-sd-run-panel img.section-image');
        expect(image).not.toBeNull();
        expect(image.getAttribute('src')).toBe('/user/images/result.png');
        const roundDetails = document.querySelector('#luker-sd-run-panel [data-round-id="image-job-1"] > details');
        expect(roundDetails.open).toBe(true);
        const promptSection = document.querySelector('#luker-sd-run-panel [data-section-id="image-job-1-prompt"]');
        expect(promptSection.querySelector(':scope > details').open).toBe(true);
    } finally {
        activity.destroy();
    }
});

test('a failed job keeps an error capsule until the panel is opened', async () => {
    const activity = createImageActivity({ translate: t });
    try {
        const job = activity.beginJob({ kind: 'generation' });
        job.setPrompt('a prompt');
        job.setError('upstream refused the request');
        job.finish('failed');
        await new Promise(resolve => setTimeout(resolve, 20));

        const panel = document.getElementById('luker-sd-run-panel');
        const pill = document.getElementById('luker-sd-run-panel-pill');
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.tone).toBe('error');
        expect(pillLabel()).toBe('Image generation failed');
        expect(document.querySelector('#luker-sd-run-panel [data-section-id="image-job-1-error"] pre').textContent)
            .toBe('upstream refused the request');

        pill.click();
        await flush();
        expect(panel.dataset.state).toBe('open');
        expect(pill.hidden).toBe(true);

        panel.querySelector('[data-action="close"]').click();
        expect(pill.hidden).toBe(true);
    } finally {
        activity.destroy();
    }
});

test('retries switch the capsule to the attention tone without touching panel content', () => {
    const activity = createImageActivity({ translate: t });
    try {
        const job = activity.beginJob({ kind: 'generation' });
        job.setPrompt('a prompt');
        job.setRetry(2, 3);

        const pill = document.getElementById('luker-sd-run-panel-pill');
        expect(pill.hidden).toBe(false);
        expect(pill.dataset.tone).toBe('attention');
        expect(pillLabel()).toBe('Retrying · 2/3');
        expect(document.querySelectorAll('#luker-sd-run-panel .section')).toHaveLength(1);

        job.setImage('/user/images/result.png');
        job.finish('done');
        expect(pill.hidden).toBe(true);
    } finally {
        activity.destroy();
    }
});

test('abortAll cancels active jobs immediately and ignores late sections', () => {
    const activity = createImageActivity({ translate: t });
    const abort = jest.fn();
    try {
        const job = activity.beginJob({ kind: 'generation', abort });
        activity.abortAll();
        expect(abort).toHaveBeenCalledTimes(1);
        expect(activity.store.getCurrentRun()?.status).toBe('aborted');
        expect(document.querySelector('#luker-sd-run-panel-pill').hidden).toBe(true);

        job.setPrompt('late prompt');
        job.finish('done');
        expect(document.querySelectorAll('#luker-sd-run-panel .section')).toHaveLength(0);
        expect(activity.store.getCurrentRun()?.status).toBe('aborted');
    } finally {
        activity.destroy();
    }
});

test('illustration jobs use message labels and share one run with generations', () => {
    const activity = createImageActivity({ translate: t });
    try {
        const illustration = activity.beginJob({ kind: 'illustration', messageIndex: 11 });
        const generation = activity.beginJob({ kind: 'generation' });
        expect(roundLabel('image-job-1')).toBe('Message #12 ·');
        expect(roundLabel('image-job-2')).toBe('Generation #1 ·');

        illustration.finish('done');
        expect(activity.store.getCurrentRun()?.status).toBe('running');
        generation.finish('done');
        expect(activity.store.getCurrentRun()?.status).toBe('committed');
        expect(document.querySelector('#luker-sd-run-panel-pill').hidden).toBe(true);
    } finally {
        activity.destroy();
    }
});

test('a new job after a finished run starts a fresh run', () => {
    const activity = createImageActivity({ translate: t });
    try {
        const first = activity.beginJob({ kind: 'generation' });
        first.setPrompt('first');
        first.finish('done');
        expect(activity.store.getCurrentRun()?.status).toBe('committed');

        activity.beginJob({ kind: 'generation' });
        const rounds = document.querySelectorAll('#luker-sd-run-panel .round');
        expect(rounds).toHaveLength(1);
        expect(roundLabel()).toBe('Generation #1 ·');
        expect(document.querySelector('#luker-sd-run-panel-pill').hidden).toBe(false);
    } finally {
        activity.destroy();
    }
});
