/**
 * On-demand capture of the renderer that hosts the webview.
 *
 * The webview's devtools server speaks CDP over an abstract unix socket. This
 * module owns the artifact directory and the one recording session the app can
 * have at a time; every entry point either returns a finished artifact or
 * throws.
 */
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { connectChannel } from './cdp-channel.js';
import {
    fetchTargets,
    fetchVersionInfo,
    resolveSocketPath,
    selectBrowserWsUrl,
    selectPageTarget,
} from './devtools-socket.js';
import {
    TRACE_CATEGORIES,
    createStreamingTraceWriter,
    writeHeapSnapshot,
    writeTraceDrain,
    writeTraceStart,
} from './capture-session.js';

const CAPTURE_DIR_NAME = 'renderer-capture';
const RETAINED_TRACE_LIMIT = 2;

/** @type {{ name: string, channel: object, fd: number, fdClosed: boolean, aborted: boolean, started: boolean, targetMode: 'browser'|'page', initialUrl: string, writer: ReturnType<typeof createStreamingTraceWriter>, trackedTargetId: string|null, finalizePromise: Promise<{ name: string, bytes: number }>|null }|null} */
let session = null;
let traceStarting = false;
let heapInFlight = false;

export function captureDir() {
    return path.join(globalThis.DATA_ROOT, CAPTURE_DIR_NAME);
}

export function artifactPath(name) {
    return path.join(captureDir(), name);
}

export function removeArtifact(name) {
    rmSync(artifactPath(name), { force: true });
}

function stamp() {
    const now = new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    // Milliseconds keep two captures of the same kind in the same second from
    // opening the same path.
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
        + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
        + `-${pad(now.getMilliseconds(), 3)}`;
}

async function openCaptureChannel(socketPath) {
    const resolved = socketPath ?? resolveSocketPath();
    const target = selectPageTarget(await fetchTargets(resolved));
    if (!target) {
        throw new Error('renderer-capture: the devtools server has no local page target');
    }
    return connectChannel(resolved, target.webSocketDebuggerUrl);
}

/**
 * Report whether a capture can run at all, and why not when it cannot.
 *
 * An unavailable devtools server is the answer here, not an error, so the
 * failure is turned into the `reason` field rather than thrown — nothing is
 * swallowed, it is reported to the caller.
 *
 * @param {{ socketPath?: string }} [options]
 * @returns {Promise<{ available: boolean, reason: string|null }>}
 */
export async function probeCapture({ socketPath } = {}) {
    try {
        const resolved = socketPath ?? resolveSocketPath();
        const target = selectPageTarget(await fetchTargets(resolved));
        if (!target) {
            return { available: false, reason: 'the devtools server has no local page target' };
        }
        return { available: true, reason: null };
    } catch (error) {
        return { available: false, reason: error.message };
    }
}

/**
 * @returns {Promise<{ name: string, bytes: number }>}
 */
export async function captureHeapSnapshot() {
    if (heapInFlight) {
        throw new Error('renderer-capture: a heap capture is already running');
    }
    heapInFlight = true;

    try {
        mkdirSync(captureDir(), { recursive: true });

        const name = `luker-heap-${stamp()}.heapsnapshot`;
        // Open the artifact before touching the renderer: a path the app cannot
        // write to must fail the capture, not start one it cannot save.
        const fd = openSync(artifactPath(name), 'w');

        try {
            const channel = await openCaptureChannel();
            try {
                const bytes = await writeHeapSnapshot({ channel, fd });
                return { name, bytes };
            } finally {
                channel.close();
            }
        } catch (error) {
            removeArtifact(name);
            throw error;
        } finally {
            closeSync(fd);
        }
    } finally {
        heapInFlight = false;
    }
}

function pruneOldTraces(dir, keepCount = RETAINED_TRACE_LIMIT) {
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return;
    }

    const traces = names
        .filter((name) => /^luker-trace-.*\.json$/.test(name))
        .map((name) => {
            const fullPath = path.join(dir, name);
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(fullPath).mtimeMs;
            } catch {
                // ignore stat error
            }
            return { name, fullPath, mtimeMs };
        })
        .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.name.localeCompare(a.name));

    for (let i = keepCount; i < traces.length; i++) {
        rmSync(traces[i].fullPath, { force: true });
    }
}

function closeSessionFd(targetSession) {
    if (targetSession.fdClosed) {
        return;
    }
    targetSession.fdClosed = true;
    try {
        closeSync(targetSession.fd);
    } catch {
        // already closed
    }
}

async function finalizeSession(targetSession, { fromChannelClose = false } = {}) {
    if (!targetSession || targetSession.aborted || !targetSession.started) {
        return null;
    }
    if (targetSession.finalizePromise) {
        return targetSession.finalizePromise;
    }
    if (session !== targetSession) {
        return null;
    }

    targetSession.finalizePromise = (async () => {
        try {
            let bytes = 0;
            if (!fromChannelClose && !targetSession.channel.closed) {
                try {
                    bytes = await writeTraceDrain({
                        channel: targetSession.channel,
                        writer: targetSession.writer,
                    });
                } catch (error) {
                    if (!targetSession.writer.headerWritten && targetSession.writer.eventCount === 0) {
                        throw error;
                    }
                    bytes = targetSession.writer.seal();
                }
            } else if (targetSession.writer.headerWritten || targetSession.writer.eventCount > 0) {
                bytes = targetSession.writer.seal();
            }

            if (bytes === 0) {
                removeArtifact(targetSession.name);
            }

            console.info(`[renderer-capture] trace finalized name=${targetSession.name} targetMode=${targetSession.targetMode} bytes=${bytes} fromChannelClose=${fromChannelClose}`);
            return { name: targetSession.name, bytes };
        } catch (error) {
            removeArtifact(targetSession.name);
            throw error;
        } finally {
            targetSession.channel.close();
            closeSessionFd(targetSession);
            if (session === targetSession) {
                session = null;
            }
        }
    })();

    return targetSession.finalizePromise;
}

function attachTraceLifecycle(targetSession) {
    targetSession.channel.onEvent((message) => {
        if (targetSession.aborted || !targetSession.started || session !== targetSession) {
            return;
        }
        if (message.method === 'Page.frameNavigated') {
            void finalizeSession(targetSession, { fromChannelClose: false });
            return;
        }
        if (message.method === 'Target.targetCrashed' || message.method === 'Target.targetDestroyed') {
            const targetId = message.params?.targetId;
            if (!targetSession.trackedTargetId || targetId === targetSession.trackedTargetId) {
                void finalizeSession(targetSession, { fromChannelClose: false });
            }
            return;
        }
        if (message.method === 'Target.targetInfoChanged') {
            const info = message.params?.targetInfo;
            if (
                info
                && (!targetSession.trackedTargetId || info.targetId === targetSession.trackedTargetId)
                && typeof info.url === 'string'
                && targetSession.initialUrl
                && info.url !== targetSession.initialUrl
            ) {
                void finalizeSession(targetSession, { fromChannelClose: false });
            }
        }
    });

    targetSession.channel.onClose(() => {
        if (targetSession.aborted || !targetSession.started || session !== targetSession) {
            return;
        }
        void finalizeSession(targetSession, { fromChannelClose: true });
    });
}

/**
 * @returns {Promise<{ name: string }>}
 */
export async function startTrace() {
    if (session || traceStarting) {
        throw new Error('renderer-capture: a recording is already running');
    }
    traceStarting = true;

    try {
        mkdirSync(captureDir(), { recursive: true });
        pruneOldTraces(captureDir(), RETAINED_TRACE_LIMIT);

        const resolved = resolveSocketPath();
        const pageTarget = selectPageTarget(await fetchTargets(resolved));
        if (!pageTarget) {
            throw new Error('renderer-capture: the devtools server has no local page target');
        }

        let browserWsUrl = null;
        try {
            browserWsUrl = selectBrowserWsUrl(await fetchVersionInfo(resolved));
            if (!browserWsUrl) {
                console.warn('[renderer-capture] /json/version omitted webSocketDebuggerUrl; using targetMode=page');
            }
        } catch (versionError) {
            console.warn(`[renderer-capture] /json/version unavailable (${versionError.message}); using targetMode=page`);
            browserWsUrl = null;
        }

        const name = `luker-trace-${stamp()}.json`;
        const fd = openSync(artifactPath(name), 'w');
        const writer = createStreamingTraceWriter(fd);
        const trackedTargetId = pageTarget.id ?? null;

        const tryStartOnEndpoint = async (wsUrl, targetMode) => {
            const channel = await connectChannel(resolved, wsUrl);
            const candidate = {
                name,
                channel,
                fd,
                fdClosed: false,
                aborted: false,
                started: false,
                targetMode,
                initialUrl: pageTarget.url,
                writer,
                trackedTargetId,
                finalizePromise: null,
            };
            session = candidate;
            attachTraceLifecycle(candidate);
            try {
                await writeTraceStart({
                    channel,
                    categories: TRACE_CATEGORIES,
                    writer,
                    discoverTargets: targetMode === 'browser',
                });
                candidate.started = true;
                return true;
            } catch (error) {
                candidate.aborted = true;
                if (session === candidate) {
                    session = null;
                }
                channel.close();
                throw error;
            }
        };

        try {
            if (browserWsUrl) {
                try {
                    await tryStartOnEndpoint(browserWsUrl, 'browser');
                    console.info(`[renderer-capture] trace started name=${name} targetMode=browser`);
                    return { name };
                } catch (browserError) {
                    if (writer.bytesWritten > 0) {
                        throw browserError;
                    }
                    console.warn(`[renderer-capture] browser tracing failed (${browserError.message}); falling back to targetMode=page`);
                }
            }

            await tryStartOnEndpoint(pageTarget.webSocketDebuggerUrl, 'page');
            console.info(`[renderer-capture] trace started name=${name} targetMode=page`);
            return { name };
        } catch (error) {
            session = null;
            try {
                closeSync(fd);
            } catch {
                // already closed
            }
            removeArtifact(name);
            throw error;
        }
    } finally {
        traceStarting = false;
    }
}

/**
 * @returns {Promise<{ name: string, bytes: number }>}
 */
export async function stopTrace() {
    if (!session) {
        throw new Error('renderer-capture: no recording is running');
    }

    return finalizeSession(session, { fromChannelClose: session.channel.closed });
}

export function isTraceRecording() {
    if (session?.channel.closed && !session.finalizePromise) {
        void finalizeSession(session, { fromChannelClose: true });
        return false;
    }
    return session !== null && !session.finalizePromise && !session.channel.closed;
}

/**
 * Drop a recording that can no longer be finished, for instance because the
 * caller explicitly aborted it or startup failed.
 *
 * @returns {boolean} whether a recording was running
 */
export function abortTrace() {
    if (!session) {
        return false;
    }

    const current = session;
    current.aborted = true;
    session = null;
    current.channel.close();
    closeSessionFd(current);
    removeArtifact(current.name);
    return true;
}
