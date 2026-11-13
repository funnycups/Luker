// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * The subset of a CDP transport the capture code needs. `LukerWebSocketChannel`
 * adapts the real WebSocket; tests script it directly.
 */
internal interface CdpChannel {
    fun sendText(text: String)
    fun readMessage(): String
}

internal class LukerWebSocketChannel(private val ws: LukerWebSocketClient) : CdpChannel {
    override fun sendText(text: String) = ws.sendText(text)
    override fun readMessage(): String = ws.readMessage()
}

/**
 * Drives `HeapProfiler.takeHeapSnapshot` and streams every
 * `addHeapSnapshotChunk` payload straight into [sink] as it arrives, so the
 * snapshot never has to fit in memory.
 *
 * Returns the number of bytes written.
 */
internal fun writeHeapSnapshot(channel: CdpChannel, sink: OutputStream): Long {
    channel.sendText("""{"id":1,"method":"HeapProfiler.enable"}""")
    channel.sendText(
        """{"id":2,"method":"HeapProfiler.takeHeapSnapshot","params":{"reportProgress":true,"captureNumericValue":true}}""",
    )
    var written = 0L
    var chunks = 0
    var maxChunk = 0
    while (true) {
        val message = channel.readMessage()
        val obj = JSONObject(message)
        val error = obj.optJSONObject("error")
        if (error != null) {
            throw IOException("cdp-capture: ${error.optString("message", "heap snapshot failed")}")
        }
        if (obj.optInt("id", -1) == 2) break
        if (obj.optString("method") != "HeapProfiler.addHeapSnapshotChunk") continue
        val text = obj.optJSONObject("params")?.optString("chunk") ?: continue
        val bytes = text.toByteArray(Charsets.UTF_8)
        sink.write(bytes)
        sink.flush()
        written += bytes.size
        chunks++
        if (bytes.size > maxChunk) maxChunk = bytes.size
    }
    if (written == 0L) {
        throw IOException("cdp-capture: heap snapshot returned no data")
    }
    LukerDebugTrail.append("native", "cdp-capture state=heap-write bytes=$written chunks=$chunks max-chunk=$maxChunk")
    return written
}

internal const val TRACE_READ_CHUNK_BYTES = 512 * 1024

/**
 * `IO.read` returns base64, so one response decodes to at most 3/4 of the
 * requested size; 512 KB keeps the response well under the 1 MB collector cap
 * and under [LukerCdpCapture.CAPTURE_MAX_MESSAGE_BYTES].
 */
internal const val TRACE_CATEGORIES =
    "devtools.timeline,v8,blink,cc,gpu," +
        "disabled-by-default-devtools.timeline," +
        "disabled-by-default-devtools.timeline.frame," +
        "disabled-by-default-v8.cpu_profiler"

private const val TRACE_HEADER = """{"traceEvents":["""
private const val TRACE_FOOTER = "]}\n"
private const val RETAINED_TRACE_LIMIT = 2
private const val FINALIZE_WAIT_TIMEOUT_MS = 2_000L

/**
 * One performance recording, spanning `Tracing.start` … `Tracing.end` using
 * `transferMode: ReportEvents` so trace events stream straight to [sink] as
 * `Tracing.dataCollected` notifications arrive.
 *
 * No screenshot categories are requested: the images dominate the file size
 * and add nothing to a stall investigation.
 */
internal class TraceSession(
    private val channel: CdpChannel,
    private val sink: OutputStream,
    private val discoverTargets: Boolean = false,
    private val trackedTargetId: String? = null,
    private val onTargetLost: (() -> Unit)? = null,
) {
    private val sinkLock = Any()
    private val completionLock = java.lang.Object()

    private var nextId = 1
    private var startId = 0
    private var endId = 0

    @Volatile
    private var open = false

    @Volatile
    private var finalizing = false

    @Volatile
    private var headerWritten = false

    @Volatile
    private var sealed = false

    @Volatile
    private var readerActive = false

    @Volatile
    private var tracingComplete = false

    @Volatile
    private var readerClosed = false

    @Volatile
    private var endCommandError: IOException? = null

    @Volatile
    private var bytesWritten = 0L

    @Volatile
    private var eventCount = 0L

    val isOpen: Boolean get() = open
    val isActiveRecording: Boolean get() = open && !finalizing
    val collectedEventCount: Long get() = eventCount
    val hasHeader: Boolean get() = headerWritten

    fun begin() {
        check(!open) { "cdp-trace: session already open" }
        if (discoverTargets) {
            channel.sendText("""{"id":${nextId++},"method":"Target.setDiscoverTargets","params":{"discover":true}}""")
        }
        startId = nextId++
        channel.sendText(
            """{"id":$startId,"method":"Tracing.start","params":""" +
                """{"categories":"$TRACE_CATEGORIES","transferMode":"ReportEvents"}}""",
        )

        while (true) {
            val obj = JSONObject(channel.readMessage())
            if (obj.optInt("id", -1) != startId) {
                continue
            }
            failOnError(obj, "Tracing.start")
            break
        }

        synchronized(sinkLock) {
            val headerBytes = TRACE_HEADER.toByteArray(Charsets.UTF_8)
            sink.write(headerBytes)
            sink.flush()
            headerWritten = true
            bytesWritten += headerBytes.size
        }
        open = true
    }

    /**
     * Reads CDP messages from [channel] until `Tracing.tracingComplete` arrives
     * or the channel closes, streaming every `Tracing.dataCollected` batch to [sink].
     */
    fun pumpUntilClosed() {
        readerActive = true
        try {
            while (open && !tracingComplete) {
                val raw = channel.readMessage()
                if (processIncomingMessage(raw)) {
                    break
                }
            }
        } finally {
            synchronized(completionLock) {
                readerClosed = true
                completionLock.notifyAll()
            }
        }
    }

    /**
     * Ends the recording, waits for trailing `Tracing.dataCollected` events up
     * to `Tracing.tracingComplete` (bounded by [timeoutMs] when positive), and
     * seals the JSON trace file.
     */
    fun finish(timeoutMs: Long = 0L): Long {
        check(open) { "cdp-trace: session is not open" }
        finalizing = true
        val currentEndId = nextId++
        endId = currentEndId
        channel.sendText("""{"id":$currentEndId,"method":"Tracing.end"}""")

        if (readerActive) {
            val deadline = if (timeoutMs > 0L) System.currentTimeMillis() + timeoutMs else 0L
            synchronized(completionLock) {
                while (!tracingComplete && !readerClosed) {
                    if (timeoutMs <= 0L) {
                        completionLock.wait()
                    } else {
                        val remaining = deadline - System.currentTimeMillis()
                        if (remaining <= 0L) break
                        completionLock.wait(remaining)
                    }
                }
            }
            endCommandError?.let { throw it }
        } else {
            while (!tracingComplete) {
                val raw = channel.readMessage()
                if (processIncomingMessage(raw)) {
                    break
                }
            }
            endCommandError?.let { throw it }
        }

        return sealIfOpen()
    }

    /**
     * Seals the JSON array (`]}\n`) idempotently if the header was written.
     * Safe to call after unexpected channel EOF or timeout.
     */
    fun sealIfOpen(): Long = synchronized(sinkLock) {
        if (sealed) return@synchronized bytesWritten
        open = false
        if (!headerWritten) return@synchronized 0L
        val footerBytes = TRACE_FOOTER.toByteArray(Charsets.UTF_8)
        sink.write(footerBytes)
        sink.flush()
        bytesWritten += footerBytes.size
        sealed = true
        bytesWritten
    }

    private fun processIncomingMessage(raw: String): Boolean {
        val obj = JSONObject(raw)
        if (endId > 0 && obj.optInt("id", -1) == endId) {
            val error = obj.optJSONObject("error")
            if (error != null) {
                endCommandError = IOException("cdp-trace: Tracing.end failed: ${error.optString("message", "unknown error")}")
                synchronized(completionLock) {
                    tracingComplete = true
                    completionLock.notifyAll()
                }
                return true
            }
        }

        when (obj.optString("method")) {
            "Tracing.dataCollected" -> {
                val events = obj.optJSONObject("params")?.optJSONArray("value")
                if (events != null && events.length() > 0) {
                    appendEvents(events)
                }
            }
            "Tracing.tracingComplete" -> {
                synchronized(completionLock) {
                    tracingComplete = true
                    completionLock.notifyAll()
                }
                return true
            }
            "Target.targetCrashed", "Target.targetDestroyed" -> {
                val targetId = obj.optJSONObject("params")?.optString("targetId", "") ?: ""
                if (trackedTargetId.isNullOrEmpty() || targetId == trackedTargetId) {
                    onTargetLost?.invoke()
                }
            }
        }
        return false
    }

    private fun appendEvents(events: org.json.JSONArray) = synchronized(sinkLock) {
        if (sealed || !headerWritten) return@synchronized
        val sb = StringBuilder()
        for (i in 0 until events.length()) {
            if (eventCount > 0L) sb.append(',')
            val item = events.get(i)
            sb.append(if (item is String) JSONObject.quote(item) else item.toString())
            eventCount++
        }
        val bytes = sb.toString().toByteArray(Charsets.UTF_8)
        sink.write(bytes)
        sink.flush()
        bytesWritten += bytes.size
    }

    private fun failOnError(obj: JSONObject, what: String) {
        val error = obj.optJSONObject("error") ?: return
        throw IOException("cdp-trace: $what failed: ${error.optString("message", "unknown error")}")
    }
}

object LukerCdpCapture {

    /**
     * Upper bound on one assembled WebSocket message during a capture.
     *
     * The collector's 1 MB default is sized for console/runtime events. A
     * heap-snapshot chunk is a slice of the whole snapshot text, and the
     * DevTools frontend splits that text at ~100 KB per message — but the
     * split size is an implementation detail of the Chromium build shipped
     * on the device, not a contract, and a rejected chunk would abort the
     * capture. 16 MB is two orders of magnitude above the observed chunk
     * size while staying far below the process heap limit, and it is only
     * ever allocated for the single message currently being assembled.
     * Task 7 records the observed maximum in the debug trail.
     */
    internal const val CAPTURE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

    private val heapInFlight = AtomicBoolean(false)

    private val traceLock = Any()

    @Volatile
    private var traceSession: TraceSession? = null

    @Volatile
    private var traceSocket: LocalSocket? = null

    @Volatile
    private var traceSink: OutputStream? = null

    @Volatile
    private var traceTarget: File? = null

    /**
     * Connects to the renderer's devtools socket, takes a heap snapshot and
     * streams it to [target]. Returns [target] on success.
     *
     * Throws [IOException] when the socket is not up yet, when the target list
     * holds no local page, or on any transport error. A failed capture deletes
     * [target] before rethrowing so a partial snapshot is never handed out as
     * a result.
     */
    fun captureHeapSnapshot(pid: Int, target: File): File {
        val targetInfo = LukerCdpTarget.fetchTarget(pid)
            ?: throw IOException("cdp-capture: no devtools target for pid=$pid")
        val wsPath = LukerCdpTarget.extractPath(targetInfo.optString("webSocketDebuggerUrl", ""))
        if (wsPath.isEmpty()) throw IOException("cdp-capture: target has no websocket path pid=$pid")

        target.parentFile?.mkdirs()
        try {
            LocalSocket().use { sock ->
                sock.connect(LocalSocketAddress(LukerCdpTarget.socketName(pid), LocalSocketAddress.Namespace.ABSTRACT))
                val ws = LukerWebSocketClient(sock.inputStream, sock.outputStream, CAPTURE_MAX_MESSAGE_BYTES)
                ws.handshake(wsPath)
                BufferedOutputStream(FileOutputStream(target)).use { out ->
                    writeHeapSnapshot(LukerWebSocketChannel(ws), out)
                }
            }
        } catch (t: Throwable) {
            target.delete()
            throw t
        }
        return target
    }

    /**
     * Opens a trace session and leaves it recording: the connection stays
     * open until [stopTrace] or [finalizeTrace] ends it. Prefers the browser
     * CDP target (surviving renderer exit/navigation) and falls back to the
     * local page target when unavailable or rejected.
     */
    fun startTrace(pid: Int, target: File): File = synchronized(traceLock) {
        check(traceSession == null) { "cdp-capture: a trace is already recording" }
        val targetInfo = LukerCdpTarget.fetchTarget(pid)
            ?: throw IOException("cdp-capture: no devtools target for pid=$pid")
        val pagePath = LukerCdpTarget.extractPath(targetInfo.optString("webSocketDebuggerUrl", ""))
        if (pagePath.isEmpty()) throw IOException("cdp-capture: target has no websocket path pid=$pid")
        val trackedTargetId = targetInfo.optString("id", "").takeIf { it.isNotEmpty() }
        val browserPath = LukerCdpTarget.fetchBrowserPath(pid)

        target.parentFile?.let { dir ->
            dir.mkdirs()
            pruneOldTraces(dir)
        }

        val out = BufferedOutputStream(FileOutputStream(target))
        var activeSock: LocalSocket? = null

        fun connectEndpoint(wsPath: String, discoverTargets: Boolean): Pair<LocalSocket, TraceSession> {
            val sock = LocalSocket()
            try {
                sock.connect(LocalSocketAddress(LukerCdpTarget.socketName(pid), LocalSocketAddress.Namespace.ABSTRACT))
                val ws = LukerWebSocketClient(sock.inputStream, sock.outputStream, CAPTURE_MAX_MESSAGE_BYTES)
                ws.handshake(wsPath)
                val s = TraceSession(
                    channel = LukerWebSocketChannel(ws),
                    sink = out,
                    discoverTargets = discoverTargets,
                    trackedTargetId = trackedTargetId,
                    onTargetLost = {
                        Thread({ finalizeTrace() }, "luker-trace-target-lost").apply { isDaemon = true }.start()
                    },
                )
                s.begin()
                return sock to s
            } catch (t: Throwable) {
                runCatching { sock.close() }
                throw t
            }
        }

        try {
            var targetMode = "page"
            var activeSession: TraceSession? = null
            if (browserPath != null) {
                try {
                    val pair = connectEndpoint(browserPath, true)
                    activeSock = pair.first
                    activeSession = pair.second
                    targetMode = "browser"
                } catch (browserError: Throwable) {
                    LukerDebugTrail.append(
                        "native",
                        "cdp-capture state=trace-browser-fallback err=${browserError.message ?: browserError.javaClass.simpleName}",
                    )
                }
            }
            if (activeSession == null) {
                val pair = connectEndpoint(pagePath, false)
                activeSock = pair.first
                activeSession = pair.second
                targetMode = "page"
            }

            traceSession = activeSession
            traceSocket = activeSock
            traceSink = out
            traceTarget = target
            LukerDebugTrail.append("native", "cdp-capture state=trace-start targetMode=$targetMode file=${target.name}")

            Thread({
                try {
                    activeSession.pumpUntilClosed()
                } catch (_: Throwable) {
                    // channel closed or read failed
                } finally {
                    if (activeSession.isOpen) {
                        finalizeTrace()
                    }
                }
            }, "luker-trace-reader").apply { isDaemon = true }.start()
        } catch (t: Throwable) {
            runCatching { out.close() }
            runCatching { activeSock?.close() }
            target.delete()
            throw t
        }
        target
    }

    /**
     * Ends the recording, writes the trace to the session's target file and
     * returns it. The session is always torn down, even on failure.
     */
    fun stopTrace(): File = synchronized(traceLock) {
        val session = traceSession ?: throw IllegalStateException("cdp-capture: no trace is recording")
        val target = traceTarget ?: throw IllegalStateException("cdp-capture: trace has no target file")
        try {
            val written = session.finish()
            LukerDebugTrail.append("native", "cdp-capture state=trace-write bytes=$written file=${target.name}")
            target
        } catch (t: Throwable) {
            val sealedBytes = runCatching { session.sealIfOpen() }.getOrDefault(0L)
            if (sealedBytes <= 0L || session.collectedEventCount == 0L) {
                target.delete()
                throw t
            }
            LukerDebugTrail.append("native", "cdp-capture state=trace-partial bytes=$sealedBytes file=${target.name}")
            target
        } finally {
            runCatching { traceSink?.close() }
            runCatching { traceSocket?.close() }
            traceSession = null
            traceSocket = null
            traceSink = null
            traceTarget = null
        }
    }

    fun isTraceRecording(): Boolean = traceSession?.isActiveRecording == true

    /**
     * Claims the single heap-snapshot slot. Returns false when a capture is
     * already running, so a second request is refused instead of interleaving
     * writes into the same file.
     */
    fun tryBeginHeapCapture(): Boolean = heapInFlight.compareAndSet(false, true)

    fun endHeapCapture() {
        heapInFlight.set(false)
    }

    /**
     * Finalizes a recording when the renderer exits or the page navigates away.
     * Sends `Tracing.end` if the channel is still live (bounded timeout), or
     * seals the already-streamed partial trace on disk. Deletes the file only
     * when zero events/bytes were captured.
     */
    fun finalizeTrace(): File? = synchronized(traceLock) {
        val session = traceSession ?: return@synchronized null
        val target = traceTarget ?: return@synchronized null
        var saved: File? = null
        try {
            runCatching { session.finish(FINALIZE_WAIT_TIMEOUT_MS) }
            val written = runCatching { session.sealIfOpen() }.getOrDefault(0L)
            if (written > 0L && session.collectedEventCount > 0L) {
                saved = target
                LukerDebugTrail.append("native", "cdp-capture state=trace-finalize bytes=$written events=${session.collectedEventCount} file=${target.name}")
            } else {
                target.delete()
                LukerDebugTrail.append("native", "cdp-capture state=trace-finalize-empty file=${target.name}")
            }
        } finally {
            runCatching { traceSink?.close() }
            runCatching { traceSocket?.close() }
            traceSession = null
            traceSocket = null
            traceSink = null
            traceTarget = null
        }
        saved
    }

    fun abortTrace(): Boolean = finalizeTrace() != null

    private fun pruneOldTraces(dir: File) {
        val traces = dir.listFiles { f ->
            f.isFile && f.name.startsWith("luker-trace-") && f.name.endsWith(".json")
        }?.sortedWith(
            compareByDescending<File> { it.lastModified() }.thenByDescending { it.name },
        ) ?: return
        for (i in RETAINED_TRACE_LIMIT until traces.size) {
            traces[i].delete()
        }
    }
}
