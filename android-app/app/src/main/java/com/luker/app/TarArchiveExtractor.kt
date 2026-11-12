package com.luker.app

import java.io.EOFException
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.LinkOption

internal data class TarExtractionStats(
    val copiedFiles: Int,
    val skippedFiles: Int,
    val prunedEntries: Int,
)

/**
 * Minimal, zero-dependency streaming reader for POSIX USTAR/PAX `.tar` archives.
 *
 * Designed for `LukerRuntimeManager`:
 * - Streams sequentially in a single pass with a 64 KB buffer instead of
 *   scanning APK assets directory-by-directory via `AssetManager.list()`.
 * - Skips regular files already present on disk with matching byte length and
 *   mtime (seconds), so an interrupted extraction resumes where it left off.
 * - Prunes obsolete files/directories not present in the archive manifest
 *   while preserving runtime-local entries (`.runtime-version`, `whitelist.txt`,
 *   `bootstrap.log`, `_server-plugins`, `data`) and never following symlinks.
 */
internal object TarArchiveExtractor {
    private const val BLOCK_SIZE = 512
    private const val IO_BUFFER_SIZE = 64 * 1024
    private const val PROGRESS_REPORT_STEP_BYTES = 256 * 1024L

    fun extract(
        input: InputStream,
        destinationRoot: File,
        totalBytes: Long = 0L,
        preserveRootEntries: Set<String> = emptySet(),
        onProgress: ((Long, Long) -> Unit)? = null,
    ): TarExtractionStats {
        if (!destinationRoot.exists() && !destinationRoot.mkdirs()) {
            throw IOException("Failed to create destination directory: ${destinationRoot.absolutePath}")
        }

        val header = ByteArray(BLOCK_SIZE)
        val ioBuffer = ByteArray(IO_BUFFER_SIZE)
        val manifestPaths = HashSet<String>(32_768)
        var pendingPaxPath: String? = null
        var copiedFiles = 0
        var skippedFiles = 0
        var processedBytes = 0L
        var lastReportedBytes = -PROGRESS_REPORT_STEP_BYTES

        fun maybeReportProgress(force: Boolean = false) {
            if (onProgress == null || totalBytes <= 0L) return
            if (force || processedBytes - lastReportedBytes >= PROGRESS_REPORT_STEP_BYTES) {
                lastReportedBytes = processedBytes
                onProgress(processedBytes.coerceAtMost(totalBytes), totalBytes)
            }
        }

        maybeReportProgress(force = true)

        while (true) {
            val readHeader = readFullyOrEof(input, header, BLOCK_SIZE)
            if (readHeader == 0) {
                break
            }
            if (readHeader < BLOCK_SIZE) {
                throw EOFException("Truncated tar header ($readHeader bytes)")
            }
            processedBytes += BLOCK_SIZE

            if (isAllZeroBlock(header)) {
                break
            }

            val size = parseOctal(header, 124, 12)
            val mtimeSec = parseOctal(header, 136, 12)
            val typeflag = header[156].toInt().toChar()

            if (typeflag == 'x' || typeflag == 'g') {
                val payload = readPayloadBytes(input, size)
                processedBytes += paddedSize(size)
                if (typeflag == 'x') {
                    parsePaxPath(payload)?.let { pendingPaxPath = it }
                }
                continue
            }

            if (typeflag == 'L') {
                val payload = readPayloadBytes(input, size)
                processedBytes += paddedSize(size)
                val end = payload.indexOf(0.toByte()).let { if (it >= 0) it else payload.size }
                pendingPaxPath = String(payload, 0, end, StandardCharsets.UTF_8)
                continue
            }

            val rawPath = pendingPaxPath ?: extractUstarPath(header)
            pendingPaxPath = null

            val isDirectory = typeflag == '5' || rawPath.endsWith("/")
            val normalizedRelPath = normalizeSafeRelativePath(rawPath)
            if (normalizedRelPath.isEmpty()) {
                skipAlignedPayload(input, size, ioBuffer)
                processedBytes += paddedSize(size)
                continue
            }

            recordPathAndAncestors(normalizedRelPath, manifestPaths)
            val targetFile = File(destinationRoot, normalizedRelPath)

            if (isDirectory) {
                ensureDirectory(targetFile)
                skipAlignedPayload(input, size, ioBuffer)
                processedBytes += paddedSize(size)
                maybeReportProgress()
                continue
            }

            if (typeflag == '0' || typeflag == '\u0000') {
                val parent = targetFile.parentFile
                if (parent != null) {
                    ensureDirectory(parent)
                }

                if (isAlreadyExtracted(targetFile, size, mtimeSec)) {
                    skipAlignedPayload(input, size, ioBuffer)
                    processedBytes += paddedSize(size)
                    skippedFiles += 1
                    maybeReportProgress()
                    continue
                }

                deleteEntryNoFollow(targetFile)
                FileOutputStream(targetFile).use { output ->
                    var remaining = size
                    while (remaining > 0L) {
                        val toRead = minOf(remaining, ioBuffer.size.toLong()).toInt()
                        val n = input.read(ioBuffer, 0, toRead)
                        if (n < 0) {
                            throw EOFException("Unexpected EOF while extracting $normalizedRelPath")
                        }
                        output.write(ioBuffer, 0, n)
                        remaining -= n.toLong()
                    }
                }
                val padding = paddingBytes(size)
                if (padding > 0) {
                    skipExact(input, padding.toLong(), ioBuffer)
                }
                if (mtimeSec > 0L) {
                    targetFile.setLastModified(mtimeSec * 1000L)
                }
                processedBytes += paddedSize(size)
                copiedFiles += 1
                maybeReportProgress()
            } else {
                skipAlignedPayload(input, size, ioBuffer)
                processedBytes += paddedSize(size)
                maybeReportProgress()
            }
        }

        val pruned = pruneExtraneous(destinationRoot, "", manifestPaths, preserveRootEntries)
        if (totalBytes > 0L) {
            processedBytes = totalBytes
            maybeReportProgress(force = true)
        }

        return TarExtractionStats(
            copiedFiles = copiedFiles,
            skippedFiles = skippedFiles,
            prunedEntries = pruned,
        )
    }

    private fun isAlreadyExtracted(file: File, expectedSize: Long, expectedMtimeSec: Long): Boolean {
        val path = file.toPath()
        if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            return false
        }
        if (file.length() != expectedSize) {
            return false
        }
        if (expectedMtimeSec > 0L && (file.lastModified() / 1000L) != expectedMtimeSec) {
            return false
        }
        return true
    }

    private fun ensureDirectory(dir: File) {
        val path = dir.toPath()
        if (Files.isSymbolicLink(path) || (Files.exists(path, LinkOption.NOFOLLOW_LINKS) && !dir.isDirectory)) {
            Files.delete(path)
        }
        if (!dir.exists() && !dir.mkdirs() && !dir.isDirectory) {
            throw IOException("Failed to create directory: ${dir.absolutePath}")
        }
    }

    private fun deleteEntryNoFollow(target: File) {
        val path = target.toPath()
        if (Files.isSymbolicLink(path)) {
            Files.delete(path)
            return
        }
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return
        }
        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            val children = target.listFiles() ?: emptyArray()
            for (child in children) {
                deleteEntryNoFollow(child)
            }
        }
        Files.deleteIfExists(path)
    }

    private fun pruneExtraneous(
        currentDir: File,
        relativePrefix: String,
        manifestPaths: Set<String>,
        preserveRootEntries: Set<String>,
    ): Int {
        val children = currentDir.listFiles() ?: return 0
        var pruned = 0
        for (child in children) {
            val name = child.name
            if (relativePrefix.isEmpty() && preserveRootEntries.contains(name)) {
                continue
            }
            val relPath = if (relativePrefix.isEmpty()) name else "$relativePrefix/$name"
            if (!manifestPaths.contains(relPath)) {
                deleteEntryNoFollow(child)
                pruned += 1
                continue
            }
            val childPath = child.toPath()
            if (!Files.isSymbolicLink(childPath) && Files.isDirectory(childPath, LinkOption.NOFOLLOW_LINKS)) {
                pruned += pruneExtraneous(child, relPath, manifestPaths, preserveRootEntries)
            }
        }
        return pruned
    }

    private fun recordPathAndAncestors(normalizedRelPath: String, manifestPaths: MutableSet<String>) {
        var current = normalizedRelPath
        while (current.isNotEmpty()) {
            if (!manifestPaths.add(current)) {
                break
            }
            val slash = current.lastIndexOf('/')
            current = if (slash > 0) current.substring(0, slash) else ""
        }
    }

    private fun normalizeSafeRelativePath(rawPath: String): String {
        val trimmed = rawPath.trim('/').replace('\\', '/')
        if (trimmed.isEmpty() || trimmed == ".") {
            return ""
        }
        if (rawPath.startsWith("/") || rawPath.startsWith("\\")) {
            throw IOException("Absolute tar entry path is not allowed: $rawPath")
        }
        val segments = ArrayList<String>()
        for (part in trimmed.split('/')) {
            if (part.isEmpty() || part == ".") {
                continue
            }
            if (part == "..") {
                throw IOException("Tar entry path traversal is not allowed: $rawPath")
            }
            segments.add(part)
        }
        return segments.joinToString("/")
    }

    private fun extractUstarPath(header: ByteArray): String {
        val name = readNullTerminatedString(header, 0, 100)
        val prefix = readNullTerminatedString(header, 345, 155)
        return if (prefix.isNotEmpty()) "$prefix/$name" else name
    }

    private fun readNullTerminatedString(buffer: ByteArray, offset: Int, maxLen: Int): String {
        var end = offset
        val limit = offset + maxLen
        while (end < limit && buffer[end] != 0.toByte()) {
            end += 1
        }
        return String(buffer, offset, end - offset, StandardCharsets.UTF_8)
    }

    private fun parseOctal(buffer: ByteArray, offset: Int, length: Int): Long {
        var start = offset
        val end = offset + length
        while (start < end && (buffer[start] == 0.toByte() || buffer[start] == ' '.code.toByte())) {
            start += 1
        }
        var value = 0L
        for (i in start until end) {
            val b = buffer[i].toInt().toChar()
            if (b == '\u0000' || b == ' ') break
            if (b < '0' || b > '7') {
                throw IOException("Invalid octal digit '$b' in tar header")
            }
            value = (value shl 3) or (b - '0').toLong()
        }
        return value
    }

    private fun parsePaxPath(payload: ByteArray): String? {
        val text = String(payload, StandardCharsets.UTF_8)
        var index = 0
        while (index < text.length) {
            val spaceIdx = text.indexOf(' ', index)
            if (spaceIdx <= index) break
            val recordLen = text.substring(index, spaceIdx).toIntOrNull() ?: break
            if (recordLen <= 0) break
            val recordBytes = payload.copyOfRange(
                text.substring(0, index).toByteArray(StandardCharsets.UTF_8).size,
                minOf(
                    payload.size,
                    text.substring(0, index).toByteArray(StandardCharsets.UTF_8).size + recordLen,
                ),
            )
            val recordStr = String(recordBytes, StandardCharsets.UTF_8)
            val spaceInRec = recordStr.indexOf(' ')
            if (spaceInRec > 0) {
                val kv = recordStr.substring(spaceInRec + 1).trimEnd('\n')
                val eq = kv.indexOf('=')
                if (eq > 0 && kv.substring(0, eq) == "path") {
                    return kv.substring(eq + 1)
                }
            }
            index += recordStr.length
        }
        return null
    }

    private fun isAllZeroBlock(block: ByteArray): Boolean {
        for (b in block) {
            if (b != 0.toByte()) return false
        }
        return true
    }

    private fun paddingBytes(size: Long): Int {
        val rem = (size % BLOCK_SIZE).toInt()
        return if (rem == 0) 0 else BLOCK_SIZE - rem
    }

    private fun paddedSize(size: Long): Long = size + paddingBytes(size).toLong()

    private fun readPayloadBytes(input: InputStream, size: Long): ByteArray {
        if (size > 16 * 1024 * 1024L) {
            throw IOException("Metadata tar payload too large: $size")
        }
        val data = ByteArray(size.toInt())
        var offset = 0
        while (offset < data.size) {
            val n = input.read(data, offset, data.size - offset)
            if (n < 0) throw EOFException("Unexpected EOF in tar metadata payload")
            offset += n
        }
        val pad = paddingBytes(size)
        if (pad > 0) {
            skipExact(input, pad.toLong(), ByteArray(pad))
        }
        return data
    }

    private fun skipAlignedPayload(input: InputStream, size: Long, scratch: ByteArray) {
        val totalToSkip = paddedSize(size)
        if (totalToSkip > 0L) {
            skipExact(input, totalToSkip, scratch)
        }
    }

    private fun skipExact(input: InputStream, bytesToSkip: Long, scratch: ByteArray) {
        var remaining = bytesToSkip
        while (remaining > 0L) {
            val skipped = input.skip(remaining)
            if (skipped > 0L) {
                remaining -= skipped
                continue
            }
            val toRead = minOf(remaining, scratch.size.toLong()).toInt()
            val n = input.read(scratch, 0, toRead)
            if (n < 0) {
                throw EOFException("Unexpected EOF while skipping tar payload ($remaining bytes left)")
            }
            remaining -= n.toLong()
        }
    }

    private fun readFullyOrEof(input: InputStream, buffer: ByteArray, length: Int): Int {
        var offset = 0
        while (offset < length) {
            val n = input.read(buffer, offset, length - offset)
            if (n < 0) {
                return offset
            }
            offset += n
        }
        return offset
    }
}
