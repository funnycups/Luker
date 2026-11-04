/** @jest-environment jsdom */
import { createActivityPill } from '../../public/scripts/activity-pill.js';

const pills = [];
const make = options => {
    const pill = createActivityPill({ id: 'test-activity', onOpen: () => {}, onError: error => { throw error; }, ...options });
    pills.push(pill);
    return pill;
};
afterEach(() => { for (const pill of pills.splice(0)) pill.destroy(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('distinct managed pills share one wrapping host and release only their own resources', () => {
    const a = make({ id: 'a', className: 'legacy-pill' });
    const b = make({ id: 'b' });
    a.update({ visible: true, text: 'Desk', tone: 'running', loading: true });
    b.update({ visible: true, text: 'Cloud', tone: 'attention', loading: false });
    const host = a.element.parentElement;
    expect(host).toBe(b.element.parentElement);
    expect(document.querySelectorAll('.activity-pill-host')).toHaveLength(1);
    expect(a.element.classList.contains('legacy-pill')).toBe(true);
    expect(host.hidden).toBe(false);
    a.destroy();
    expect(b.element.isConnected).toBe(true);
    expect(document.querySelector('link[href="/css/activity-pill.css"]')).not.toBeNull();
    b.destroy();
    expect(host.isConnected).toBe(false);
    expect(document.querySelector('link[href="/css/activity-pill.css"]')).toBeNull();
});

test('labels remain safe text with complete accessible names and an indeterminate loading role', () => {
    const pill = make();
    const text = '<img src=x onerror=alert(1)> Cloud with a very long label';
    pill.update({ visible: true, text, tone: 'running', loading: true });
    expect(pill.element.tagName).toBe('BUTTON');
    expect(pill.element.type).toBe('button');
    expect(pill.element.getAttribute('aria-label')).toBe(text);
    expect(pill.element.title).toBe(text);
    expect(pill.element.querySelector('img')).toBeNull();
    expect(pill.element.textContent).toBe(text);
    const progress = pill.element.querySelector('[role="progressbar"]');
    expect(progress.hidden).toBe(false);
    expect(progress.hasAttribute('aria-valuenow')).toBe(false);
    expect(progress.hasAttribute('aria-valuemax')).toBe(false);
    pill.element.focus();
    expect(document.activeElement).toBe(pill.element);
    pill.update({ visible: true, text: 'Review', tone: 'attention', loading: false });
    expect(progress.hidden).toBe(true);
    expect(pill.element.dataset.tone).toBe('attention');
});

test('hidden owners do not leave an empty host visible', () => {
    const a = make({ id: 'a' }), b = make({ id: 'b' });
    a.update({ visible: true, text: 'Desk', tone: 'error', loading: false });
    a.update({ visible: false, text: '', tone: 'running', loading: false });
    expect(a.element.parentElement.hidden).toBe(true);
    b.update({ visible: true, text: 'Cloud', tone: 'unknown', loading: false });
    expect(a.element.parentElement.hidden).toBe(false);
});

test('rapid activation remains owned across updates until the actual open promise settles', async () => {
    let release;
    let opened = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const pill = make({ onOpen: () => { opened++; return pending; } });
    pill.update({ visible: true, text: 'Open', tone: 'running', loading: true });
    pill.element.click();
    pill.element.click();
    await flush();
    expect(opened).toBe(1);
    pill.update({ visible: true, text: 'Review', tone: 'attention', loading: false });
    pill.element.click();
    await flush();
    expect(opened).toBe(1);
    release();
    await flush();
    pill.element.click();
    await flush();
    expect(opened).toBe(2);
});

test('same-turn destroy revokes queued activation before the opener starts', async () => {
    let opened = 0;
    const errors = [];
    const pill = make({ onOpen: () => { opened++; }, onError: error => errors.push(error) });
    pill.update({ visible: true, text: 'Open', tone: 'running', loading: true });
    pill.element.click();
    pill.element.click();
    pill.destroy();
    pill.element.click();
    expect(document.querySelector('.activity-pill-host')).toBeNull();
    await flush();
    expect(opened).toBe(0);
    expect(errors).toEqual([]);
    expect(document.querySelector('.activity-pill-host')).toBeNull();
    expect(document.querySelector('link[href="/css/activity-pill.css"]')).toBeNull();
});

test.each(['surviving', 'replacement'])('revoked queued activation leaves a %s owner independently usable', async ownership => {
    let opened = 0, liveOpened = 0;
    const pill = make({ id: 'disposed', onOpen: () => { opened++; } });
    const originalHost = pill.element.parentElement;
    const createLive = () => make({ id: 'live', onOpen: () => { liveOpened++; } });
    let live = ownership === 'surviving' ? createLive() : null;
    pill.element.click();
    pill.destroy();
    if (ownership === 'replacement') live = createLive();
    live.update({ visible: true, text: 'Live', tone: 'running', loading: true });
    const host = live.element.parentElement;
    const css = document.querySelector('link[href="/css/activity-pill.css"]');
    expect(host === originalHost).toBe(ownership === 'surviving');
    await flush();
    expect(opened).toBe(0);
    expect(document.getElementById('disposed')).toBeNull();
    expect(document.querySelector('.activity-pill-host')).toBe(host);
    expect(document.querySelector('link[href="/css/activity-pill.css"]')).toBe(css);
    expect(live.element.isConnected).toBe(true);
    expect(host.hidden).toBe(false);
    live.element.click();
    await flush();
    expect(liveOpened).toBe(1);
    expect(opened).toBe(0);
});

test.each(['throw', 'reject'])('%s from activation is immediately observed and visibly reported before allowing retry', async mode => {
    const failure = new Error('Cannot open Sync: request refused');
    const errors = [];
    let opened = 0;
    const pill = make({ onOpen: () => { opened++; if (mode === 'throw') throw failure; return Promise.reject(failure); }, onError: error => errors.push(error) });
    pill.element.click();
    await flush();
    expect(errors).toEqual([failure]);
    pill.element.click();
    await flush();
    expect(opened).toBe(2);
});

test.each([
    ['resolve', ['closed'], []],
    ['reject', [], ['Open request failed after disposal']],
])('destroy observes an already-started async %s without revoking another owner', async (outcome, expectedCompletions, expectedErrors) => {
    let resolve, reject;
    const pending = new Promise((finish, fail) => { resolve = finish; reject = fail; });
    const errors = [];
    const completions = [];
    let opened = 0;
    const pill = make({ onOpen: async () => { opened++; completions.push(await pending); }, onError: error => errors.push(error.message) });
    pill.element.click();
    await flush();
    expect(opened).toBe(1);
    pill.destroy();
    const live = make({ id: 'live', onOpen: () => {} });
    live.update({ visible: true, text: 'Live', tone: 'running', loading: true });
    const host = live.element.parentElement;
    const css = document.querySelector('link[href="/css/activity-pill.css"]');
    pill.element.click();
    if (outcome === 'resolve') resolve('closed');
    else reject(new Error('Open request failed after disposal'));
    await flush();
    expect(opened).toBe(1);
    expect(completions).toEqual(expectedCompletions);
    expect(errors).toEqual(expectedErrors);
    expect(pill.element.isConnected).toBe(false);
    expect(document.querySelector('.activity-pill-host')).toBe(host);
    expect(document.querySelector('link[href="/css/activity-pill.css"]')).toBe(css);
    expect(live.element.isConnected).toBe(true);
    expect(document.querySelectorAll('.activity-pill-host')).toHaveLength(1);
});

test('detail text is decorative and hidden when empty', () => {
    const pill = make();
    pill.update({ visible: true, text: 'Syncing: Cloud', tone: 'running', loading: true, detail: '0:42' });
    const meta = pill.element.querySelector('.activity-pill-meta');
    expect(meta.hidden).toBe(false);
    expect(meta.textContent).toBe('0:42');
    expect(meta.getAttribute('aria-hidden')).toBe('true');
    expect(pill.element.getAttribute('aria-label')).toBe('Syncing: Cloud');
    pill.update({ visible: true, text: 'Review', tone: 'attention', loading: false });
    expect(meta.hidden).toBe(true);
    expect(meta.textContent).toBe('');
});
