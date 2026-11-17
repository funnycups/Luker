import { describe, test, expect, beforeEach } from '@jest/globals';
import vm from 'node:vm';
import {
    clearFrontendLogs,
    getFrontendLogsSnapshot,
    installFrontendLogCapture,
} from '../public/scripts/frontend-log-manager.js';

describe('frontend-log-manager cross-realm error serialization', () => {
    beforeEach(() => {
        if (!globalThis.window) {
            globalThis.window = {
                location: { href: 'http://127.0.0.1:8000/', origin: 'http://127.0.0.1:8000' },
                addEventListener: () => {},
            };
        }
        installFrontendLogCapture();
        clearFrontendLogs();
    });

    test('serializes cross-realm Error instances instead of collapsing to empty braces', () => {
        const crossRealmError = vm.runInNewContext('new TypeError("cross-realm helper is not a function")');
        expect(crossRealmError instanceof Error).toBe(false);

        console.error('Unexpected error while preparing prompts', crossRealmError);

        const { entries } = getFrontendLogsSnapshot();
        const entry = entries.find((item) => item.message.startsWith('Unexpected error while preparing prompts'));
        expect(entry).toBeDefined();
        expect(entry.level).toBe('error');
        expect(entry.message).toContain('TypeError: cross-realm helper is not a function');
        expect(entry.message).not.toBe('Unexpected error while preparing prompts {}');
    });

    test('serializes cross-realm Error instances nested inside plain objects', () => {
        const crossRealmError = vm.runInNewContext('new RangeError("index out of bounds")');
        expect(crossRealmError instanceof Error).toBe(false);

        console.error('Nested failure', { detail: crossRealmError });

        const { entries } = getFrontendLogsSnapshot();
        const entry = entries.find((item) => item.message.startsWith('Nested failure'));
        expect(entry).toBeDefined();
        expect(entry.message).toContain('RangeError: index out of bounds');
    });

    test('keeps plain objects with name and message properties serialized as JSON', () => {
        console.error('Plain payload', { name: 'TypeError', message: 'plain object payload' });

        const { entries } = getFrontendLogsSnapshot();
        const entry = entries.find((item) => item.message.startsWith('Plain payload'));
        expect(entry).toBeDefined();
        expect(entry.message).toBe('Plain payload {"name":"TypeError","message":"plain object payload"}');
    });
});
