package com.luker.app

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TarArchiveExtractorTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun buildOctal(value: Long, length: Int): ByteArray {
        val octal = value.coerceAtLeast(0L).toString(8).padStart(length - 1, '0') + "\u0000"
        return octal.toByteArray(StandardCharsets.US_ASCII)
    }

    private fun writeHeader(
        name: String,
        size: Long,
        mtimeSec: Long,
        typeflag: Char,
        prefix: String = "",
    ): ByteArray {
        val header = ByteArray(512)
        val nameBytes = name.toByteArray(StandardCharsets.UTF_8)
        System.arraycopy(nameBytes, 0, header, 0, minOf(100, nameBytes.size))
        System.arraycopy(buildOctal(0b110100100, 8), 0, header, 100, 8)
        System.arraycopy(buildOctal(0, 8), 0, header, 108, 8)
        System.arraycopy(buildOctal(0, 8), 0, header, 116, 8)
        System.arraycopy(buildOctal(size, 12), 0, header, 124, 12)
        System.arraycopy(buildOctal(mtimeSec, 12), 0, header, 136, 12)
        for (i in 148 until 156) header[i] = ' '.code.toByte()
        header[156] = typeflag.code.toByte()
        System.arraycopy("ustar\u0000".toByteArray(StandardCharsets.US_ASCII), 0, header, 257, 6)
        System.arraycopy("00".toByteArray(StandardCharsets.US_ASCII), 0, header, 263, 2)
        val prefixBytes = prefix.toByteArray(StandardCharsets.UTF_8)
        System.arraycopy(prefixBytes, 0, header, 345, minOf(155, prefixBytes.size))

        var checksum = 0L
        for (b in header) checksum += (b.toInt() and 0xFF)
        val chkBytes = checksum.toString(8).padStart(6, '0').toByteArray(StandardCharsets.US_ASCII)
        System.arraycopy(chkBytes, 0, header, 148, 6)
        header[154] = 0
        header[155] = ' '.code.toByte()
        return header
    }

    private fun buildPaxRecord(key: String, value: String): ByteArray {
        val body = "$key=$value\n"
        val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
        var totalLen = bodyBytes.size + 3
        while (true) {
            val prefix = "$totalLen ".toByteArray(StandardCharsets.UTF_8)
            if (prefix.size + bodyBytes.size == totalLen) {
                return prefix + bodyBytes
            }
            totalLen = prefix.size + bodyBytes.size
        }
    }

    private fun buildTarBytes(entries: List<Triple<String, ByteArray?, Long>>): ByteArray {
        val out = ByteArrayOutputStream()
        fun writePadded(data: ByteArray) {
            out.write(data)
            val rem = data.size % 512
            if (rem != 0) {
                out.write(ByteArray(512 - rem))
            }
        }
        for ((path, content, mtimeSec) in entries) {
            val isDir = content == null
            val tarPath = if (isDir && !path.endsWith("/")) "$path/" else path
            val pathBytes = tarPath.toByteArray(StandardCharsets.UTF_8)
            if (pathBytes.size > 100) {
                val pax = buildPaxRecord("path", tarPath)
                out.write(writeHeader("PaxHeader/entry", pax.size.toLong(), mtimeSec, 'x'))
                writePadded(pax)
            }
            val shortName = if (pathBytes.size > 100) String(pathBytes, 0, 100, StandardCharsets.UTF_8) else tarPath
            out.write(writeHeader(shortName, content?.size?.toLong() ?: 0L, mtimeSec, if (isDir) '5' else '0'))
            if (content != null && content.isNotEmpty()) {
                writePadded(content)
            }
        }
        out.write(ByteArray(1024))
        return out.toByteArray()
    }

    @Test fun extractsUstarAndPaxLongPathsResumesAndPrunesExtraneousFiles() {
        val dest = temporary.newFolder("runtime")
        val pluginsTarget = temporary.newFolder("persistent-plugins")
        File(pluginsTarget, "keep.js").writeText("plugin-code")
        Files.createSymbolicLink(File(dest, "_server-plugins").toPath(), pluginsTarget.toPath())
        File(dest, "whitelist.txt").writeText("127.0.0.1")
        File(dest, "obsolete.js").writeText("stale")
        File(dest, "old-dir/nested.txt").apply {
            parentFile!!.mkdirs()
            writeText("stale-nested")
        }

        val longPath = "node_modules/@scope-with-very-long-name/package-with-a-very-long-identifier/dist/deep/nested/subfolder/index.js"
        assertTrue(longPath.length > 100)

        val tarBytes = buildTarBytes(
            listOf(
                Triple("server.js", "console.log('ok');".toByteArray(), 1700000000L),
                Triple("src", null, 1700000000L),
                Triple("src/app.js", "export default 1;".toByteArray(), 1700000005L),
                Triple(longPath, "module.exports = 42;".toByteArray(), 1700000010L),
            )
        )

        val preserve = setOf(".runtime-version", "whitelist.txt", "bootstrap.log", "_server-plugins", "data")
        val stats1 = TarArchiveExtractor.extract(
            ByteArrayInputStream(tarBytes),
            dest,
            tarBytes.size.toLong(),
            preserve,
        )
        assertEquals(3, stats1.copiedFiles)
        assertEquals(0, stats1.skippedFiles)
        assertEquals("console.log('ok');", File(dest, "server.js").readText())
        assertEquals("export default 1;", File(dest, "src/app.js").readText())
        assertEquals("module.exports = 42;", File(dest, longPath).readText())
        assertEquals("127.0.0.1", File(dest, "whitelist.txt").readText())
        assertEquals("plugin-code", File(pluginsTarget, "keep.js").readText())
        assertFalse(File(dest, "obsolete.js").exists())
        assertFalse(File(dest, "old-dir").exists())

        // Second pass skips unchanged files
        val stats2 = TarArchiveExtractor.extract(
            ByteArrayInputStream(tarBytes),
            dest,
            tarBytes.size.toLong(),
            preserve,
        )
        assertEquals(0, stats2.copiedFiles)
        assertEquals(3, stats2.skippedFiles)
    }

    @Test fun rejectsPathTraversalEntries() {
        val dest = temporary.newFolder("runtime-safe")
        val tarBytes = buildTarBytes(
            listOf(
                Triple("../escaped.txt", "evil".toByteArray(), 1700000000L),
            )
        )
        assertThrows(IOException::class.java) {
            TarArchiveExtractor.extract(
                ByteArrayInputStream(tarBytes),
                dest,
                tarBytes.size.toLong(),
                emptySet(),
            )
        }
    }
}
