import { MAX_FILE_NAME_BYTES } from './pipeline/chat-fork.js';

/**
 * cap-ok: a label is part of a branch chat's file name, which holds at most
 * `MAX_FILE_NAME_BYTES` bytes, and every character takes at least one byte,
 * so a longer label never fits.
 */
export const MAX_DEVICE_LABEL_CHARS = MAX_FILE_NAME_BYTES;

/**
 * The form of a device label both devices store and write into records,
 * notices and branch names: whitespace runs become one space, control and
 * format characters are dropped, and the result is trimmed and capped.
 * Anything else than a string, or a label without visible text, gives an
 * empty string, which callers treat as absent.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDeviceLabel(value) {
    if (typeof value !== 'string') return '';
    const cleaned = value.replace(/\s+/gu, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ {2,}/g, ' ').trim();
    return [...cleaned].slice(0, MAX_DEVICE_LABEL_CHARS).join('').trim();
}
