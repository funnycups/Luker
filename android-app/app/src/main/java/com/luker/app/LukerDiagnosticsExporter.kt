// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

object LukerDiagnosticsExporter {
    private const val FILE_PROVIDER_AUTHORITY_SUFFIX = ".fileprovider"
    private const val EXPORT_DIR_NAME = "diagnostics"
    private const val MAX_BOOTSTRAP_LOG_BYTES = 512 * 1024

    data class ExportResult(val zip: File, val shareUri: Uri, val intent: Intent)

    /**
     * Bundles every diagnostic artifact Luker knows how to find into one zip
     * under `externalFilesDir/diagnostics/`, then returns a share Intent.
     *
     * Contents:
     * - summary.txt: snapshot of `LukerRuntimeManager.collectDiagnostics`
     * - bootstrap.log (last MAX_BOOTSTRAP_LOG_BYTES bytes if larger)
     * - luker-last-jvm-crash.txt, luker-last-crash-report.txt,
     *   luker-last-webview-crash-report.txt, luker-last-native-tombstone.pb
     *   from `filesDir/` (whichever exist)
     * - every `report.*.json` and `*.heapsnapshot` Node wrote to the runtime
     *   root (newest first)
     *
     * Throws on zip failure — callers should propagate, not swallow; the
     * caller dialog is the only signal the user gets.
     */
    fun exportTo(context: Context): ExportResult {
        val exportDir = File(context.getExternalFilesDir(null), EXPORT_DIR_NAME).apply {
            mkdirs()
        }
        val timestamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val zipFile = File(exportDir, "luker-diagnostics-$timestamp.zip")
        val summary = buildSummary(context)

        ZipOutputStream(FileOutputStream(zipFile).buffered()).use { zip ->
            writeEntry(zip, "summary.txt", summary.toByteArray(Charsets.UTF_8))

            val bootstrapLog = LukerRuntimeManager.bootstrapLogFile(context)
            if (bootstrapLog.isFile) {
                writeFileEntry(zip, "bootstrap.log", bootstrapLog, tail = MAX_BOOTSTRAP_LOG_BYTES)
            }

            for (file in collectCrashReportsFromFilesDir(context)) {
                writeFileEntry(zip, "crashes/${file.name}", file)
            }

            for (file in LukerRuntimeManager.listNodeDiagnosticArtifacts(context)) {
                writeFileEntry(zip, "node/${file.name}", file)
            }

            val trail = runCatching { LukerDebugTrail.dumpAll() }.getOrDefault("")
            writeEntry(zip, "debug-trail.txt", trail.toByteArray(Charsets.UTF_8))

            val currentLogcat = LukerLogcatTail.currentLogFile(context)
            if (currentLogcat.isFile) {
                writeFileEntry(zip, "logcat/current.log", currentLogcat)
            }
            val lastLogcat = LukerLogcatTail.lastLogFile(context)
            if (lastLogcat.isFile) {
                writeFileEntry(zip, "logcat/last.log", lastLogcat)
            }
        }

        val authority = context.packageName + FILE_PROVIDER_AUTHORITY_SUFFIX
        val shareUri = FileProvider.getUriForFile(context, authority, zipFile)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, shareUri)
            putExtra(Intent.EXTRA_SUBJECT, "Luker diagnostics ($timestamp)")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return ExportResult(zip = zipFile, shareUri = shareUri, intent = intent)
    }

    private fun buildSummary(context: Context): String {
        val sb = StringBuilder()
        sb.append("Luker diagnostics bundle\n")
        sb.append("generatedAt=").append(
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
        ).append('\n')
        sb.append("device=").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n')
        sb.append("android=").append(Build.VERSION.RELEASE)
            .append(" (sdk=").append(Build.VERSION.SDK_INT).append(")\n")
        sb.append("package=").append(context.packageName).append('\n')
        runCatching {
            val pkg = context.packageManager.getPackageInfo(context.packageName, 0)
            sb.append("versionName=").append(pkg.versionName ?: "<unknown>")
                .append(", versionCode=").append(
                    @Suppress("DEPRECATION") pkg.longVersionCode
                ).append('\n')
        }
        sb.append('\n')
        sb.append("--- runtime diagnostics ---\n")
        runCatching { sb.append(LukerRuntimeManager.collectDiagnostics(context)) }
            .onFailure { sb.append("<failed: ").append(it.message).append('>') }
        return sb.toString()
    }

    private fun collectCrashReportsFromFilesDir(context: Context): List<File> {
        val candidates = listOf(
            "luker-last-jvm-crash.txt",
            "luker-last-crash-report.txt",
            "luker-last-webview-crash-report.txt",
            "luker-last-native-tombstone.pb",
            "luker-runtime-last-error.txt",
            "luker-last-crash-full-report.txt",
        )
        return candidates.mapNotNull { name ->
            val f = File(context.filesDir, name)
            if (f.isFile) f else null
        }
    }

    private fun writeEntry(zip: ZipOutputStream, name: String, bytes: ByteArray) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(bytes)
        zip.closeEntry()
    }

    private fun writeFileEntry(
        zip: ZipOutputStream,
        name: String,
        file: File,
        tail: Int = -1,
    ) {
        zip.putNextEntry(ZipEntry(name))
        FileInputStream(file).use { input ->
            if (tail > 0 && file.length() > tail) {
                val skip = file.length() - tail
                var remaining = skip
                val buf = ByteArray(8192)
                while (remaining > 0) {
                    val toSkip = minOf(remaining, buf.size.toLong())
                    val skipped = input.read(buf, 0, toSkip.toInt())
                    if (skipped <= 0) break
                    remaining -= skipped
                }
            }
            input.copyTo(zip)
        }
        zip.closeEntry()
    }
}
