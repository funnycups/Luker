package com.luker.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, assetDir = "runtime-assets")
class ServerPluginRuntimeLifecycleTest {
    @Test fun runtimePreparationPreservesPluginsOnRestartAndRefresh() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val assetsPath = File(javaClass.classLoader!!.getResource("runtime-assets")!!.toURI())
        val assetArchive = File(context.cacheDir, "runtime-assets.apk")
        ZipOutputStream(assetArchive.outputStream()).use { zip ->
            assetsPath.walkTopDown().filter { it.isFile }.forEach { file ->
                zip.putNextEntry(ZipEntry("assets/" + file.relativeTo(assetsPath).invariantSeparatorsPath))
                zip.write(file.readBytes())
                zip.closeEntry()
            }
        }
        val isolatedAssets = android.content.res.AssetManager::class.java.getDeclaredConstructor().apply {
            isAccessible = true
        }.newInstance()
        isolatedAssets.javaClass.getMethod("addAssetPath", String::class.java)
            .invoke(isolatedAssets, assetArchive.absolutePath)
        val runtime = File(context.filesDir, "luker-runtime")
        val plugins = File(context.getExternalFilesDir(null), "luker-data/plugins")
        val entry = File(plugins, "demo/index.js")
        entry.parentFile!!.mkdirs()
        entry.writeText("persistent-plugin")
        try {
            LukerRuntimeManager.prepareRuntime(context, isolatedAssets, null)
            LukerRuntimeManager.prepareRuntime(context, isolatedAssets, null)
            assertEquals("persistent-plugin", entry.readText())
            File(runtime, ".runtime-version").writeText("old-version")
            File(runtime, "obsolete").writeText("old")
            LukerRuntimeManager.prepareRuntime(context, isolatedAssets, null)
            assertFalse(File(runtime, "obsolete").exists())
            assertEquals("persistent-plugin", entry.readText())
            assertTrue(Files.isSymbolicLink(File(runtime, "_server-plugins").toPath()))
            assertEquals(plugins.canonicalFile, File(runtime, "_server-plugins").canonicalFile)
        } finally {
            ServerPluginRuntime.detach(runtime)
        }
    }

    @Test fun tarBundleRuntimePreparationExtractsResumesAndPreservesPlugins() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val tarOut = java.io.ByteArrayOutputStream()
        fun writeHeader(name: String, size: Long): ByteArray {
            val h = ByteArray(512)
            val nb = name.toByteArray()
            System.arraycopy(nb, 0, h, 0, nb.size)
            val mode = "0000644\u0000".toByteArray()
            System.arraycopy(mode, 0, h, 100, mode.size)
            val sz = (size.toString(8).padStart(11, '0') + "\u0000").toByteArray()
            System.arraycopy(sz, 0, h, 124, sz.size)
            val mt = ("1700000000".toLong().toString(8).padStart(11, '0') + "\u0000").toByteArray()
            System.arraycopy(mt, 0, h, 136, mt.size)
            for (i in 148 until 156) h[i] = ' '.code.toByte()
            h[156] = '0'.code.toByte()
            System.arraycopy("ustar\u000000".toByteArray(), 0, h, 257, 8)
            var sum = 0L
            for (b in h) sum += (b.toInt() and 0xFF)
            val chk = sum.toString(8).padStart(6, '0').toByteArray()
            System.arraycopy(chk, 0, h, 148, 6)
            h[154] = 0
            h[155] = ' '.code.toByte()
            return h
        }
        for ((name, body) in listOf("server.js" to "export default 1;", "bootstrap.js" to "import './server.js';")) {
            val bytes = body.toByteArray()
            tarOut.write(writeHeader(name, bytes.size.toLong()))
            tarOut.write(bytes)
            val rem = bytes.size % 512
            if (rem != 0) tarOut.write(ByteArray(512 - rem))
        }
        tarOut.write(ByteArray(1024))

        val assetArchive = File(context.cacheDir, "runtime-tar-assets.apk")
        ZipOutputStream(assetArchive.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("assets/runtime-tree-version.txt"))
            zip.write("sha256-testtarversion\n".toByteArray())
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("assets/runtime-bundle.tar"))
            zip.write(tarOut.toByteArray())
            zip.closeEntry()
        }
        val isolatedAssets = android.content.res.AssetManager::class.java.getDeclaredConstructor().apply {
            isAccessible = true
        }.newInstance()
        isolatedAssets.javaClass.getMethod("addAssetPath", String::class.java)
            .invoke(isolatedAssets, assetArchive.absolutePath)

        val runtime = File(context.filesDir, "luker-runtime")
        val plugins = File(context.getExternalFilesDir(null), "luker-data/plugins")
        val entry = File(plugins, "demo/index.js")
        entry.parentFile!!.mkdirs()
        entry.writeText("persistent-plugin-from-tar")
        try {
            File(runtime, ".runtime-version").apply {
                parentFile?.mkdirs()
                writeText("stale-marker")
            }
            File(runtime, "stale-file.txt").writeText("remove-me")
            LukerRuntimeManager.prepareRuntime(context, isolatedAssets, null)
            assertEquals("export default 1;", File(runtime, "server.js").readText())
            assertEquals("layout=5;tree=sha256-testtarversion", File(runtime, ".runtime-version").readText())
            assertFalse(File(runtime, "stale-file.txt").exists())
            assertEquals("persistent-plugin-from-tar", entry.readText())
            assertTrue(Files.isSymbolicLink(File(runtime, "_server-plugins").toPath()))
        } finally {
            ServerPluginRuntime.detach(runtime)
        }
    }
}
