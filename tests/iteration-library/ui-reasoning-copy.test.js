/**
 * @jest-environment jsdom
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ensureUiStylesheetInjected } from '../../public/scripts/iteration-library/ui/styles.js';

describe('reasoning copy interaction', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('copies the reasoning body text when the copy button is clicked', () => {
        ensureUiStylesheetInjected();
        const writeText = jest.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        document.body.innerHTML = `
            <details class="luker_lib_reasoning_details" open>
                <summary><button type="button" data-luker-lib-copy-reasoning></button></summary>
                <div class="luker_lib_reasoning_body">hello reasoning</div>
            </details>`;
        document.querySelector('[data-luker-lib-copy-reasoning]').click();
        expect(writeText).toHaveBeenCalledWith('hello reasoning');
    });

    it('does nothing when the clicked element is not a copy button', () => {
        ensureUiStylesheetInjected();
        const writeText = jest.fn(() => Promise.resolve());
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        document.body.innerHTML = '<div class="luker_lib_reasoning_body">x</div>';
        document.body.click();
        expect(writeText).not.toHaveBeenCalled();
    });

    it('does not show the done state when the clipboard write fails', async () => {
        ensureUiStylesheetInjected();
        const writeText = jest.fn(() => Promise.reject(new Error('denied')));
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        document.body.innerHTML = `
            <details class="luker_lib_reasoning_details" open>
                <summary><button type="button" data-luker-lib-copy-reasoning></button></summary>
                <div class="luker_lib_reasoning_body">hello reasoning</div>
            </details>`;
        const button = document.querySelector('[data-luker-lib-copy-reasoning]');
        button.click();
        await Promise.resolve();
        expect(button.classList.contains('luker_lib_reasoning_copy_done')).toBe(false);
    });
});
