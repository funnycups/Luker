// SPDX-License-Identifier: AGPL-3.0-or-later

const VALID_SSE_FIELDS = new Set(['event', 'data', 'id', 'retry']);

/**
 * A stream which handles Server-Sent Events from a binary ReadableStream like you get from the fetch API.
 */
export class EventSourceStream {
    constructor() {
        const decoder = new TextDecoderStream('utf-8');

        let streamBuffer = '';
        let lastEventId = '';
        const invalidLines = [];

        function emitEventBlock(eventChunk, controller) {
            if (!eventChunk) return;
            let eventType = '';
            const lines = eventChunk.split(/\r\n|\n|\r/g);
            let eventData = '';
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

                switch (field) {
                    case 'event':
                        eventType = value;
                        break;
                    case 'data':
                        eventData += value;
                        eventData += '\n';
                        break;
                    case 'id':
                        if (!value.includes('\0')) lastEventId = value;
                        break;
                    case 'retry':
                        break;
                    default:
                        if (!VALID_SSE_FIELDS.has(field)) {
                            invalidLines.push(line);
                        }
                        break;
                }
            }

            if (eventData === '') return;

            if (eventData[eventData.length - 1] === '\n') {
                eventData = eventData.slice(0, -1);
            }

            const event = new MessageEvent(eventType || 'message', { data: eventData, lastEventId });
            controller.enqueue(event);
        }

        function processChunk(controller) {
            const events = streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g);
            if (events.length === 0) return;

            streamBuffer = events.pop();

            for (const eventChunk of events) {
                emitEventBlock(eventChunk, controller);
            }
        }

        const sseStream = new TransformStream({
            transform(chunk, controller) {
                streamBuffer += chunk;
                processChunk(controller);
            },
            flush(controller) {
                if (streamBuffer) {
                    const tail = streamBuffer;
                    streamBuffer = '';
                    emitEventBlock(tail, controller);
                }
            },
        });

        decoder.readable.pipeThrough(sseStream);

        this.readable = sseStream.readable;
        this.writable = decoder.writable;
        this.getInvalidDiagnostic = () => (invalidLines.length > 0 ? invalidLines.join('\n') : null);
    }
}

export default EventSourceStream;
