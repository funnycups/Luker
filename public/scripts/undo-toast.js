import { t } from './i18n.js';

export const DEFAULT_UNDO_TOAST_WINDOW_MS = 5000;

/**
 * Shows a short-lived toast with an Undo action.
 * If Undo is not used before the timeout, the commit callback runs.
 *
 * @param {object} options
 * @param {string} options.message
 * @param {string} [options.title]
 * @param {number} [options.timeoutMs]
 * @param {() => Promise<void>|void} [options.onUndo]
 * @param {() => Promise<void>|void} [options.onCommit]
 */
export function showUndoToast({ message, title = '', timeoutMs = DEFAULT_UNDO_TOAST_WINDOW_MS, onUndo, onCommit }) {
    let settled = false;
    let toast = null;
    let timerId = null;

    const clearToast = () => {
        if (typeof toastr !== 'undefined' && toast) {
            toastr.clear(toast);
        }
        if (toast?.remove) {
            toast.remove();
        }
        toast = null;
    };

    const settle = async (mode) => {
        if (settled) {
            return false;
        }

        settled = true;

        if (timerId) {
            clearTimeout(timerId);
            timerId = null;
        }

        clearToast();

        try {
            if (mode === 'undo') {
                await onUndo?.();
            } else {
                await onCommit?.();
            }
        } catch (error) {
            console.error(`Undo toast ${mode} callback failed`, error);
        }

        return true;
    };

    timerId = setTimeout(() => {
        void settle('commit');
    }, Math.max(0, Number(timeoutMs) || 0));

    if (typeof toastr === 'undefined') {
        return {
            undo: () => settle('undo'),
            commit: () => settle('commit'),
            isSettled: () => settled,
        };
    }

    toast = toastr.info(' ', title, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: false,
        minimizable: false,
        progressBar: false,
    });

    const toastBody = toast?.find('.toast-message');
    const toastTarget = toastBody && toastBody.length > 0 ? toastBody : toast;

    if (toastTarget && toastTarget.length > 0) {
        toastTarget.empty();

        const messageNode = jQuery('<div class="prompt-manager-toggle-undo-text"></div>');
        const undoButton = jQuery('<button type="button" class="menu_button menu_button_small prompt-manager-toggle-undo-button"></button>');

        messageNode.text(String(message || ''));
        undoButton.text(String(t`Undo`));
        undoButton.on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void settle('undo');
        });

        toastTarget.append(messageNode);
        toastTarget.append(undoButton);
    }

    return {
        undo: () => settle('undo'),
        commit: () => settle('commit'),
        isSettled: () => settled,
    };
}
