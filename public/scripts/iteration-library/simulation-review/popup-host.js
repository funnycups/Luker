// Thin wrapper over SillyTavern's popup system. Kept in its own file so
// the rest of the simulation-review module can be unit-tested under
// jsdom by mocking this single module.

import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../popup.js';

/**
 * @param {{
 *   title: string,
 *   contentRoot: HTMLElement,
 *   onSubmit: () => Promise<any> | any,
 *   onCancel: () => Promise<any> | any,
 *   i18n: (key: string, fallback?: string) => string,
 *   abortSignal?: AbortSignal,
 * }} args
 */
export async function openHostPopup({ title, contentRoot, onSubmit, onCancel, i18n, abortSignal }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'luker-sim-review-wrapper';
    const titleEl = document.createElement('h1');
    titleEl.className = 'luker-sim-review-title';
    titleEl.textContent = title;
    wrapper.appendChild(titleEl);
    wrapper.appendChild(contentRoot);
    const popup = new Popup(wrapper, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: i18n('sim.action.submit', 'Submit'),
        cancelButton: i18n('sim.action.cancel', 'Cancel'),
    });
    let abortHandler = null;
    if (abortSignal) {
        abortHandler = () => {
            try {
                popup.complete(POPUP_RESULT.CANCELLED);
            } catch (err) {
                console.warn('[simulation-review/popup-host] abort-close failed', err);
            }
        };
        if (abortSignal.aborted) {
            // Schedule close after show() registers its promise; otherwise the
            // dialog renders momentarily before close.
            queueMicrotask(abortHandler);
        } else {
            abortSignal.addEventListener('abort', abortHandler, { once: true });
        }
    }
    try {
        const ack = await popup.show();
        if (ack === POPUP_RESULT.AFFIRMATIVE) {
            return onSubmit();
        }
        return onCancel();
    } finally {
        if (abortHandler && abortSignal && !abortSignal.aborted) {
            abortSignal.removeEventListener('abort', abortHandler);
        }
    }
}
