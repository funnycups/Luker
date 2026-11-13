/**
 * The two capture conversations.
 *
 * Both stream straight into an open file descriptor: a heap snapshot can run
 * to hundreds of megabytes and a trace is unbounded, so nothing here
 * assembles a payload in memory. The writes are synchronous on purpose — the
 * capture owns the descriptor for its whole lifetime, so there is no window
 * in which a failure can land after the capture has already reported back.
 */
import { writeSync } from 'node:fs';

/**
 * @param {number} fd
 * @param {string|Buffer} chunk
 */
function writeChunk(fd, chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
        offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
}

/**
 * How much of the trace stream to ask for in one `IO.read`. The embedded
 * engine answered a short recording's whole stream in a single read of
 * 471035 bytes, so this covers that case in one round trip.
 */
export const TRACE_READ_CHUNK_BYTES = 524288;

/**
 * The trace categories worth paying for when diagnosing a stalled renderer:
 * the timeline, the JavaScript engine, layout and paint, and the compositor.
 * Screenshot categories are deliberately absent — they multiply the payload
 * without showing anything about why the main thread stalled.
 */
export const TRACE_CATEGORIES = 'devtools.timeline,v8,blink,cc,gpu';

/**
 * Take a heap snapshot and stream it into an open descriptor.
 *
 * @param {{ channel: object, fd: number }} options
 * @returns {Promise<number>} bytes written
 */
export async function writeHeapSnapshot({ channel, fd }) {
    const takeId = 2;

    channel.send({ id: 1, method: 'HeapProfiler.enable' });
    channel.send({
        id: takeId,
        method: 'HeapProfiler.takeHeapSnapshot',
        params: { reportProgress: true },
    });

    let written = 0;

    for (;;) {
        const message = await channel.next();

        if (message.error) {
            throw new Error(`HeapProfiler.takeHeapSnapshot: ${message.error.message}`);
        }

        if (message.method === 'HeapProfiler.addHeapSnapshotChunk' && typeof message.params?.chunk === 'string') {
            written += Buffer.byteLength(message.params.chunk);
            writeChunk(fd, message.params.chunk);
            continue;
        }

        if (message.id === takeId) {
            break;
        }
    }

    if (written === 0) {
        throw new Error('renderer-capture: the heap snapshot arrived without any data');
    }

    return written;
}

/**
 * Stream CDP `Tracing.dataCollected` events directly into a valid JSON trace
 * file (`{"traceEvents":[...]}\n`).
 *
 * @param {number} fd
 */
export function createStreamingTraceWriter(fd) {
    let headerWritten = false;
    let sealed = false;
    let bytesWritten = 0;
    let eventCount = 0;

    const writeHeaderOnce = () => {
        if (headerWritten || sealed) {
            return 0;
        }
        const header = '{"traceEvents":[';
        writeChunk(fd, header);
        headerWritten = true;
        const bytes = Buffer.byteLength(header);
        bytesWritten += bytes;
        return bytes;
    };

    const appendEvents = (events) => {
        if (sealed || !Array.isArray(events) || events.length === 0) {
            return 0;
        }
        writeHeaderOnce();
        let chunk = '';
        for (let i = 0; i < events.length; i++) {
            const prefix = eventCount > 0 ? ',' : '';
            chunk += `${prefix}${JSON.stringify(events[i])}`;
            eventCount += 1;
        }
        writeChunk(fd, chunk);
        const bytes = Buffer.byteLength(chunk);
        bytesWritten += bytes;
        return bytes;
    };

    const seal = () => {
        if (sealed) {
            return bytesWritten;
        }
        writeHeaderOnce();
        const footer = ']}\n';
        writeChunk(fd, footer);
        bytesWritten += Buffer.byteLength(footer);
        sealed = true;
        return bytesWritten;
    };

    return {
        writeHeaderOnce,
        appendEvents,
        seal,
        get bytesWritten() {
            return bytesWritten;
        },
        get eventCount() {
            return eventCount;
        },
        get headerWritten() {
            return headerWritten;
        },
        get sealed() {
            return sealed;
        },
    };
}

/**
 * Begin a streamed trace (`ReportEvents`). Events arriving via
 * `Tracing.dataCollected` are immediately written through `writer`.
 *
 * @param {{ channel: object, categories: string, writer: ReturnType<typeof createStreamingTraceWriter>, discoverTargets?: boolean }} options
 * @returns {Promise<void>}
 */
export async function writeTraceStart({ channel, categories, writer, discoverTargets = false }) {
    const lifecycleId = 1;
    const startId = 2;

    channel.onEvent((message) => {
        if (message.method === 'Tracing.dataCollected' && Array.isArray(message.params?.value)) {
            writer.appendEvents(message.params.value);
            return true;
        }
        return false;
    });

    if (discoverTargets) {
        channel.send({ id: lifecycleId, method: 'Target.setDiscoverTargets', params: { discover: true } });
    } else {
        channel.send({ id: lifecycleId, method: 'Page.enable' });
    }
    channel.send({
        id: startId,
        method: 'Tracing.start',
        params: { categories, transferMode: 'ReportEvents' },
    });

    for (;;) {
        const message = await channel.next();
        if (message.id === lifecycleId && message.error) {
            continue;
        }
        if (message.error) {
            throw new Error(`Tracing.start: ${message.error.message}`);
        }
        if (message.id === startId) {
            writer.writeHeaderOnce();
            return;
        }
    }
}

/**
 * End the trace, wait for any trailing `Tracing.dataCollected` events until
 * `Tracing.tracingComplete`, and seal the JSON trace file.
 *
 * @param {{ channel: object, writer: ReturnType<typeof createStreamingTraceWriter> }} options
 * @returns {Promise<number>} total bytes written to the trace file
 */
export async function writeTraceDrain({ channel, writer }) {
    const endId = 3;
    channel.send({ id: endId, method: 'Tracing.end' });

    for (;;) {
        const message = await channel.next();
        if (message.error) {
            throw new Error(`Tracing.end: ${message.error.message}`);
        }
        if (message.method === 'Tracing.tracingComplete') {
            break;
        }
    }

    return writer.seal();
}
