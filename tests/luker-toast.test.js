/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

import {
    createToastEngine,
    toastr as defaultToastr,
} from '../public/scripts/luker-toast.js';

let engine;
let toastr;
let refreshToastLayout;
let setToastTranslator;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadRealJQuery() {
    const jqSource = fs.readFileSync(
        path.resolve(__dirname, '../public/lib/jquery-3.5.1.min.js'),
        'utf8',
    );
    const factory = new Function('window', 'document', jqSource);
    factory.call(window, window, document);
    globalThis.jQuery = window.jQuery;
    globalThis.$ = window.$;
}

function makePointerEvent(type, { clientX = 0, clientY = 0, button = 0, pointerId = 1, pointerType = 'mouse' } = {}) {
    const EventCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
    const ev = new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button,
    });
    if (!('pointerId' in ev)) {
        Object.defineProperty(ev, 'pointerId', { value: pointerId });
    }
    if (!('pointerType' in ev)) {
        Object.defineProperty(ev, 'pointerType', { value: pointerType });
    }
    return ev;
}

function setRect(el, { left = 0, top = 0, width = 320, height = 64 } = {}) {
    const rect = {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
    };
    el.getBoundingClientRect = () => rect;
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
    return rect;
}

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}

beforeAll(() => {
    loadRealJQuery();
});

beforeEach(() => {
    engine = createToastEngine();
    toastr = engine.toastr;
    refreshToastLayout = engine.refreshLayout;
    setToastTranslator = engine.setTranslator;
    document.body.innerHTML = '';
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    toastr.options = {
        positionClass: 'toast-top-center',
        closeButton: false,
        progressBar: false,
        showDuration: 0,
        hideDuration: 0,
        timeOut: 4000,
        extendedTimeOut: 10000,
        escapeHtml: true,
        newestOnTop: true,
        tapToDismiss: true,
        closeOnHover: true,
    };
});

afterEach(() => {
    jest.useRealTimers();
    engine?.reset();
    engine = null;
    document.body.innerHTML = '';
});

describe('drop-in window.toastr API compatibility', () => {
    test('installs globalThis.toastr and renders info/success/warning/error with jQuery handles', () => {
        expect(globalThis.toastr).toBe(defaultToastr);
        expect(typeof toastr.version).toBe('string');

        const events = [];
        toastr.subscribe((args) => events.push(args));
        const onShown = jest.fn();

        const $info = toastr.info('Hello world', 'Notice', { onShown });
        const $success = toastr.success('Saved');
        const $warning = toastr.warning('Careful');
        const $error = toastr.error('Broken');

        expect($info instanceof window.jQuery).toBe(true);
        expect($info.hasClass('toast')).toBe(true);
        expect($info.hasClass('toast-info')).toBe(true);
        expect($info.attr('role')).toBe('status');
        expect($info.find('.toast-title').text()).toBe('Notice');
        expect($info.find('.toast-message').text()).toBe('Hello world');

        expect($success.hasClass('toast-success')).toBe(true);
        expect($warning.hasClass('toast-warning')).toBe(true);
        expect($error.hasClass('toast-error')).toBe(true);

        expect(onShown).toHaveBeenCalledTimes(1);
        expect(events.filter(e => e.state === 'visible')).toHaveLength(4);
    });

    test('honors escapeHtml true/false and appends live DOM Node or jQuery message without stringifying', () => {
        const $escaped = toastr.info('<b>Safe</b><script>bad()</script>', '<i>Title</i>', { escapeHtml: true });
        expect($escaped.find('.toast-message b')).toHaveLength(0);
        expect($escaped.find('.toast-message').text()).toBe('<b>Safe</b><script>bad()</script>');
        expect($escaped.find('.toast-title i')).toHaveLength(0);

        const $html = toastr.info('<strong class="rich">Bold</strong>', '', { escapeHtml: false });
        expect($html.find('.toast-message strong.rich').text()).toBe('Bold');

        const customNode = document.createElement('div');
        customNode.className = 'action-loader-toast';
        const span = document.createElement('span');
        span.textContent = 'Live node';
        customNode.appendChild(span);

        const $fromJq = toastr.info(window.$(customNode), 'Loader', { escapeHtml: false, timeOut: 0, tapToDismiss: false });
        expect($fromJq.find('.toast-message .action-loader-toast')[0]).toBe(customNode);
        expect($fromJq.find('.toast-message').text()).toContain('Live node');
        expect($fromJq.find('.toast-message').text()).not.toContain('[object Object]');
    });

    test('suppresses duplicates across docked, detached, and minimized states when preventDuplicates is true', () => {
        const $first = toastr.error('Disk full', 'Storage', { timeOut: 0, preventDuplicates: true });
        expect($first).toBeDefined();

        // Duplicate while docked
        expect(toastr.error('Disk full', 'Storage', { timeOut: 0, preventDuplicates: true })).toBeUndefined();

        // Minimize first toast; duplicate must still be suppressed
        $first.find('.luker-toast-minimize-button')[0].click();
        expect($first.attr('data-toast-state')).toBe('minimized');
        expect(toastr.error('Disk full', 'Storage', { timeOut: 0, preventDuplicates: true })).toBeUndefined();

        // Clear first toast; now re-creating is allowed
        toastr.clear($first);
        const $again = toastr.error('Disk full', 'Storage', { timeOut: 0, preventDuplicates: true });
        expect($again).toBeDefined();
        expect($again.length).toBe(1);
    });

    test('respects newestOnTop ordering in the docked stack', () => {
        toastr.options.newestOnTop = true;
        const $a = toastr.info('First');
        const $b = toastr.info('Second');
        expect(Number($b.attr('data-stack-index'))).toBe(0);
        expect(Number($a.attr('data-stack-index'))).toBe(1);

        toastr.remove();
        toastr.options.newestOnTop = false;
        const $c = toastr.info('Third');
        const $d = toastr.info('Fourth');
        expect(Number($c.attr('data-stack-index'))).toBe(0);
        expect(Number($d.attr('data-stack-index'))).toBe(1);
    });

    test('auto-dismisses timed toasts, pauses on hover, and ignores inherited extendedTimeOut for timeOut: 0', () => {
        jest.useFakeTimers();

        const onHidden = jest.fn();
        const $timed = toastr.info('Auto hide', '', { timeOut: 3000, extendedTimeOut: 2000, onHidden });

        jest.advanceTimersByTime(1500);
        expect(document.body.contains($timed[0])).toBe(true);

        // Hover pauses timer
        $timed[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        jest.advanceTimersByTime(5000);
        expect(document.body.contains($timed[0])).toBe(true);

        // Mouse leave restarts with extendedTimeOut (2000ms)
        $timed[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
        jest.advanceTimersByTime(1999);
        expect(document.body.contains($timed[0])).toBe(true);
        jest.advanceTimersByTime(5);
        expect(document.body.contains($timed[0])).toBe(false);
        expect(onHidden).toHaveBeenCalledTimes(1);

        // timeOut: 0 inheriting global extendedTimeOut (10000) must stay persistent after hover
        const $sticky = toastr.warning('Stay forever', '', { timeOut: 0 });
        $sticky[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        $sticky[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
        jest.advanceTimersByTime(60000);
        expect(document.body.contains($sticky[0])).toBe(true);

        // Explicit timeOut: 0 + extendedTimeOut: 2500 dismisses after hover leave
        toastr.clear($sticky);
        const $explicit = toastr.info('Hover dismiss', '', { timeOut: 0, extendedTimeOut: 2500 });
        $explicit[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        $explicit[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
        jest.advanceTimersByTime(2505);
        expect(document.body.contains($explicit[0])).toBe(false);
    });

    test('mounts #toast-container inside the topmost open non-closing dialog when created', () => {
        const dlg = document.createElement('dialog');
        dlg.setAttribute('open', '');
        document.body.appendChild(dlg);

        const $toast = toastr.info('Inside modal');
        const container = document.getElementById('toast-container');
        expect(dlg.contains(container)).toBe(true);
        expect(container.contains($toast[0])).toBe(true);
    });

    test('clear() never blocks on hover, toast chrome focus, or ongoing tasks, only on caller form inputs in closable toasts', () => {
        // 1. Ongoing task with focused minimize button and focused capsule clears without { force: true }
        const $task = toastr.info('Running job', '', { timeOut: 0, tapToDismiss: false });
        const minBtn = $task.find('.luker-toast-minimize-button')[0];
        minBtn.focus();
        $task[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        minBtn.click();
        const capsule = $task.find('.luker-toast-capsule')[0];
        capsule.focus();
        toastr.clear($task);
        expect(document.body.contains($task[0])).toBe(false);

        // 2. Ongoing task with a caller input focused STILL clears without { force: true }
        const $taskWithInput = toastr.info('<input class="task-input" />', '', { timeOut: 0, tapToDismiss: false, escapeHtml: false });
        $taskWithInput.find('.task-input')[0].focus();
        toastr.clear($taskWithInput);
        expect(document.body.contains($taskWithInput[0])).toBe(false);

        // 3. Closable toast with caller input focused defers clear() unless { force: true }
        const $closableInput = toastr.info('<input class="user-input" />', '', { timeOut: 0, tapToDismiss: true, escapeHtml: false });
        $closableInput.find('.user-input')[0].focus();
        toastr.clear($closableInput);
        expect(document.body.contains($closableInput[0])).toBe(true);
        toastr.clear($closableInput, { force: true });
        expect(document.body.contains($closableInput[0])).toBe(false);
    });
});

describe('closability and minimizability DOM chrome', () => {
    test('renders correct controls for timed, ongoing task, sticky error, and PromptManager undo toasts', () => {
        const $timed = toastr.info('Quick info');
        expect($timed.find('.toast-close-button')).toHaveLength(1);
        expect($timed.find('.luker-toast-minimize-button')).toHaveLength(0);
        expect($timed.hasClass('interactable')).toBe(true);

        const $task = toastr.info('Indexing...', '', { timeOut: 0, tapToDismiss: false });
        expect($task.find('.toast-close-button')).toHaveLength(0);
        expect($task.find('.luker-toast-minimize-button')).toHaveLength(1);
        expect($task.find('.luker-toast-surface .luker-toast-task-spinner')).toHaveLength(1);
        expect($task.find('.luker-toast-capsule .luker-toast-task-spinner')).toHaveLength(1);
        expect($task.hasClass('toast-non-interactable')).toBe(true);
        // Clicking body does NOT dismiss ongoing task
        $task.find('.toast-message')[0].click();
        expect(document.body.contains($task[0])).toBe(true);

        const $stickyErr = toastr.error('Generation failed', 'Image', { timeOut: 0, tapToDismiss: true, closeButton: true });
        expect($stickyErr.find('.toast-close-button')).toHaveLength(1);
        expect($stickyErr.find('.luker-toast-minimize-button')).toHaveLength(1);

        const onCloseClick = jest.fn();
        const $pmUndo = toastr.info('2 prompts toggled', '', { timeOut: 0, tapToDismiss: false, closeButton: true, onCloseClick });
        expect($pmUndo.find('.toast-close-button')).toHaveLength(1);
        expect($pmUndo.find('.luker-toast-minimize-button')).toHaveLength(1);
        // Tapping body does NOT dismiss
        $pmUndo.find('.toast-message')[0].click();
        expect(document.body.contains($pmUndo[0])).toBe(true);
        // Clicking close button dismisses and fires onCloseClick
        $pmUndo.find('.toast-close-button')[0].click();
        expect(onCloseClick).toHaveBeenCalledTimes(1);
        expect(document.body.contains($pmUndo[0])).toBe(false);
    });
});

describe('per-toast drag, click separation, and capsule state machine', () => {
    test('dragging >= 6px detaches toast clamped inside viewport and suppresses follow-up click/onclick', () => {
        const onclick = jest.fn();
        const $toast = toastr.info('Draggable toast', '', { timeOut: 4000, tapToDismiss: true, onclick });
        const el = $toast[0];
        setRect(el, { left: 440, top: 60, width: 320, height: 64 });

        el.dispatchEvent(makePointerEvent('pointerdown', { clientX: 500, clientY: 80 }));
        el.dispatchEvent(makePointerEvent('pointermove', { clientX: 503, clientY: 82 })); // < 6px
        expect(el.getAttribute('data-toast-state')).toBe('docked');

        el.dispatchEvent(makePointerEvent('pointermove', { clientX: 620, clientY: 220 })); // >= 6px
        expect(el.getAttribute('data-toast-state')).toBe('detached');
        expect(el.classList.contains('luker-toast-dragging')).toBe(true);

        el.dispatchEvent(makePointerEvent('pointerup', { clientX: 620, clientY: 220 }));
        expect(el.classList.contains('luker-toast-dragging')).toBe(false);

        // Browser emits synthetic click immediately after pointerup — must be suppressed!
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(document.body.contains(el)).toBe(true);
        expect(onclick).not.toHaveBeenCalled();

        // Subsequent real tap (without dragging) dismisses normally and triggers onclick
        el.dispatchEvent(makePointerEvent('pointerdown', { clientX: 620, clientY: 220 }));
        el.dispatchEvent(makePointerEvent('pointerup', { clientX: 621, clientY: 220 }));
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(onclick).toHaveBeenCalledTimes(1);
        expect(document.body.contains(el)).toBe(false);
    });

    test('pointerdown on interactive child button does not initiate drag', () => {
        const $task = toastr.info('Running', '', { timeOut: 0, tapToDismiss: false });
        const el = $task[0];
        setRect(el, { left: 440, top: 60, width: 320, height: 64 });
        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'luker-toast-stop-button';
        stopBtn.textContent = 'Stop';
        $task.find('.toast-message')[0].appendChild(stopBtn);

        stopBtn.dispatchEvent(makePointerEvent('pointerdown', { clientX: 500, clientY: 80 }));
        stopBtn.dispatchEvent(makePointerEvent('pointermove', { clientX: 650, clientY: 250 }));
        stopBtn.dispatchEvent(makePointerEvent('pointerup', { clientX: 650, clientY: 250 }));
        expect(el.getAttribute('data-toast-state')).toBe('docked');
    });

    test('minimizes docked task to parking corner, preserves button listeners, restores to dock, and detaches when capsule is dragged', () => {
        const onStop = jest.fn();
        const $task = toastr.info('Extracting...', 'Memory Graph', { timeOut: 0, tapToDismiss: false });
        const el = $task[0];
        setRect(el, { left: 440, top: 60, width: 320, height: 70 });

        const stopBtn = document.createElement('button');
        stopBtn.type = 'button';
        stopBtn.className = 'luker-toast-stop-button';
        stopBtn.textContent = 'Stop';
        stopBtn.addEventListener('click', onStop);
        $task.find('.toast-message')[0].appendChild(stopBtn);

        // Minimize from top-center dock -> parks at right corner
        $task.find('.luker-toast-minimize-button')[0].click();
        expect(el.getAttribute('data-toast-state')).toBe('minimized');
        expect(el.classList.contains('luker-toast-minimized')).toBe(true);
        expect($task.find('.luker-toast-capsule-label').text()).toBe('Extracting...');
        const parkedLeft = parseFloat(el.style.left);
        expect(parkedLeft).toBeGreaterThan(700);

        // Click capsule (no drag) -> restores back to docked
        const capsule = $task.find('.luker-toast-capsule')[0];
        capsule.click();
        expect(el.getAttribute('data-toast-state')).toBe('docked');
        expect(el.classList.contains('luker-toast-minimized')).toBe(false);

        // Minimize again and drag capsule to custom position -> does NOT expand on drop
        $task.find('.luker-toast-minimize-button')[0].click();
        setRect(el, { left: 1000, top: 60, width: 180, height: 32 });
        capsule.dispatchEvent(makePointerEvent('pointerdown', { clientX: 1050, clientY: 75 }));
        capsule.dispatchEvent(makePointerEvent('pointermove', { clientX: 250, clientY: 320 }));
        capsule.dispatchEvent(makePointerEvent('pointerup', { clientX: 250, clientY: 320 }));
        capsule.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(el.getAttribute('data-toast-state')).toBe('minimized');

        // Next click on dragged capsule expands in place as detached
        capsule.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(el.getAttribute('data-toast-state')).toBe('detached');

        // Original Stop button listener still works on the same live DOM node
        stopBtn.click();
        expect(onStop).toHaveBeenCalledTimes(1);

        // Minimizing a detached toast keeps it detached when expanded again
        setRect(el, { left: 200, top: 300, width: 320, height: 70 });
        $task.find('.luker-toast-minimize-button')[0].click();
        expect(el.getAttribute('data-toast-state')).toBe('minimized');
        capsule.click();
        expect(el.getAttribute('data-toast-state')).toBe('detached');
    });

    test('parks dock-origin capsule on left corner when positionClass is toast-top-right', () => {
        toastr.options.positionClass = 'toast-top-right';
        const $task = toastr.info('Right dock task', '', { timeOut: 0, tapToDismiss: false });
        setRect($task[0], { left: 860, top: 60, width: 320, height: 64 });

        $task.find('.luker-toast-minimize-button')[0].click();
        expect(parseFloat($task[0].style.left)).toBe(12);
    });
});

describe('live capsule sync, deck stacking, i18n, and external DOM removal', () => {
    test('live-syncs nested .toast-message mutations to capsule label while ignoring button text', async () => {
        const $task = toastr.info(' ', '', { timeOut: 0, tapToDismiss: false });
        const body = $task.find('.toast-message');
        body.empty();
        const textNode = window.$('<div class="luker-rpg-memory-toast-text">Initial pass</div>');
        const stopBtn = window.$('<button type="button" class="luker-toast-stop-button">Stop</button>');
        body.append(textNode, stopBtn);

        $task.find('.luker-toast-minimize-button')[0].click();
        expect($task.find('.luker-toast-capsule-label').text()).toBe('Initial pass');

        textNode.text('Processing batch 2/3');
        await flushMicrotasks();
        expect($task.find('.luker-toast-capsule-label').text()).toBe('Processing batch 2/3');
    });

    test('renders stack badge for 3 docked toasts, allows front-click dismiss, and leaves empty container on removal', async () => {
        setToastTranslator((key) => ({
            'Expand notifications': '展开全部通知',
            'Collapse notifications': '收起通知',
            'Minimize notification': '最小化通知',
            'Close notification': '关闭通知',
            'Restore notification': '展开通知',
            'Tap to close': '点击关闭',
        }[key] || key));

        const $t1 = toastr.info('One');
        const $t2 = toastr.info('Two');
        const $t3 = toastr.info('Three');

        const container = document.getElementById('toast-container');
        expect(container.getAttribute('data-deck-expanded')).toBe('false');
        const badge = container.querySelector('.luker-toast-stack-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toContain('+2');
        expect(badge.getAttribute('title')).toBe('展开全部通知');
        expect($t3.find('.toast-close-button').attr('title')).toBe('关闭通知');

        // Clicking badge pins expanded mode
        badge.click();
        expect(container.getAttribute('data-deck-expanded')).toBe('true');
        expect(badge.getAttribute('title')).toBe('收起通知');

        // Clicking badge again collapses
        badge.click();
        expect(container.getAttribute('data-deck-expanded')).toBe('false');

        // Clicking front dismissible toast while collapsed dismisses it directly
        $t3[0].click();
        expect(document.body.contains($t3[0])).toBe(false);
        expect(container.querySelector('.luker-toast-stack-badge')?.textContent).toContain('+1');

        // External DOM .remove() cleans up remaining toasts and unmounts stack badge
        $t2.remove();
        $t1.remove();
        await flushMicrotasks();
        refreshToastLayout();
        expect(container.querySelector('.luker-toast-stack-badge')).toBeNull();
        expect(container.childNodes.length).toBe(0);
    });
});

describe('final review regression fixes', () => {
    test('dragging a toast out of a hovered expanded deck clears deckHovered and resumes timers on remaining docked toasts', () => {
        jest.useFakeTimers();

        const $t1 = toastr.info('Docked 1', '', { timeOut: 3000, extendedTimeOut: 1500 });
        const $t2 = toastr.info('Docked 2', '', { timeOut: 3000, extendedTimeOut: 1500 });
        const $t3 = toastr.info('Docked 3', '', { timeOut: 3000, extendedTimeOut: 1500 });
        const container = document.getElementById('toast-container');

        setRect($t3[0], { left: 440, top: 60, width: 320, height: 64 });
        $t3[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        expect(container.getAttribute('data-deck-expanded')).toBe('true');

        // Drag front toast away from dock and drop it elsewhere
        $t3[0].dispatchEvent(makePointerEvent('pointerdown', { clientX: 500, clientY: 80 }));
        $t3[0].dispatchEvent(makePointerEvent('pointermove', { clientX: 160, clientY: 300 }));
        $t3[0].dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: true }));
        $t3[0].dispatchEvent(makePointerEvent('pointerup', { clientX: 160, clientY: 300 }));

        expect($t3.attr('data-toast-state')).toBe('detached');
        expect(container.getAttribute('data-deck-expanded')).toBe('false');

        // Remaining docked toasts must resume their auto-dismiss timers instead of staying frozen
        jest.advanceTimersByTime(1600);
        expect(document.body.contains($t1[0])).toBe(false);
        expect(document.body.contains($t2[0])).toBe(false);
    });

    test('ignores touch-emulated mouseenter so mobile tap on behind-card expands deck and tap on front card does not freeze deck open', () => {
        const $t1 = toastr.info('Behind card', '', { timeOut: 60000 });
        const $t2 = toastr.info('Middle card', '', { timeOut: 60000 });
        const $t3 = toastr.info('Front card', '', { timeOut: 60000 });
        const container = document.getElementById('toast-container');

        // Simulate mobile Chromium touch sequence on behind card: pointerdown(touch) -> pointerup(touch) -> compatibility mouseenter -> click
        $t2[0].dispatchEvent(makePointerEvent('pointerdown', { clientX: 500, clientY: 95, pointerType: 'touch' }));
        $t2[0].dispatchEvent(makePointerEvent('pointerup', { clientX: 500, clientY: 95, pointerType: 'touch' }));
        $t2[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        $t2[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

        // Must pin expanded instead of dismissing behind card
        expect(document.body.contains($t2[0])).toBe(true);
        expect(container.getAttribute('data-deck-expanded')).toBe('true');

        // Collapse via badge, then simulate mobile tap on front card
        container.querySelector('.luker-toast-stack-badge').click();
        expect(container.getAttribute('data-deck-expanded')).toBe('false');

        $t3[0].dispatchEvent(makePointerEvent('pointerdown', { clientX: 500, clientY: 70, pointerType: 'touch' }));
        $t3[0].dispatchEvent(makePointerEvent('pointerup', { clientX: 500, clientY: 70, pointerType: 'touch' }));
        $t3[0].dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
        $t3[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(document.body.contains($t3[0])).toBe(false);
        expect(document.body.contains($t1[0])).toBe(true);
        expect(container.getAttribute('data-deck-expanded')).toBe('false');
    });

    test('measures unclipped surfaceEl.offsetHeight when expanding a deck with a tall behind-card', () => {
        const $tall = toastr.info('Tall multi-line content with controls', '', { timeOut: 60000 });
        const $short = toastr.info('Short front', '', { timeOut: 60000 });
        const $oldest = toastr.info('Third card', '', { timeOut: 60000 });
        const container = document.getElementById('toast-container');

        // While collapsed, $tall's outer el is clipped/scaled to ~52px, while its inner surfaceEl is 140px
        setRect($short[0], { left: 440, top: 60, width: 320, height: 56 });
        Object.defineProperty($short[0].querySelector('.luker-toast-surface'), 'offsetHeight', { configurable: true, value: 56 });

        setRect($tall[0], { left: 440, top: 70, width: 304, height: 52 });
        Object.defineProperty($tall[0].querySelector('.luker-toast-surface'), 'offsetHeight', { configurable: true, value: 140 });

        setRect($oldest[0], { left: 440, top: 80, width: 288, height: 48 });
        Object.defineProperty($oldest[0].querySelector('.luker-toast-surface'), 'offsetHeight', { configurable: true, value: 60 });

        container.querySelector('.luker-toast-stack-badge').click();
        expect(container.getAttribute('data-deck-expanded')).toBe('true');

        // In newestOnTop order: index 0 = $oldest (60), index 1 = $short (56), index 2 = $tall (140)
        // Badge offset must account for full unclipped heights (60 + 8 + 56 + 8 + 140 = 272 -> badge >= 272)
        const badgeOffset = parseFloat(container.querySelector('.luker-toast-stack-badge').style.getPropertyValue('--deck-badge-offset-y'));
        expect(badgeOffset).toBeGreaterThanOrEqual(272);
    });

    test('holds timed toast open while caller input is focused, ignores clicks on input, and resumes hide on blur', async () => {
        jest.useFakeTimers();

        const $toast = toastr.info('<input class="edit-box" />', '', {
            timeOut: 1000,
            extendedTimeOut: 500,
            tapToDismiss: true,
            escapeHtml: false,
        });
        const input = $toast.find('.edit-box')[0];
        input.focus();
        input.click();
        expect(document.body.contains($toast[0])).toBe(true);

        // Timer expiry must defer while caller input stays focused
        jest.advanceTimersByTime(1200);
        expect(document.body.contains($toast[0])).toBe(true);

        // Blurring input schedules dismissal after extendedTimeOut
        input.blur();
        $toast[0].dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
        await flushMicrotasks();
        jest.advanceTimersByTime(600);
        expect(document.body.contains($toast[0])).toBe(false);
    });

    test('honors custom optionsOverride.iconClass and space-separated iconClass/positionClass without DOMException', () => {
        const $toast = toastr.info('Multi-class', '', {
            iconClass: 'custom-toast-icon extra-badge',
            positionClass: 'toast-top-right custom-pos-extra',
        });
        expect($toast.hasClass('custom-toast-icon')).toBe(true);
        expect($toast.hasClass('extra-badge')).toBe(true);
        expect($toast.hasClass('toast-info')).toBe(false);
        const container = document.getElementById('toast-container');
        expect(container.classList.contains('toast-top-right')).toBe(true);
        expect(container.classList.contains('custom-pos-extra')).toBe(true);
    });

    test('removes empty #toast-container after last toast closes even when onHidden is overridden', () => {
        const onHidden = jest.fn();
        const $toast = toastr.info('Custom hidden', '', { onHidden });
        expect(document.getElementById('toast-container')).not.toBeNull();

        toastr.clear($toast);
        expect(onHidden).toHaveBeenCalledTimes(1);
        expect(document.getElementById('toast-container')).toBeNull();
    });

    test('second pointerdown cancels an active drag on a prior toast instead of stranding dragging state', () => {
        const $t1 = toastr.info('First draggable', '', { timeOut: 60000 });
        const $t2 = toastr.info('Second draggable', '', { timeOut: 60000 });
        setRect($t1[0], { left: 200, top: 80, width: 320, height: 64 });
        setRect($t2[0], { left: 200, top: 160, width: 320, height: 64 });

        $t1[0].dispatchEvent(makePointerEvent('pointerdown', { clientX: 250, clientY: 100, pointerId: 1 }));
        $t1[0].dispatchEvent(makePointerEvent('pointermove', { clientX: 350, clientY: 200, pointerId: 1 }));
        expect($t1[0].classList.contains('luker-toast-dragging')).toBe(true);

        // Second touch begins dragging $t2 without pointerup on $t1
        $t2[0].dispatchEvent(makePointerEvent('pointerdown', { clientX: 250, clientY: 180, pointerId: 2 }));
        expect($t1[0].classList.contains('luker-toast-dragging')).toBe(false);
    });

    test('marks 4th+ collapsed docked cards with data-stack-hidden and clears it on expand or detach', () => {
        const $t1 = toastr.info('Oldest 1', '', { timeOut: 60000 });
        toastr.info('Card 2', '', { timeOut: 60000 });
        toastr.info('Card 3', '', { timeOut: 60000 });
        const $t4 = toastr.info('Front 4', '', { timeOut: 60000 });
        const container = document.getElementById('toast-container');

        expect($t4[0].getAttribute('data-stack-hidden')).toBeNull();
        expect($t1[0].getAttribute('data-stack-hidden')).toBe('true');

        container.querySelector('.luker-toast-stack-badge').click();
        expect($t1[0].getAttribute('data-stack-hidden')).toBeNull();

        container.querySelector('.luker-toast-stack-badge').click();
        expect($t1[0].getAttribute('data-stack-hidden')).toBe('true');
    });

    test('measureDockedHeight accounts for outer .toast padding and border when padding lives on .toast', () => {
        const $a = toastr.info('Card A', '', { timeOut: 60000 });
        const $b = toastr.info('Card B', '', { timeOut: 60000 });
        const container = document.getElementById('toast-container');

        $a[0].style.paddingTop = '10px';
        $a[0].style.paddingBottom = '10px';
        $a[0].style.borderTopWidth = '1px';
        $a[0].style.borderBottomWidth = '1px';
        setRect($a[0], { left: 440, top: 60, width: 320, height: 62 });
        Object.defineProperty($a[0].querySelector('.luker-toast-surface'), 'offsetHeight', { configurable: true, value: 40 });

        $b[0].style.paddingTop = '10px';
        $b[0].style.paddingBottom = '10px';
        $b[0].style.borderTopWidth = '1px';
        $b[0].style.borderBottomWidth = '1px';
        setRect($b[0], { left: 440, top: 60, width: 320, height: 82 });
        Object.defineProperty($b[0].querySelector('.luker-toast-surface'), 'offsetHeight', { configurable: true, value: 60 });

        container.querySelector('.luker-toast-stack-badge').click();
        const badgeOffset = parseFloat(container.querySelector('.luker-toast-stack-badge').style.getPropertyValue('--deck-badge-offset-y'));
        // 82 + 8 + 62 = 152 (includes outer padding+border, not just inner 60+40)
        expect(badgeOffset).toBeGreaterThanOrEqual(152);
    });
});


