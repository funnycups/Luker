import { describe, test, expect } from '@jest/globals';

import { normalizeDeviceLabel, MAX_DEVICE_LABEL_CHARS } from '../../src/sync/device-label.js';
import { MAX_FILE_NAME_BYTES } from '../../src/sync/pipeline/chat-fork.js';

describe('normalizeDeviceLabel', () => {
    test('strips control characters, collapses whitespace and trims', () => {
        expect(normalizeDeviceLabel('  Desk\u0000\u0007\n\r\tPhone\u001b[31m  \u2028x ')).toBe('Desk Phone[31m x');
    });

    test('caps a long label to what a fork file name can hold', () => {
        expect(MAX_DEVICE_LABEL_CHARS).toBe(MAX_FILE_NAME_BYTES);
        const label = normalizeDeviceLabel(`${'x'.repeat(10_000)}\n`);
        expect([...label]).toHaveLength(MAX_DEVICE_LABEL_CHARS);
        expect(normalizeDeviceLabel(`${'a'.repeat(MAX_DEVICE_LABEL_CHARS - 1)} b`)).toBe('a'.repeat(MAX_DEVICE_LABEL_CHARS - 1));
        expect([...normalizeDeviceLabel('😀'.repeat(10_000))]).toHaveLength(MAX_DEVICE_LABEL_CHARS);
    });

    test('anything without visible text reads as absent', () => {
        for (const value of [undefined, null, 5, {}, '', ' \n\t ', '\u0000\u0001']) expect(normalizeDeviceLabel(value)).toBe('');
    });
});
