// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Detects "the previous launch never reached server-ready" — typically because
 * Node crashed (e.g. OOM from a broken extension) before the WebView could
 * connect to /api/ping. On detection, drops a sentinel at
 * `<dataRoot>/.luker-safe-mode.json` that `src/safe-mode.js` consumes early
 * in `preSetupTasks` to disable every third-party extension across all users.
 *
 * The watchdog uses SharedPreferences as the boot-in-progress flag (cheap,
 * always available, immune to fs corruption) but writes the sentinel onto
 * the same dataRoot the server reads, so the cross-process handoff doesn't
 * need any new RPC.
 *
 * Heuristic for "previous launch died": flag still set AND was written more
 * than [PROBABLE_USER_DISMISS_WINDOW_MS] ago. The window separates real
 * crashes (which usually restart within seconds) from user-initiated swipes
 * from recents (which typically come back much later).
 */
object LukerBootWatchdog {
    private const val TAG = "LukerBootWatchdog"
    private const val PREF_NAME = "luker_boot_watchdog"
    private const val PREF_KEY_IN_PROGRESS_AT = "boot_in_progress_at_millis"
    private const val PREF_KEY_LAST_FAILED_AT = "boot_last_failed_at_millis"
    private const val PREF_KEY_FAILED_STREAK = "boot_failed_streak"
    private const val SENTINEL_FILE_NAME = ".luker-safe-mode.json"

    /**
     * Window after marking boot-in-progress within which a fresh start counts
     * as a crash rather than a user-initiated re-launch. 90 seconds covers
     * the slowest cold boot we expect (asset extraction + Node warmup on
     * a low-end device) plus a small margin.
     */
    private const val PROBABLE_USER_DISMISS_WINDOW_MS = 90_000L

    data class TripResult(val tripped: Boolean, val sentinelPath: String?, val failedStreak: Int)

    /**
     * Call once early in `MainActivity.onCreate`, BEFORE any WebView /
     * runtime starts. Returns whether safe mode was triggered for this
     * launch (so the UI can tell the user).
     */
    fun detectAndArm(context: Context, dataRoot: File): TripResult {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val previousInProgressAt = prefs.getLong(PREF_KEY_IN_PROGRESS_AT, 0L)
        val now = System.currentTimeMillis()
        val sinceLastBoot = if (previousInProgressAt > 0L) now - previousInProgressAt else Long.MAX_VALUE
        val previousStreak = prefs.getInt(PREF_KEY_FAILED_STREAK, 0)

        val tripped = previousInProgressAt > 0L && sinceLastBoot in 0..PROBABLE_USER_DISMISS_WINDOW_MS
        var sentinelPath: String? = null
        var nextStreak = previousStreak

        if (tripped) {
            nextStreak = previousStreak + 1
            sentinelPath = runCatching { writeSentinel(dataRoot, nextStreak, sinceLastBoot) }
                .onFailure { Log.w(TAG, "Failed to write safe-mode sentinel", it) }
                .getOrNull()
            prefs.edit()
                .putLong(PREF_KEY_LAST_FAILED_AT, previousInProgressAt)
                .putInt(PREF_KEY_FAILED_STREAK, nextStreak)
                .apply()
        } else if (previousInProgressAt > 0L) {
            // Flag survived but the gap is longer than a probable crash —
            // user almost certainly swiped from recents. Reset the streak.
            nextStreak = 0
            prefs.edit().putInt(PREF_KEY_FAILED_STREAK, 0).apply()
        }

        prefs.edit()
            .putLong(PREF_KEY_IN_PROGRESS_AT, now)
            .apply()

        return TripResult(tripped = tripped, sentinelPath = sentinelPath, failedStreak = nextStreak)
    }

    /**
     * Call when the server has returned a successful /api/ping. Clears the
     * flag and the streak so subsequent boots start clean.
     */
    fun markBootSucceeded(context: Context) {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit()
            .remove(PREF_KEY_IN_PROGRESS_AT)
            .putInt(PREF_KEY_FAILED_STREAK, 0)
            .apply()
    }

    private fun writeSentinel(dataRoot: File, streak: Int, sinceLastBootMs: Long): String? {
        if (!dataRoot.exists()) {
            dataRoot.mkdirs()
        }
        val sentinel = File(dataRoot, SENTINEL_FILE_NAME)
        val body = buildString {
            append('{')
            append("\"reason\":\"boot-watchdog\",")
            append("\"writtenAt\":\"")
            append(android.text.format.DateFormat.format("yyyy-MM-dd'T'HH:mm:ss.sss", System.currentTimeMillis()))
            append("\",")
            append("\"sinceLastBootMs\":").append(sinceLastBootMs).append(',')
            append("\"failedStreak\":").append(streak)
            append('}')
            append('\n')
        }
        sentinel.writeText(body, Charsets.UTF_8)
        return sentinel.absolutePath
    }
}
