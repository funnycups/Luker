/**
 * Idempotent stylesheet injector for iteration-library/ui/styles.css.
 * Studios call this once during open(); subsequent calls are no-ops.
 */
const STYLESHEET_ID = 'luker_lib_ui_stylesheet';
const STYLESHEET_HREF = '/scripts/iteration-library/ui/styles.css';

export function ensureUiStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}
