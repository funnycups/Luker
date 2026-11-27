/**
 * @jest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mountLukerWindow;
let showUndoToast;
let toastr;

beforeAll(async () => {
    const jqSource = fs.readFileSync(
        path.resolve(__dirname, '../public/lib/jquery-3.5.1.min.js'),
        'utf8',
    );
    new Function('window', 'document', jqSource).call(window, window, document);
    globalThis.jQuery = window.jQuery;
    globalThis.$ = window.$;

    // JSDOM does not natively implement HTMLDialogElement.prototype.showModal/close.
    if (!HTMLDialogElement.prototype.showModal) {
        HTMLDialogElement.prototype.showModal = function () {
            this.setAttribute('open', '');
        };
    }
    if (!HTMLDialogElement.prototype.close) {
        HTMLDialogElement.prototype.close = function () {
            this.removeAttribute('open');
        };
    }

    const toastMod = await import('../public/scripts/luker-toast.js');
    toastr = toastMod.toastr;

    const winMod = await import('../public/scripts/luker-window.js');
    mountLukerWindow = winMod.mountLukerWindow;

    const undoMod = await import('../public/scripts/undo-toast.js');
    showUndoToast = undoMod.showUndoToast;
});

beforeEach(() => {
    toastr.remove();
    toastr.options = {
        positionClass: 'toast-top-center',
        hideDuration: 0,
        timeOut: 4000,
        extendedTimeOut: 10000,
        escapeHtml: true,
    };
});

afterEach(() => {
    toastr.remove();
    document.querySelectorAll('dialog.dw-layer').forEach(el => el.remove());
});

describe('luker-window.js top-layer toast reparenting', () => {
    test('lifts active minimized persistent toast into dialog.dw-layer on open and rescues it before layer.remove() on close', () => {
        const $task = toastr.info('Background sync running', 'Sync', { timeOut: 0, tapToDismiss: false });
        $task.find('.luker-toast-minimize-button')[0].click();
        expect($task.attr('data-toast-state')).toBe('minimized');

        const container = document.getElementById('toast-container');
        expect(container.parentElement).toBe(document.body);

        const handle = mountLukerWindow({
            label: 'Account',
            create: () => ({
                root: document.createElement('div'),
                render: () => {},
                destroy: () => {},
                busyJob: null,
                confirm: async () => true,
            }),
        });

        const dialog = document.querySelector('dialog.dw-layer[open]');
        expect(dialog).not.toBeNull();
        expect(dialog.contains(container)).toBe(true);
        expect(dialog.contains($task[0])).toBe(true);

        handle.close();

        // Closing dialog.dw-layer must rescue #toast-container back to document.body
        // instead of destroying active toasts when layer.remove() executes.
        expect(document.querySelector('dialog.dw-layer')).toBeNull();
        expect(document.body.contains(container)).toBe(true);
        expect(container.parentElement).toBe(document.body);
        expect(document.body.contains($task[0])).toBe(true);
        expect($task.attr('data-toast-state')).toBe('minimized');
    });
});

describe('showUndoToast integration with modern toast engine', () => {
    test('renders without minimize or close buttons and settles cleanly on Undo click', async () => {
        const onUndo = jest.fn();
        const onCommit = jest.fn();
        const handle = showUndoToast({
            message: 'Deleted item',
            timeoutMs: 5000,
            onUndo,
            onCommit,
        });

        const toastEl = document.querySelector('#toast-container .toast');
        expect(toastEl).not.toBeNull();
        expect(toastEl.querySelectorAll('.luker-toast-minimize-button')).toHaveLength(0);
        expect(toastEl.querySelectorAll('.toast-close-button')).toHaveLength(0);

        const undoBtn = toastEl.querySelector('.prompt-manager-toggle-undo-button');
        expect(undoBtn).not.toBeNull();
        undoBtn.click();
        await Promise.resolve();
        await Promise.resolve();

        expect(onUndo).toHaveBeenCalledTimes(1);
        expect(onCommit).not.toHaveBeenCalled();
        expect(handle.isSettled()).toBe(true);
        expect(document.querySelector('#toast-container .toast')).toBeNull();
    });
});

