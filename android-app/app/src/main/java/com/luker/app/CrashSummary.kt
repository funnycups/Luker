// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

/**
 * Extracts the small set of "at-a-glance" fields from an enriched crash
 * report body for display in the crash dialog. The full report (including
 * debug-trail, logcat tail, and CDP snapshot path) is written to disk and
 * offered as an export attachment; the dialog itself only shows this
 * summary to keep it thumb-scrollable on a phone.
 *
 * Behavior:
 * - Scans key=value lines. Ignores lines without `=` or with a leading `=`.
 * - Keeps only the whitelisted keys, in whitelist order.
 * - Keeps the first occurrence of a duplicate key.
 * - Preserves `=` in the value verbatim (query strings, base64, etc.).
 * - Returns a "<no structured fields found in crash report>" sentinel when
 *   nothing matched, so the dialog never renders an empty body.
 */
private val CRASH_SUMMARY_FIELDS = listOf(
    "source",
    "when",
    "didCrash",
    "rendererPriorityAtExit",
    "url",
    "device",
    "android",
    "reason",
    "importance",
    "pid",
    "processName",
)

fun buildCrashSummary(crashReport: String): String {
    val kept = LinkedHashMap<String, String>()
    for (line in crashReport.lineSequence()) {
        val eq = line.indexOf('=')
        if (eq <= 0) continue
        val key = line.substring(0, eq).trim()
        if (key in CRASH_SUMMARY_FIELDS && key !in kept) {
            kept[key] = line.substring(eq + 1).trim()
        }
    }
    if (kept.isEmpty()) return "<no structured fields found in crash report>"
    return CRASH_SUMMARY_FIELDS
        .asSequence()
        .filter { it in kept }
        .joinToString(separator = "\n") { "$it=${kept[it]}" }
}
