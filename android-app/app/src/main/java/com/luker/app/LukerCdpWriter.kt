// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Drains CDP events off a bounded queue, serializes each to one JSONL line,
 * and appends to filesDir/cdp/cdp.current.jsonl with a 2MB rotate to
 * cdp.last.jsonl. Not fsync'd — pagecache is enough for our
 * "recover on next boot" model, and SIGKILL loses at most one 32KB
 * BufferedWriter window.
 *
 * The rotateLock is shared with LukerCdpCollector so that
 * harvestForCrash() and snapshotForExport() can atomically flush and
 * snapshot without racing this writer.
 */
class LukerCdpWriter(
    private val cdpDir: File,
    val rotateLock: Any,
) : Thread("luker-cdp-writer") {
    data class Entry(val pid: Int, val recvMs: Long, val payload: String)

    val queue: ArrayBlockingQueue<Entry> = ArrayBlockingQueue(QUEUE_CAPACITY)

    @Volatile private var stopping = false
    @Volatile private var backpressureLoggedAt = 0L
    // Sticky flag flipped by run()'s outer catch when the drain thread
    // unwinds. Distinct from `writer != null` because the writer field
    // is legitimately nulled during flushAndCloseUnderLock() while the
    // drain thread is still healthy — using `writer != null` as a
    // "drain alive" sentinel would misfire mid-harvest and cause
    // enqueueEvent / harvestForCrash to skip work on a healthy drain.
    @Volatile private var drainCrashed: Boolean = false

    private var currentFile = File(cdpDir, CURRENT_NAME)
    private var lastFile = File(cdpDir, LAST_NAME)
    private var writer: BufferedWriter? = null
    private var currentBytes: Long = 0L

    init { isDaemon = true }

    companion object {
        private const val QUEUE_CAPACITY = 8192
        private const val ROTATE_BYTES: Long = 2L * 1024L * 1024L
        private const val BUFFER_BYTES: Int = 32 * 1024
        const val CURRENT_NAME = "cdp.current.jsonl"
        const val LAST_NAME = "cdp.last.jsonl"
    }

    override fun run() {
        try {
            openWriter()
            while (!stopping) {
                val entry = queue.poll(500, TimeUnit.MILLISECONDS) ?: continue
                writeEntry(entry)
                maybeLogBackpressure()
            }
        } catch (t: Throwable) {
            // Set the sticky drain-crashed flag FIRST so any concurrent
            // enqueueEvent / harvestForCrash observing this via
            // isDrainAlive() gets an accurate answer before we start
            // tearing down the BufferedWriter.
            drainCrashed = true
            LukerDebugTrail.append("native", "cdp-collector state=writer-crashed err=${t.message ?: t.javaClass.simpleName}")
            // Null the writer so enqueueEvent can short-circuit and never
            // block on a dead drain thread. Best-effort close of the
            // BufferedWriter — we don't care about IOException here since
            // the thread is already unwinding.
            runCatching { writer?.close() }
            writer = null
        }
    }

    private fun openWriter() {
        cdpDir.mkdirs()
        writer = BufferedWriter(
            OutputStreamWriter(FileOutputStream(currentFile, /* append = */ true), Charsets.UTF_8),
            BUFFER_BYTES,
        )
        currentBytes = if (currentFile.isFile) currentFile.length() else 0L
    }

    private fun writeEntry(entry: Entry) {
        synchronized(rotateLock) {
            val w = writer ?: return
            val line = buildString {
                append("{\"ts\":").append(entry.recvMs)
                append(",\"pid\":").append(entry.pid)
                append(",\"cdp\":").append(entry.payload)
                append('}').append('\n')
            }
            // Count real UTF-8 bytes for the rotate cap, not UTF-16 code
            // units. String.length would under-count non-ASCII payloads
            // (CDP `Runtime.consoleAPICalled` args often contain CJK) and
            // let the file grow well past ROTATE_BYTES.
            val bytes = line.toByteArray(Charsets.UTF_8)
            w.write(line)
            currentBytes += bytes.size.toLong()
            if (currentBytes >= ROTATE_BYTES) rotate()
        }
    }

    /** Must be called with rotateLock held. */
    private fun rotate() {
        val w = writer ?: return
        w.flush()
        w.close()
        writer = null
        if (lastFile.isFile) lastFile.delete()
        currentFile.renameTo(lastFile)
        openWriter()
    }

    private fun maybeLogBackpressure() {
        if (queue.remainingCapacity() < 100) {
            val now = System.currentTimeMillis()
            if (now - backpressureLoggedAt > 5_000L) {
                LukerDebugTrail.append("native", "cdp-collector state=writer-backpressure remaining=${queue.remainingCapacity()}")
                backpressureLoggedAt = now
            }
        }
    }

    /** Called under rotateLock by LukerCdpCollector.harvestForCrash. */
    fun flushAndCloseUnderLock() {
        writer?.let {
            it.flush()
            it.close()
        }
        writer = null
    }

    /** Called under rotateLock by LukerCdpCollector.harvestForCrash after rename. */
    fun reopenUnderLock() {
        writer = BufferedWriter(
            OutputStreamWriter(FileOutputStream(currentFile, /* append = */ false), Charsets.UTF_8),
            BUFFER_BYTES,
        )
        currentBytes = 0L
    }

    /** Called under rotateLock by LukerCdpCollector.snapshotForExport. */
    fun flushUnderLock(): Long {
        writer?.flush()
        return currentBytes
    }

    fun currentFileForExport(): File = currentFile
    fun lastFileForExport(): File = lastFile

    /**
     * True when the underlying BufferedWriter field is non-null. Note
     * that this goes transiently false during flushAndCloseUnderLock()
     * even while the drain thread is perfectly healthy — callers that
     * want to gate work on "is the drain thread able to consume events"
     * must use isDrainAlive() instead.
     */
    fun hasWriter(): Boolean = writer != null

    /**
     * True until run()'s outer catch flips drainCrashed. Independent of
     * the writer field, so mid-harvest (writer field momentarily null
     * between flushAndCloseUnderLock and reopenUnderLock) still reports
     * true — which is what harvestForCrash and enqueueEvent actually
     * want to know before deciding to skip a reopen or short-circuit an
     * enqueue.
     */
    fun isDrainAlive(): Boolean = !drainCrashed
}
