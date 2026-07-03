// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Owns the three CDP daemon threads. Started once from
 * LukerApplication.onCreate when the "Android debug recording" pref is on
 * (after WebView.setWebContentsDebuggingEnabled(true) has been called).
 * Has no stop() — the process-global static setWebContentsDebuggingEnabled
 * is not reversible, so a running collector matches the WebView state.
 *
 * All internal failures write to LukerDebugTrail; nothing here is allowed
 * to propagate up into the WebView main path.
 */
object LukerCdpCollector {
    private const val TAG = "LukerCdpCollector"
    private const val MAX_CLIENTS = 32
    private const val FAIL_THRESHOLD = 3
    const val CDP_DIR_NAME = "cdp"
    const val CRASH_SNAPSHOT_FILE_NAME = "luker-last-crash-cdp.jsonl"

    private val startedFlag = AtomicBoolean(false)
    val started: Boolean get() = startedFlag.get()

    private val clients = ConcurrentHashMap<Int, LukerCdpClient>()
    private val failedPids = ConcurrentHashMap<Int, Int>()
    private var discovery: LukerCdpDiscovery? = null
    private var writer: LukerCdpWriter? = null
    private lateinit var cdpDir: File
    private val lastDropLogAtMs = AtomicLong(0L)

    val rotateLock: Any = Any()

    fun start(context: Context) {
        if (!startedFlag.compareAndSet(false, true)) return
        try {
            cdpDir = File(context.filesDir, CDP_DIR_NAME).also { it.mkdirs() }
            val w = LukerCdpWriter(cdpDir, rotateLock).also { it.start() }
            writer = w
            val d = LukerCdpDiscovery(this).also { it.start() }
            discovery = d
            LukerDebugTrail.append("native", "cdp-collector state=start")
        } catch (t: Throwable) {
            LukerDebugTrail.append("native", "cdp-collector state=abort-cdp-start err=${t.message ?: t.javaClass.simpleName}")
        }
    }

    fun reconcile(alive: Set<Int>) {
        for (pid in alive) {
            if (clients.containsKey(pid)) continue
            if ((failedPids[pid] ?: 0) >= FAIL_THRESHOLD) continue
            if (clients.size >= MAX_CLIENTS) {
                LukerDebugTrail.append("native", "cdp-collector state=clients-full pid=$pid")
                continue
            }
            val client = LukerCdpClient(pid, this)
            clients[pid] = client
            client.start()
        }
        val dead = clients.keys.filter { it !in alive }
        for (pid in dead) {
            clients.remove(pid)?.requestStop()
            failedPids.remove(pid)
            LukerDebugTrail.append("native", "cdp-collector state=unbind pid=$pid")
        }
        for (pid in failedPids.keys.toList()) {
            if (pid !in alive) {
                failedPids.remove(pid)
            }
        }
    }

    fun markFailedPid(pid: Int) {
        failedPids.merge(pid, 1) { old, _ -> old + 1 }
    }

    fun removeClient(pid: Int) {
        clients.remove(pid)
    }

    fun enqueueEvent(entry: LukerCdpWriter.Entry) {
        val w = writer ?: return
        // Short-circuit if the drain thread crashed. Without this the queue
        // would fill to capacity and then queue.put would have blocked the
        // caller (LukerCdpClient reader thread) forever — offer() below also
        // fixes that, but skipping the offer entirely on a dead writer keeps
        // the queue drainable if the writer is ever restarted. Gate on
        // isDrainAlive() rather than hasWriter() so that events arriving
        // mid-harvest (when the BufferedWriter field is transiently null
        // between flushAndCloseUnderLock and reopenUnderLock) queue up
        // instead of being falsely dropped as a dead-drain signal.
        if (!w.isDrainAlive()) return
        if (!w.queue.offer(entry)) {
            // Queue full: drop this event and emit a rate-limited marker so
            // the debug trail records that we're losing events rather than
            // silently corrupting the timeline. 1000ms floor keeps a burst
            // of drops from filling the trail with duplicates.
            val now = System.currentTimeMillis()
            val prev = lastDropLogAtMs.get()
            if (now - prev > 1_000L && lastDropLogAtMs.compareAndSet(prev, now)) {
                LukerDebugTrail.append("native", "cdp-collector state=writer-dropped queue-full")
            }
        }
    }

    /**
     * Atomically flushes the current ring, renames it to
     * filesDir/luker-last-crash-cdp.jsonl (overwriting any previous file),
     * and reopens a fresh empty current for the writer to keep appending.
     *
     * Called from the main thread inside MainActivity.onRenderProcessGone —
     * worst-case wait is a single BufferedWriter flush (few hundred µs),
     * far below the 5-second ANR threshold.
     *
     * Returns the crash snapshot File, or null on any failure (no ring
     * yet / collector not started / disk error / rename fallback all failed).
     */
    fun harvestForCrash(context: Context): File? {
        if (!startedFlag.get()) return null
        val w = writer ?: return null
        val target = File(context.filesDir, CRASH_SNAPSHOT_FILE_NAME)
        return synchronized(rotateLock) {
            try {
                w.flushAndCloseUnderLock()
                val src = w.currentFileForExport()
                if (target.isFile) target.delete()
                val renamed = src.renameTo(target)
                val finalFile = if (renamed) {
                    target
                } else {
                    runCatching {
                        src.inputStream().use { input ->
                            target.outputStream().use { output -> input.copyTo(output) }
                        }
                        src.delete()
                        target
                    }.getOrElse {
                        LukerDebugTrail.append("native", "cdp-collector state=harvest-copy-fail err=${it.message ?: it.javaClass.simpleName}")
                        null
                    }
                }
                // Only reopen if the drain thread is still alive to
                // consume from the queue. Gate on isDrainAlive() rather
                // than hasWriter() because flushAndCloseUnderLock above
                // legitimately nulls the writer field on a healthy
                // drain — using hasWriter() here would always skip the
                // reopen and permanently silence the ring.
                if (w.isDrainAlive()) {
                    w.reopenUnderLock()
                } else {
                    LukerDebugTrail.append("native", "cdp-collector state=harvest skip-reopen reason=drain-dead")
                }
                LukerDebugTrail.append("native", "cdp-collector state=harvest saved=${finalFile?.name ?: "<none>"}")
                finalFile
            } catch (t: Throwable) {
                LukerDebugTrail.append("native", "cdp-collector state=harvest-fail err=${t.message ?: t.javaClass.simpleName}")
                if (w.isDrainAlive()) {
                    runCatching { w.reopenUnderLock() }.onFailure {
                        LukerDebugTrail.append("native", "cdp-collector state=harvest-reopen-fail err=${it.message ?: it.javaClass.simpleName}")
                    }
                } else {
                    LukerDebugTrail.append("native", "cdp-collector state=harvest skip-reopen reason=drain-dead")
                }
                null
            }
        }
    }

    /**
     * Called by LukerDiagnosticsExporter. Flushes the current ring under
     * rotateLock and returns the current file plus the byte-limit valid at
     * the flush point. Writer keeps appending after we release the lock;
     * exporter must read only the first `bytesLimit` bytes to avoid a
     * partial-line torn read at end.
     *
     * Returns (null, 0) if the collector never started.
     */
    fun snapshotForExport(): Pair<File?, Long> {
        if (!startedFlag.get()) return null to 0L
        val w = writer ?: return null to 0L
        return synchronized(rotateLock) {
            val bytes = w.flushUnderLock()
            w.currentFileForExport() to bytes
        }
    }

    // Return the on-disk paths regardless of drain-thread state — if the
    // writer thread has crashed the ring files still exist and the
    // exporter should surface their real size instead of reporting 0.
    fun currentRingFile(): File? = if (::cdpDir.isInitialized) File(cdpDir, LukerCdpWriter.CURRENT_NAME) else null
    fun lastRingFile(): File? = if (::cdpDir.isInitialized) File(cdpDir, LukerCdpWriter.LAST_NAME) else null
    fun ringDir(): File? = if (::cdpDir.isInitialized) cdpDir else null
}
