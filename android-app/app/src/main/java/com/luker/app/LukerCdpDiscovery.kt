// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.os.Process
import java.io.File

/**
 * Polls /proc/net/unix every 500ms for @webview_devtools_remote_<pid>
 * entries owned by our uid, then reconciles the resulting set against
 * the collector's clients map. Simpler and more reliable than inotify
 * on procfs (which is unsupported on many kernels).
 *
 * Gives up after 20 consecutive read errors — likely means procfs is
 * inaccessible in this environment and retrying is pointless.
 */
class LukerCdpDiscovery(
    private val collector: LukerCdpCollector,
) : Thread("luker-cdp-discovery") {

    @Volatile var stopping = false

    init { isDaemon = true }

    companion object {
        private const val POLL_INTERVAL_MS = 500L
        private const val MAX_ERRORS = 20
        private val SOCKET_LINE_RE = Regex("@webview_devtools_remote_(\\d+)$")
    }

    override fun run() {
        var errors = 0
        val myUid = Process.myUid()
        while (!stopping) {
            try {
                val alive = scanAlivePids(myUid)
                collector.reconcile(alive)
                errors = 0
            } catch (t: Throwable) {
                errors++
                if (errors >= MAX_ERRORS) {
                    LukerDebugTrail.append("native", "cdp-collector state=discovery-give-up err=${t.message ?: t.javaClass.simpleName}")
                    return
                }
            }
            try { sleep(POLL_INTERVAL_MS) } catch (_: InterruptedException) { return }
        }
    }

    private fun scanAlivePids(myUid: Int): Set<Int> {
        val alive = HashSet<Int>()
        val text = File("/proc/net/unix").readText(Charsets.US_ASCII)
        for (line in text.lineSequence()) {
            val trimmed = line.trim()
            val last = trimmed.substringAfterLast(' ')
            val m = SOCKET_LINE_RE.matchEntire(last) ?: continue
            val pid = m.groupValues[1].toIntOrNull() ?: continue
            if (readUidOfPid(pid) != myUid) continue
            alive.add(pid)
        }
        return alive
    }

    private fun readUidOfPid(pid: Int): Int? {
        return try {
            val text = File("/proc/$pid/status").readText(Charsets.US_ASCII)
            val uidLine = text.lineSequence().firstOrNull { it.startsWith("Uid:") } ?: return null
            uidLine.substringAfter("Uid:").trim().split(Regex("\\s+")).firstOrNull()?.toIntOrNull()
        } catch (_: Throwable) {
            null
        }
    }
}
