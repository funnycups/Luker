/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { applyComposerDraftLayout, refreshComposerDraftLayout } from '../public/scripts/composer-draft-layout.js';

describe('composer-draft-layout lifecycle', () => {
    let origResizeObserver;
    let origRaf;
    let origCancelRaf;
    let origGetContext;
    let observedTargets;
    let disconnectCount;
    let rafQueue;

    beforeEach(() => {
        observedTargets = [];
        disconnectCount = 0;
        rafQueue = [];
        origResizeObserver = globalThis.ResizeObserver;
        origRaf = globalThis.requestAnimationFrame;
        origCancelRaf = globalThis.cancelAnimationFrame;
        origGetContext = HTMLCanvasElement.prototype.getContext;

        globalThis.ResizeObserver = class {
            constructor(cb) { this.cb = cb; }
            observe(target) { observedTargets.push(target); }
            disconnect() { disconnectCount += 1; }
        };
        globalThis.requestAnimationFrame = (cb) => {
            rafQueue.push(cb);
            return rafQueue.length;
        };
        globalThis.cancelAnimationFrame = jest.fn();
        HTMLCanvasElement.prototype.getContext = () => ({
            font: '',
            measureText: (text) => ({ width: String(text || '').length * 10 }),
        });

        document.body.innerHTML = `
            <form id="send_form">
                <div id="nonQRFormItems" style="display:flex; flex-direction:row;">
                    <div id="leftSendForm"></div>
                    <textarea id="send_textarea"></textarea>
                    <div id="rightSendForm"></div>
                </div>
            </form>
        `;
        const row = document.getElementById('nonQRFormItems');
        row.getBoundingClientRect = () => ({ width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40 });
        document.getElementById('leftSendForm').getBoundingClientRect = () => ({ width: 40, height: 40, top: 0, left: 0, right: 40, bottom: 40 });
        document.getElementById('rightSendForm').getBoundingClientRect = () => ({ width: 40, height: 40, top: 0, left: 260, right: 300, bottom: 40 });
    });

    afterEach(() => {
        applyComposerDraftLayout(false);
        globalThis.ResizeObserver = origResizeObserver;
        globalThis.requestAnimationFrame = origRaf;
        globalThis.cancelAnimationFrame = origCancelRaf;
        HTMLCanvasElement.prototype.getContext = origGetContext;
        document.body.innerHTML = '';
    });

    test('attaches ResizeObserver to row and controls, wraps long/multiline drafts, and detaches cleanly on disable', () => {
        const onWrapChange = jest.fn();
        const form = document.getElementById('send_form');
        const input = document.getElementById('send_textarea');

        applyComposerDraftLayout(true, { onWrapChange });
        expect(observedTargets.map(el => el.id)).toEqual(['nonQRFormItems', 'leftSendForm', 'rightSendForm']);

        input.value = 'first\nsecond';
        input.dispatchEvent(new Event('input'));
        while (rafQueue.length > 0) rafQueue.shift()();

        expect(form.hasAttribute('data-composer-draft-wrap')).toBe(true);
        expect(form.getAttribute('data-composer-draft-layout')).toBe('flex');
        expect(onWrapChange).toHaveBeenLastCalledWith(true);

        // Re-enabling on the same DOM reuses the active observer without creating duplicates.
        applyComposerDraftLayout(true, { onWrapChange });
        expect(observedTargets).toHaveLength(3);
        expect(disconnectCount).toBe(0);

        refreshComposerDraftLayout();
        while (rafQueue.length > 0) rafQueue.shift()();
        expect(form.hasAttribute('data-composer-draft-wrap')).toBe(true);

        // Disabling disconnects ResizeObserver and removes layout attributes.
        applyComposerDraftLayout(false);
        expect(disconnectCount).toBe(1);
        expect(form.hasAttribute('data-composer-draft-wrap')).toBe(false);
        expect(form.hasAttribute('data-composer-draft-layout')).toBe(false);
        expect(onWrapChange).toHaveBeenLastCalledWith(false);
    });
});
