// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object LukerCrashCapture {
    private const val TAG = "LukerCrashCapture"
    private const val PREF_NAME = "luker_crash_capture"
    private const val PREF_KEY_LAST_TIMESTAMP = "last_handled_exit_timestamp"
    private const val REPORT_FILE_NAME = "luker-last-crash-report.txt"
    private const val MAX_HISTORY_LOOKUP = 16

    data class CapturedCrash(
        val report: String,
        val reportFile: File?,
        val timestamp: Long,
    )

    fun pollUnhandledCrash(context: Context): CapturedCrash? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null
        }
        return try {
            collectAbnormalExit(context)
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read ApplicationExitInfo history", t)
            null
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun collectAbnormalExit(context: Context): CapturedCrash? {
        val activityManager = context.getSystemService(ActivityManager::class.java) ?: return null
        val history = activityManager.getHistoricalProcessExitReasons(
            context.packageName,
            0,
            MAX_HISTORY_LOOKUP,
        )
        if (history.isEmpty()) {
            return null
        }

        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val lastHandled = prefs.getLong(PREF_KEY_LAST_TIMESTAMP, 0L)

        val candidate = history.firstOrNull { isAbnormalExit(it.reason) } ?: return null
        if (candidate.timestamp <= lastHandled) {
            return null
        }

        val report = formatExitInfo(candidate)
        val reportFile = runCatching { persistReport(context, report) }.getOrNull()
        prefs.edit().putLong(PREF_KEY_LAST_TIMESTAMP, candidate.timestamp).apply()
        return CapturedCrash(report = report, reportFile = reportFile, timestamp = candidate.timestamp)
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun isAbnormalExit(reason: Int): Boolean = when (reason) {
        ApplicationExitInfo.REASON_CRASH,
        ApplicationExitInfo.REASON_CRASH_NATIVE,
        ApplicationExitInfo.REASON_ANR,
        ApplicationExitInfo.REASON_LOW_MEMORY,
        ApplicationExitInfo.REASON_DEPENDENCY_DIED,
        ApplicationExitInfo.REASON_SIGNALED,
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE,
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> true
        else -> false
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun formatExitInfo(info: ApplicationExitInfo): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
        val sb = StringBuilder()
        sb.append("when=").append(formatter.format(Date(info.timestamp))).append('\n')
        sb.append("reason=").append(reasonName(info.reason))
            .append(" (").append(info.reason).append(")\n")
        sb.append("description=").append(info.description?.ifBlank { "<none>" } ?: "<none>").append('\n')
        sb.append("importance=").append(importanceName(info.importance))
            .append(" (").append(info.importance).append(")\n")
        sb.append("status=").append(info.status).append('\n')
        sb.append("pss=").append(info.pss).append(" KB\n")
        sb.append("rss=").append(info.rss).append(" KB\n")
        sb.append("pid=").append(info.pid).append('\n')
        sb.append("processName=").append(info.processName ?: "<unknown>").append('\n')
        sb.append("device=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
        sb.append("android=").append(Build.VERSION.RELEASE)
            .append(" (sdk=").append(Build.VERSION.SDK_INT).append(")\n")

        val trace = readTrace(info)
        if (!trace.isNullOrBlank()) {
            sb.append("\ntrace:\n").append(trace)
        } else {
            sb.append("\ntrace: <not available for this reason>")
        }
        return sb.toString()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun readTrace(info: ApplicationExitInfo): String? {
        return runCatching {
            info.traceInputStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        }.getOrNull()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_UNKNOWN -> "UNKNOWN"
        ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
        ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
        ApplicationExitInfo.REASON_CRASH -> "CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
        ApplicationExitInfo.REASON_ANR -> "ANR"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
        ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
        ApplicationExitInfo.REASON_OTHER -> "OTHER"
        else -> "REASON_$reason"
    }

    private fun importanceName(importance: Int): String = when (importance) {
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND -> "FOREGROUND"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND_SERVICE -> "FOREGROUND_SERVICE"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE -> "VISIBLE"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE -> "PERCEPTIBLE"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_SERVICE -> "SERVICE"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_CACHED -> "CACHED"
        ActivityManager.RunningAppProcessInfo.IMPORTANCE_GONE -> "GONE"
        else -> "OTHER_$importance"
    }

    private fun persistReport(context: Context, report: String): File {
        val file = File(context.filesDir, REPORT_FILE_NAME)
        file.writeText(report, Charsets.UTF_8)
        return file
    }
}
