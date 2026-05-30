/**
 * Idempotent stylesheet injector for
 * iteration-library/simulation-review/styles.css. Callers invoke this
 * once during open(); subsequent calls are no-ops.
 */
const STYLESHEET_ID = 'luker_simulation_review_stylesheet';
const STYLESHEET_HREF = '/scripts/iteration-library/simulation-review/styles.css';

export function ensureSimulationReviewStylesheetInjected() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLESHEET_ID)) return;
    const link = document.createElement('link');
    link.id = STYLESHEET_ID;
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    document.head.appendChild(link);
}
