// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatArgumentPathKey, parseArgumentPath } from '../../streaming-tool-reply.js';

const SIMPLE_ESCAPES = Object.freeze({
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
});

function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isHexDigit(ch) {
    const code = ch.charCodeAt(0);
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 70)
        || (code >= 97 && code <= 102);
}

function createJsonStringDecoder() {
    let text = '';
    let esc = 'none'; // 'none' | 'slash' | 'unicode'
    let hexBuf = '';
    let pendingHighSurrogate = null;

    function flushHighSurrogate() {
        if (pendingHighSurrogate !== null) {
            text += String.fromCharCode(pendingHighSurrogate);
            pendingHighSurrogate = null;
        }
    }

    return {
        /**
         * Feed one character of a JSON string body (after opening `"`).
         * Returns `'continue'`, `'done'` (unescaped closing `"`), or `'error'`.
         * @param {string} ch
         * @returns {'continue'|'done'|'error'}
         */
        push(ch) {
            if (esc === 'none') {
                if (ch === '"') {
                    flushHighSurrogate();
                    return 'done';
                }
                if (ch === '\\') {
                    esc = 'slash';
                    return 'continue';
                }
                flushHighSurrogate();
                text += ch;
                return 'continue';
            }

            if (esc === 'slash') {
                if (ch === 'u') {
                    esc = 'unicode';
                    hexBuf = '';
                    return 'continue';
                }
                const mapped = SIMPLE_ESCAPES[ch];
                if (mapped === undefined) {
                    return 'error';
                }
                flushHighSurrogate();
                text += mapped;
                esc = 'none';
                return 'continue';
            }

            // esc === 'unicode'
            if (!isHexDigit(ch)) {
                return 'error';
            }
            hexBuf += ch;
            if (hexBuf.length < 4) {
                return 'continue';
            }
            const cu = parseInt(hexBuf, 16);
            hexBuf = '';
            esc = 'none';

            if (pendingHighSurrogate !== null) {
                if (cu >= 0xdc00 && cu <= 0xdfff) {
                    text += String.fromCharCode(pendingHighSurrogate, cu);
                    pendingHighSurrogate = null;
                    return 'continue';
                }
                flushHighSurrogate();
            }

            if (cu >= 0xd800 && cu <= 0xdbff) {
                pendingHighSurrogate = cu;
            } else {
                text += String.fromCharCode(cu);
            }
            return 'continue';
        },
        getValue() {
            return text;
        },
    };
}

/**
 * Create an O(N) incremental JSON lexer/extractor that streams the decoded
 * value of a string field located at `pathOrSegments` (e.g. `['body']` or
 * `'payload.paragraphs[0].text'`) as raw JSON chunks arrive.
 *
 * Holds back incomplete escape sequences (`\`, `\u4e`) and unpaired UTF-16
 * high surrogates (`\uD83D` awaiting `\uDE00`) so live UI previews never flash
 * malformed escape tokens or lone surrogates.
 *
 * @param {unknown} pathOrSegments
 */
export function createIncrementalJsonStringExtractor(pathOrSegments) {
    const targetPath = parseArgumentPath(pathOrSegments);
    if (!targetPath) {
        return {
            feed() {},
            getValue() { return ''; },
        };
    }

    /** @type {Array<{ type: 'object', key: string|null } | { type: 'array', index: number }>} */
    const stack = [];
    let mode = 'value'; // 'value' | 'object_key_or_end' | 'read_key' | 'object_colon' | 'array_value_or_end' | 'after_value' | 'skip_string' | 'skip_primitive' | 'target_string'
    let skipEscaped = false;
    let keyDecoder = null;
    let targetDecoder = null;
    let done = false;
    let failed = false;

    function isAtTargetPath() {
        if (stack.length !== targetPath.length) return false;
        for (let i = 0; i < targetPath.length; i += 1) {
            const frame = stack[i];
            const seg = targetPath[i];
            if (typeof seg === 'string') {
                if (frame.type !== 'object' || frame.key !== seg) return false;
            } else if (frame.type !== 'array' || frame.index !== seg) {
                return false;
            }
        }
        return true;
    }

    function feed(delta) {
        if (done || failed || typeof delta !== 'string' || delta.length === 0) {
            return;
        }
        let i = 0;
        while (i < delta.length && !done && !failed) {
            const ch = delta[i];

            if (mode === 'target_string') {
                const status = targetDecoder.push(ch);
                i += 1;
                if (status === 'done') {
                    done = true;
                } else if (status === 'error') {
                    failed = true;
                }
                continue;
            }

            if (mode === 'skip_string') {
                i += 1;
                if (skipEscaped) {
                    skipEscaped = false;
                } else if (ch === '\\') {
                    skipEscaped = true;
                } else if (ch === '"') {
                    mode = 'after_value';
                }
                continue;
            }

            if (mode === 'read_key') {
                const status = keyDecoder.push(ch);
                i += 1;
                if (status === 'done') {
                    stack[stack.length - 1].key = keyDecoder.getValue();
                    keyDecoder = null;
                    mode = 'object_colon';
                } else if (status === 'error') {
                    failed = true;
                }
                continue;
            }

            if (mode === 'skip_primitive') {
                if (isWhitespace(ch) || ch === ',' || ch === '}' || ch === ']' || ch === ':') {
                    mode = 'after_value';
                } else {
                    i += 1;
                }
                continue;
            }

            if (isWhitespace(ch)) {
                i += 1;
                continue;
            }

            if (mode === 'value') {
                if (isAtTargetPath()) {
                    if (ch === '"') {
                        targetDecoder = createJsonStringDecoder();
                        mode = 'target_string';
                        i += 1;
                    } else {
                        done = true;
                    }
                    continue;
                }

                if (ch === '{') {
                    stack.push({ type: 'object', key: null });
                    mode = 'object_key_or_end';
                    i += 1;
                } else if (ch === '[') {
                    stack.push({ type: 'array', index: 0 });
                    mode = 'array_value_or_end';
                    i += 1;
                } else if (ch === '"') {
                    skipEscaped = false;
                    mode = 'skip_string';
                    i += 1;
                } else {
                    mode = 'skip_primitive';
                }
                continue;
            }

            if (mode === 'object_key_or_end') {
                if (ch === '}') {
                    stack.pop();
                    mode = 'after_value';
                    i += 1;
                } else if (ch === '"') {
                    keyDecoder = createJsonStringDecoder();
                    mode = 'read_key';
                    i += 1;
                } else {
                    failed = true;
                }
                continue;
            }

            if (mode === 'object_colon') {
                if (ch === ':') {
                    mode = 'value';
                    i += 1;
                } else {
                    failed = true;
                }
                continue;
            }

            if (mode === 'array_value_or_end') {
                if (ch === ']') {
                    stack.pop();
                    mode = 'after_value';
                    i += 1;
                } else {
                    mode = 'value';
                }
                continue;
            }

            if (mode === 'after_value') {
                if (stack.length === 0) {
                    done = true;
                    continue;
                }
                const top = stack[stack.length - 1];
                if (top.type === 'object') {
                    if (ch === ',') {
                        top.key = null;
                        mode = 'object_key_or_end';
                        i += 1;
                    } else if (ch === '}') {
                        stack.pop();
                        i += 1;
                    } else {
                        failed = true;
                    }
                } else if (ch === ',') {
                    top.index += 1;
                    mode = 'value';
                    i += 1;
                } else if (ch === ']') {
                    stack.pop();
                    i += 1;
                } else {
                    failed = true;
                }
            }
        }
    }

    return {
        feed,
        getValue() {
            return targetDecoder ? targetDecoder.getValue() : '';
        },
    };
}

/**
 * Convenience one-shot helper extracting the current decoded string value at
 * `pathOrSegments` from a complete or partial JSON object string.
 *
 * @param {string} jsonText
 * @param {unknown} pathOrSegments
 * @returns {string}
 */
export function extractStreamingJsonStringAtPath(jsonText, pathOrSegments) {
    if (typeof jsonText !== 'string' || !jsonText) return '';
    const extractor = createIncrementalJsonStringExtractor(pathOrSegments);
    extractor.feed(jsonText);
    return extractor.getValue();
}

/**
 * Per-parser lazy O(N) preview cache keyed by `(slotObject, pathKey)`.
 * Costs zero work when `getToolCallPreview` is never called, and feeds only
 * newly appended argument bytes when polled on every SSE frame.
 */
export function createJsonToolPreviewTracker() {
    /** @type {WeakMap<object, Map<string, { offset: number, extractor: ReturnType<typeof createIncrementalJsonStringExtractor> }>>} */
    const cache = new WeakMap();

    return {
        /**
         * @param {object} slot Stable tool-call slot object
         * @param {string} argsStr Accumulated raw JSON string for this slot
         * @param {unknown} argument Target argument name or nested path
         * @returns {string}
         */
        getPreview(slot, argsStr, argument) {
            if (!slot || typeof argsStr !== 'string' || !argsStr) return '';
            const segments = parseArgumentPath(argument);
            if (!segments) return '';
            const key = formatArgumentPathKey(segments);

            let slotMap = cache.get(slot);
            if (!slotMap) {
                slotMap = new Map();
                cache.set(slot, slotMap);
            }

            let entry = slotMap.get(key);
            if (!entry || argsStr.length < entry.offset) {
                entry = {
                    offset: 0,
                    extractor: createIncrementalJsonStringExtractor(segments),
                };
                slotMap.set(key, entry);
            }

            if (argsStr.length > entry.offset) {
                entry.extractor.feed(argsStr.slice(entry.offset));
                entry.offset = argsStr.length;
            }
            return entry.extractor.getValue();
        },
    };
}
