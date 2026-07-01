// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import androidx.annotation.VisibleForTesting
import java.util.concurrent.atomic.AtomicLong

/**
 * Process-wide in-memory ring buffer for debug trail lines.
 *
 * Holds the last 2048 lines (~128 KB typical, ~2 MB worst case). All four
 * frontend signal sources (webconsole, webheap, render, webcrash) and native
 * markers (onRenderProcessGone, process boot, logcat-tail give-up) write
 * here; crash report assembly and the diagnostics-zip exporter read via
 * dumpAll().
 *
 * Writes are sub-microsecond: a single synchronized slot assignment plus
 * AtomicLong increment. Failures are swallowed — never let the trail break
 * the calling site.
 */
object LukerDebugTrail {
    private const val CAPACITY = 2048
    private const val MAX_LINE_CHARS = 1024
    private const val TRUNCATION_SUFFIX = "…[truncated]"

    private val buffer = arrayOfNulls<String>(CAPACITY)
    private val writeIndex = AtomicLong(0L)
    private val lock = Any()

    fun append(category: String, text: String) {
        try {
            val timestamp = System.currentTimeMillis()
            val safeCategory = category.ifBlank { "uncategorized" }
            val line = buildLine(timestamp, safeCategory, text)
            synchronized(lock) {
                val index = writeIndex.getAndIncrement()
                buffer[(index % CAPACITY).toInt()] = line
            }
        } catch (_: Throwable) {
            // Trail must never break the caller.
        }
    }

    fun dumpAll(): String {
        val sb = StringBuilder()
        synchronized(lock) {
            val total = writeIndex.get()
            if (total <= 0L) {
                return ""
            }
            val start = maxOf(0L, total - CAPACITY)
            var i = start
            while (i < total) {
                val line = buffer[(i % CAPACITY).toInt()]
                if (line != null) {
                    sb.append(line).append('\n')
                }
                i++
            }
        }
        return sb.toString()
    }

    private fun buildLine(timestamp: Long, category: String, text: String): String {
        val rawBody = "$timestamp $category $text"
        return if (rawBody.length <= MAX_LINE_CHARS) {
            rawBody
        } else {
            val keep = MAX_LINE_CHARS - TRUNCATION_SUFFIX.length
            rawBody.substring(0, keep) + TRUNCATION_SUFFIX
        }
    }

    @VisibleForTesting
    internal fun resetForTest() {
        synchronized(lock) {
            for (i in 0 until CAPACITY) {
                buffer[i] = null
            }
            writeIndex.set(0L)
        }
    }
}
