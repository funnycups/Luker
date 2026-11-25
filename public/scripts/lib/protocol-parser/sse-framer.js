// SPDX-License-Identifier: AGPL-3.0-or-later

const VALID_SSE_FIELDS = new Set(['event', 'data', 'id', 'retry']);

/**
 * Strict incremental SSE framer conforming to WHATWG EventSource framing:
 *  - Normalizes CRLF (\r\n) and lone CR (\r) line endings across chunk boundaries.
 *  - Splits events on blank lines (\n\n).
 *  - Ignores comment/keepalive lines beginning with ':'.
 *  - Tracks `event:` per frame.
 *  - Strips at most one single space immediately after `data:`, preserving all
 *    payload-internal leading and trailing whitespace verbatim.
 *  - Tracks non-empty, non-comment, non-SSE lines so callers can reject HTTP
 *    200 raw JSON/HTML bodies as strict SSE protocol errors instead of silent
 *    empty streams.
 *
 * @returns {{
 *   push: (chunk: string) => Array<{event: string, data: string, raw: string}>,
 *   flush: () => Array<{event: string, data: string, raw: string}>,
 *   getInvalidDiagnostic: () => string | null,
 * }}
 */
export function createSseFramer() {
    let buffer = '';
    let pendingCarriageReturn = false;
    const invalidLines = [];

    function parseEventBlock(block) {
        if (!block) return null;
        const lines = block.split('\n');
        let eventName = '';
        const dataLines = [];
        for (const line of lines) {
            if (!line || line.startsWith(':')) {
                continue;
            }
            const colonIndex = line.indexOf(':');
            const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
            let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
            if (value.startsWith(' ')) {
                value = value.slice(1);
            }
            if (field === 'event') {
                eventName = value;
            } else if (field === 'data') {
                dataLines.push(value);
            } else if (!VALID_SSE_FIELDS.has(field)) {
                invalidLines.push(line);
            }
        }
        if (dataLines.length === 0) {
            return null;
        }
        return {
            event: eventName,
            data: dataLines.join('\n'),
            raw: block,
        };
    }

    function push(chunk) {
        if (typeof chunk !== 'string' || chunk.length === 0) {
            return [];
        }
        let text = chunk;
        if (pendingCarriageReturn) {
            pendingCarriageReturn = false;
            if (text.startsWith('\n')) {
                text = text.slice(1);
            }
        }
        if (text.endsWith('\r')) {
            pendingCarriageReturn = true;
            text = text.slice(0, -1) + '\n';
        }
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        buffer += text;

        const frames = [];
        let sepIndex = buffer.indexOf('\n\n');
        while (sepIndex !== -1) {
            const block = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);
            const parsed = parseEventBlock(block);
            if (parsed) {
                frames.push(parsed);
            }
            sepIndex = buffer.indexOf('\n\n');
        }
        return frames;
    }

    function flush() {
        pendingCarriageReturn = false;
        if (!buffer) return [];
        const tail = buffer;
        buffer = '';
        const parsed = parseEventBlock(tail);
        return parsed ? [parsed] : [];
    }

    function getInvalidDiagnostic() {
        return invalidLines.length > 0 ? invalidLines.join('\n') : null;
    }

    return { push, flush, getInvalidDiagnostic };
}
