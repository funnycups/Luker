import { describe, test, expect } from '@jest/globals';
import {
    formatHttpErrorHint,
    formatTransportErrorHint,
    formatConflictHint,
    formatValidationArgsHint,
    formatValidationTargetHint,
} from '../../public/scripts/state-errors/format.js';

test('formatHttpErrorHint includes status + body excerpt, no ; in body', () => {
    const hint = formatHttpErrorHint(500, 'Internal Server Error', 'chatId not found');
    expect(hint).toBe('HTTP 500: Internal Server Error - chatId not found');
});
test('formatHttpErrorHint truncates body to 80 chars', () => {
    const body = 'x'.repeat(200);
    const hint = formatHttpErrorHint(413, 'Payload Too Large', body);
    expect(hint).toMatch(/^HTTP 413: Payload Too Large - x{80}$/);
});
test('formatHttpErrorHint tolerates missing body', () => {
    expect(formatHttpErrorHint(500, 'Internal Server Error', '')).toBe('HTTP 500: Internal Server Error');
});
test('formatTransportErrorHint prefixes with "fetch failed"', () => {
    expect(formatTransportErrorHint('Failed to fetch')).toBe('fetch failed: Failed to fetch');
});
test('formatTransportErrorHint coerces non-string to string', () => {
    expect(formatTransportErrorHint(undefined)).toBe('fetch failed: unknown');
});
test('formatConflictHint reports retry count', () => {
    expect(formatConflictHint(1)).toBe('HTTP 409 after 1 retry — another writer raced; re-read and try again');
});
test('formatValidationArgsHint shapes field + detail', () => {
    expect(formatValidationArgsHint('namespace', 'must be a non-empty string'))
        .toBe('namespace must be a non-empty string');
});
test('formatValidationTargetHint passes detail through', () => {
    expect(formatValidationTargetHint('no active chat (chatId resolution failed)'))
        .toBe('no active chat (chatId resolution failed)');
});
