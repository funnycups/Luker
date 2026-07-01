// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.io.OutputStream

/**
 * On-demand daemon thread that streams `logcat --uid=<self>` (or `--pid=$$`
 * fallback for old OEM kernels) into rotating files in `filesDir`. Files cap
 * at 256 KB; when current overflows, it is moved to `logcat.last`
 * (overwriting), and a new `logcat.current` is opened.
 *
 * setEnabled is idempotent and survives crashes via LukerAndroidDebugConfig.
 * On unexpected daemon death we retry up to 3 times, then give up and write
 * a marker to LukerDebugTrail.
 */
object LukerLogcatTail {
    private const val TAG = "LukerLogcatTail"
    private const val CURRENT_FILE_NAME = "logcat.current"
    private const val LAST_FILE_NAME = "logcat.last"
    private const val FILE_CAP_BYTES = 256 * 1024L
    private const val MAX_RESTARTS = 3
    private const val RESTART_DELAY_MS = 5_000L

    @Volatile
    private var daemon: Thread? = null

    @Volatile
    private var process: Process? = null

    @Volatile
    private var stopRequested = false

    fun currentLogFile(context: Context): File = File(context.filesDir, CURRENT_FILE_NAME)
    fun lastLogFile(context: Context): File = File(context.filesDir, LAST_FILE_NAME)

    @Synchronized
    fun setEnabled(context: Context, on: Boolean) {
        if (on) {
            if (daemon?.isAlive == true) return
            stopRequested = false
            val appContext = context.applicationContext
            daemon = Thread({ runDaemonLoop(appContext) }, "LukerLogcatTail").apply {
                isDaemon = true
                start()
            }
        } else {
            stopRequested = true
            runCatching { process?.destroy() }
            process = null
            runCatching { daemon?.interrupt() }
            daemon = null
        }
    }

    private fun runDaemonLoop(context: Context) {
        var restarts = 0
        while (!stopRequested) {
            val giveUpReason: String? = try {
                streamOnce(context)
                null
            } catch (t: Throwable) {
                Log.w(TAG, "logcat tail iteration failed", t)
                t.javaClass.simpleName + ": " + (t.message ?: "")
            }

            if (stopRequested) return

            restarts++
            if (restarts > MAX_RESTARTS) {
                LukerDebugTrail.append(
                    "native",
                    "logcat-tail-give-up reason=${giveUpReason ?: "unknown"} after $restarts attempts",
                )
                return
            }

            try {
                Thread.sleep(RESTART_DELAY_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun streamOnce(context: Context) {
        val current = currentLogFile(context)
        val last = lastLogFile(context)
        val process = startLogcatProcess()
        this.process = process

        BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
            var output: OutputStream = openAppending(current)
            var writtenToCurrent = current.length()
            try {
                while (!stopRequested) {
                    val line = reader.readLine() ?: break
                    val bytes = (line + "\n").toByteArray()
                    output.write(bytes)
                    writtenToCurrent += bytes.size
                    if (writtenToCurrent >= FILE_CAP_BYTES) {
                        output.flush()
                        output.close()
                        rotateForTest(current, last)
                        output = openAppending(current)
                        writtenToCurrent = 0L
                    }
                }
            } finally {
                runCatching { output.flush() }
                runCatching { output.close() }
            }
        }
    }

    private fun startLogcatProcess(): Process {
        val uid = android.os.Process.myUid()
        val cmd = arrayOf("logcat", "-v", "threadtime", "--uid=$uid")
        return try {
            Runtime.getRuntime().exec(cmd)
        } catch (t: Throwable) {
            // Some old OEM kernels reject --uid; fall back to PID filter.
            Log.w(TAG, "logcat --uid failed, falling back to --pid", t)
            Runtime.getRuntime().exec(arrayOf("logcat", "-v", "threadtime", "--pid=${android.os.Process.myPid()}"))
        }
    }

    private fun openAppending(file: File): OutputStream {
        file.parentFile?.mkdirs()
        return FileOutputStream(file, true)
    }

    @VisibleForTesting
    internal fun rotateForTest(current: File, last: File) {
        if (!current.exists()) return
        if (last.exists()) last.delete()
        current.renameTo(last)
    }
}
