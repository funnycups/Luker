/**
 * Shared HTML-escape helper for orchestrator popup builders. Previously
 * inlined as a 1-line `esc()` in custom-tool-editor.js,
 * bridge-st-tool-picker.js, and character-import-tools-review.js — kept
 * here so the three popups share one implementation and one test target.
 *
 * Escapes the five characters required to safely interpolate untrusted
 * strings inside HTML attribute values and element content (&, <, >, ",
 * '). Numeric/HTML-entity refs are used rather than &apos; for IE/legacy
 * compatibility parity with the prior inline copy.
 */
export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
}
