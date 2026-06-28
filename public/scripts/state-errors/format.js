import { STATE_HINT_MAX_LENGTH } from '../state-errors.js';

const HTTP_BODY_EXCERPT_MAX = 80;

export function formatHttpErrorHint(status, statusText, bodyExcerpt) {
    const head = `HTTP ${Number(status) || '?'}: ${String(statusText || '').trim()}`;
    const body = String(bodyExcerpt || '').slice(0, HTTP_BODY_EXCERPT_MAX);
    const out = body ? `${head} - ${body}` : head;
    return out.slice(0, STATE_HINT_MAX_LENGTH);
}

export function formatTransportErrorHint(errorMessage) {
    const msg = errorMessage == null ? 'unknown' : String(errorMessage);
    return `fetch failed: ${msg}`.slice(0, STATE_HINT_MAX_LENGTH);
}

export function formatConflictHint(retries) {
    const n = Number(retries) || 0;
    return `HTTP 409 after ${n} retry — another writer raced; re-read and try again`
        .slice(0, STATE_HINT_MAX_LENGTH);
}

export function formatValidationArgsHint(field, detail) {
    return `${String(field || 'arg').trim()} ${String(detail || 'invalid').trim()}`
        .slice(0, STATE_HINT_MAX_LENGTH);
}

export function formatValidationTargetHint(detail) {
    return String(detail || 'target unresolvable').trim().slice(0, STATE_HINT_MAX_LENGTH);
}
