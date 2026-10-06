/**
 * Idempotent stylesheet injector for iteration-library/ui/styles.css, plus
 * the shared reasoning-copy interaction. Studios call `ensureUiStylesheetInjected()`
 * once during open(); subsequent calls are no-ops.
 */
const STYLESHEET_ID = 'luker_lib_ui_stylesheet';
const STYLESHEET_HREF = '/scripts/iteration-library/ui/styles.css';
const REASONING_COPY_ATTR = 'data-luker-lib-copy-reasoning';

let reasoningCopyListenerInstalled = false;

function copyTextToClipboard(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return Promise.resolve(Boolean(ok));
    } catch {
        return Promise.resolve(false);
    }
}

function installReasoningCopyListener() {
    if (reasoningCopyListenerInstalled || typeof document === 'undefined') return;
    reasoningCopyListenerInstalled = true;
    document.addEventListener('click', (event) => {
        const target = event.target;
        const button = target && typeof target.closest === 'function'
            ? target.closest(`[${REASONING_COPY_ATTR}]`)
            : null;
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const details = button.closest('.luker_lib_reasoning_details');
        const body = details ? details.querySelector('.luker_lib_reasoning_body') : null;
        const text = body ? String(body.innerText || body.textContent || '') : '';
        if (!text) return;
        copyTextToClipboard(text).then((ok) => {
            if (!ok) return;
            button.classList.add('luker_lib_reasoning_copy_done');
            setTimeout(() => button.classList.remove('luker_lib_reasoning_copy_done'), 1200);
        });
    });
}

export function ensureUiStylesheetInjected() {
    if (typeof document === 'undefined') return;
    installReasoningCopyListener();
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}
