package com.luker.app

import android.content.Context
import android.content.res.AssetManager
import android.net.Uri
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.lang.Exception
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

object LukerRuntimeManager {
    private const val TAG = "LukerRuntime"
    private const val DEFAULT_SERVER_PORT = 8000
    private const val MAX_PORT_PROBE_ATTEMPTS = 50
    private val started = AtomicBoolean(false)
    private val librariesLoaded = AtomicBoolean(false)
    private const val RUNTIME_LAYOUT_VERSION = "3"
    private const val RUNTIME_MARKER = ".runtime-version"
    private const val RUNTIME_DIR_NAME = "luker-runtime"
    private const val PERSISTENT_DATA_DIR_NAME = "luker-data"
    private const val CONFIG_FILE_NAME = "config.yaml"
    private const val RUNTIME_PERSIST_DIR_NAME = "_runtime-persist"
    private const val SERVER_PLUGINS_DIR_NAME = "plugins"
    private const val GLOBAL_EXTENSIONS_RELATIVE_PATH = "extensions/third-party"
    private const val NODE_SCRIPT_PATH = "nodejs-project/bootstrap.js"
    private const val NODE_PROJECT_ASSET_PATH = "luker"
    private const val BOOTSTRAP_LOG_FILE = "bootstrap.log"
    private val RUNTIME_PERSIST_RELATIVE_PATHS = listOf(
        "whitelist.txt",
    )

    @Volatile
    private var serverPort: Int = DEFAULT_SERVER_PORT
    val SERVER_URL: String
        get() = "http://127.0.0.1:$serverPort"

    fun isSameOriginUrl(uri: Uri?): Boolean {
        if (uri == null) return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "http") return false
        val host = uri.host ?: return false
        if (host != "127.0.0.1") return false
        val port = uri.port
        if (port == -1) return false
        return port == serverPort
    }

    @Volatile
    private var runtimeDir: File? = null
    @Volatile
    private var dataRootDir: File? = null
    @Volatile
    private var pingFailures: Int = 0

    data class StartResult(val ok: Boolean, val error: String? = null)
    private data class RuntimePaths(
        val runtimeRoot: File,
        val dataRoot: File,
        val serverPluginsRoot: File,
        val globalExtensionsRoot: File,
    )

    @JvmStatic
    external fun startNodeWithArguments(arguments: Array<String>): Int
    @JvmStatic
    external fun isNodeProcessRunning(): Boolean

    private fun ensureLibrariesLoaded(context: Context): StartResult {
        if (librariesLoaded.get()) {
            return StartResult(ok = true)
        }
        synchronized(this) {
            if (librariesLoaded.get()) {
                return StartResult(ok = true)
            }
            return try {
                System.loadLibrary("node")
                System.loadLibrary("native-lib")
                librariesLoaded.set(true)
                StartResult(ok = true)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to load native libraries", t)
                val detail = t.message ?: context.getString(R.string.runtime_failure_reason_unknown_error)
                StartResult(
                    ok = false,
                    error = context.getString(R.string.runtime_start_error_native_load_failed, detail),
                )
            }
        }
    }

    fun startIfNeeded(context: Context): StartResult {
        val libLoadResult = ensureLibrariesLoaded(context)
        if (!libLoadResult.ok) {
            return libLoadResult
        }

        if (started.get() && !isNodeProcessRunning()) {
            Log.w(TAG, "Node process was marked started but is not running. Resetting start state.")
            started.set(false)
        }

        if (started.get()) {
            return StartResult(ok = true)
        }

        synchronized(this) {
            if (started.get()) {
                return StartResult(ok = true)
            }

            return try {
                val paths = prepareRuntime(context)
                runtimeDir = paths.runtimeRoot
                dataRootDir = paths.dataRoot
                val selectedPort = selectServerPort(context, DEFAULT_SERVER_PORT, MAX_PORT_PROBE_ATTEMPTS)
                serverPort = selectedPort

                val script = File(paths.runtimeRoot, "bootstrap.js")
                val args = arrayOf(
                    "node",
                    script.absolutePath,
                    "--port",
                    selectedPort.toString(),
                    "--dataRoot",
                    paths.dataRoot.absolutePath,
                    "--serverPluginsPath",
                    paths.serverPluginsRoot.absolutePath,
                    "--globalExtensionsPath",
                    paths.globalExtensionsRoot.absolutePath,
                    "--configPath",
                    File(paths.dataRoot, CONFIG_FILE_NAME).absolutePath,
                )
                val exitCode = startNodeWithArguments(args)
                if (exitCode != 0) {
                    Log.e(TAG, "startNodeWithArguments returned non-zero: $exitCode")
                    return StartResult(
                        ok = false,
                        error = context.getString(R.string.runtime_start_error_node_exit_code, exitCode),
                    )
                }
                started.set(true)
                Log.i(TAG, "Node runtime launch requested on port=$selectedPort. running=${isNodeProcessRunning()}")
                StartResult(ok = true)
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to start runtime", t)
                StartResult(ok = false, error = t.message)
            }
        }
    }

    private fun selectServerPort(context: Context, basePort: Int, maxAttempts: Int): Int {
        for (offset in 0 until maxAttempts) {
            val candidate = basePort + offset
            if (isPortAvailable(candidate)) {
                return candidate
            }
        }
        throw IllegalStateException(
            context.getString(
                R.string.runtime_start_error_no_available_port,
                basePort,
                basePort + maxAttempts - 1,
            ),
        )
    }

    private fun isPortAvailable(port: Int): Boolean {
        return try {
            ServerSocket().use { socket ->
                socket.reuseAddress = true
                socket.bind(InetSocketAddress("127.0.0.1", port))
            }
            true
        } catch (_: Throwable) {
            false
        }
    }

    private fun prepareRuntime(context: Context): RuntimePaths {
        val runtimeRoot = File(context.filesDir, RUNTIME_DIR_NAME)
        val dataRoot = getPreferredDataRoot(context)
        val internalDataRoot = File(context.filesDir, PERSISTENT_DATA_DIR_NAME)
        val persistRoot = File(dataRoot, RUNTIME_PERSIST_DIR_NAME)
        val serverPluginsRoot = File(dataRoot, SERVER_PLUGINS_DIR_NAME)
        val globalExtensionsRoot = File(dataRoot, GLOBAL_EXTENSIONS_RELATIVE_PATH)
        val markerFile = File(runtimeRoot, RUNTIME_MARKER)
        val legacyDataRoot = File(runtimeRoot, "data")
        migrateLegacyDataRoot(legacyDataRoot, internalDataRoot)
        migrateInternalDataRootToPreferred(internalDataRoot, dataRoot)
        if (!dataRoot.exists()) {
            dataRoot.mkdirs()
        }
        migrateRuntimeConfigToDataRoot(runtimeRoot, persistRoot, dataRoot)
        migrateLegacyRuntimePaths(runtimeRoot, persistRoot, serverPluginsRoot, globalExtensionsRoot)
        if (!serverPluginsRoot.exists()) {
            serverPluginsRoot.mkdirs()
        }
        if (!globalExtensionsRoot.exists()) {
            globalExtensionsRoot.mkdirs()
        }

        val markerValue = buildRuntimeMarker(context)
        val needsRefresh = !runtimeRoot.exists() || !markerFile.exists() || markerFile.readText() != markerValue

        if (needsRefresh) {
            if (runtimeRoot.exists()) {
                persistRuntimeArtifacts(runtimeRoot, persistRoot)
                runtimeRoot.deleteRecursively()
            }
            runtimeRoot.mkdirs()
            copyAssetDirectory(context.assets, NODE_PROJECT_ASSET_PATH, runtimeRoot)
            copyAssetFile(context.assets, NODE_SCRIPT_PATH, File(runtimeRoot, "bootstrap.js"))
            restoreRuntimeArtifacts(persistRoot, runtimeRoot)
            markerFile.writeText(markerValue)
            Log.i(TAG, "Runtime assets prepared at ${runtimeRoot.absolutePath}")
        }

        return RuntimePaths(
            runtimeRoot = runtimeRoot,
            dataRoot = dataRoot,
            serverPluginsRoot = serverPluginsRoot,
            globalExtensionsRoot = globalExtensionsRoot,
        )
    }

    private fun migrateRuntimeConfigToDataRoot(runtimeRoot: File, persistRoot: File, dataRoot: File) {
        val targetConfig = File(dataRoot, CONFIG_FILE_NAME)
        if (targetConfig.exists()) {
            return
        }

        val runtimeConfig = File(runtimeRoot, CONFIG_FILE_NAME)
        val persistedConfig = File(persistRoot, CONFIG_FILE_NAME)
        val sourceConfig = when {
            runtimeConfig.exists() -> runtimeConfig
            persistedConfig.exists() -> persistedConfig
            else -> null
        } ?: return

        runCatching {
            targetConfig.parentFile?.mkdirs()
            sourceConfig.copyTo(targetConfig, overwrite = false)
            Log.i(TAG, "Migrated runtime config to data root: ${targetConfig.absolutePath}")
        }.onFailure { t ->
            Log.e(TAG, "Failed to migrate runtime config to data root", t)
        }
    }

    private fun migrateLegacyRuntimePaths(
        runtimeRoot: File,
        persistRoot: File,
        serverPluginsRoot: File,
        globalExtensionsRoot: File,
    ) {
        migrateDirectoryIfNeeded(
            File(runtimeRoot, SERVER_PLUGINS_DIR_NAME),
            serverPluginsRoot,
            "runtime server plugins",
        )
        migrateDirectoryIfNeeded(
            File(runtimeRoot, "public/scripts/extensions/third-party"),
            globalExtensionsRoot,
            "runtime global extensions",
        )
        migrateDirectoryIfNeeded(
            File(persistRoot, SERVER_PLUGINS_DIR_NAME),
            serverPluginsRoot,
            "persisted server plugins",
        )
        migrateDirectoryIfNeeded(
            File(persistRoot, "public/scripts/extensions/third-party"),
            globalExtensionsRoot,
            "persisted global extensions",
        )
    }

    private fun migrateDirectoryIfNeeded(source: File, target: File, label: String) {
        if (!source.exists()) {
            return
        }

        val targetEntries = target.listFiles()
        if (target.exists() && targetEntries != null && targetEntries.isNotEmpty()) {
            return
        }

        runCatching {
            target.parentFile?.mkdirs()
            if (target.exists()) {
                target.deleteRecursively()
            }
            if (source.renameTo(target)) {
                Log.i(TAG, "Migrated $label to ${target.absolutePath}")
                return
            }

            source.copyRecursively(target, overwrite = false)
            source.deleteRecursively()
            Log.i(TAG, "Copied $label to ${target.absolutePath}")
        }.onFailure { t ->
            Log.e(TAG, "Failed to migrate $label", t)
        }
    }

    private fun getPreferredDataRoot(context: Context): File {
        val externalBase = context.getExternalFilesDir(null)
        if (externalBase != null) {
            return File(externalBase, PERSISTENT_DATA_DIR_NAME)
        }

        Log.w(TAG, "External app files directory is unavailable. Falling back to internal data root.")
        return File(context.filesDir, PERSISTENT_DATA_DIR_NAME)
    }

    private fun migrateInternalDataRootToPreferred(internalDataRoot: File, preferredDataRoot: File) {
        if (internalDataRoot.absolutePath == preferredDataRoot.absolutePath) {
            return
        }
        if (!internalDataRoot.exists()) {
            return
        }
        if (preferredDataRoot.exists()) {
            val existing = preferredDataRoot.listFiles()
            if (existing != null && existing.isNotEmpty()) {
                return
            }
        }

        runCatching {
            preferredDataRoot.parentFile?.mkdirs()
            if (internalDataRoot.renameTo(preferredDataRoot)) {
                Log.i(TAG, "Migrated user data root to external app directory: ${preferredDataRoot.absolutePath}")
                return
            }

            internalDataRoot.copyRecursively(preferredDataRoot, overwrite = false)
            internalDataRoot.deleteRecursively()
            Log.i(TAG, "Copied user data root to external app directory: ${preferredDataRoot.absolutePath}")
        }.onFailure { t ->
            Log.e(TAG, "Failed to migrate internal data root to preferred directory", t)
        }
    }

    private fun persistRuntimeArtifacts(runtimeRoot: File, persistRoot: File) {
        for (relativePath in RUNTIME_PERSIST_RELATIVE_PATHS) {
            val source = File(runtimeRoot, relativePath)
            val target = File(persistRoot, relativePath)

            try {
                if (!source.exists()) {
                    if (target.exists()) {
                        target.deleteRecursively()
                    }
                    continue
                }

                target.parentFile?.mkdirs()
                if (target.exists()) {
                    target.deleteRecursively()
                }

                if (source.isDirectory) {
                    source.copyRecursively(target, overwrite = true)
                } else {
                    source.copyTo(target, overwrite = true)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to persist runtime artifact: $relativePath", t)
            }
        }
    }

    private fun restoreRuntimeArtifacts(persistRoot: File, runtimeRoot: File) {
        if (!persistRoot.exists()) {
            return
        }

        for (relativePath in RUNTIME_PERSIST_RELATIVE_PATHS) {
            val source = File(persistRoot, relativePath)
            val target = File(runtimeRoot, relativePath)

            try {
                if (!source.exists()) {
                    continue
                }

                target.parentFile?.mkdirs()
                if (target.exists()) {
                    target.deleteRecursively()
                }

                if (source.isDirectory) {
                    source.copyRecursively(target, overwrite = true)
                } else {
                    source.copyTo(target, overwrite = true)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Failed to restore runtime artifact: $relativePath", t)
            }
        }
    }

    private fun migrateLegacyDataRoot(legacyDataRoot: File, dataRoot: File) {
        if (!legacyDataRoot.exists()) {
            return
        }

        if (dataRoot.exists()) {
            return
        }

        runCatching {
            dataRoot.parentFile?.mkdirs()
            if (legacyDataRoot.renameTo(dataRoot)) {
                Log.i(TAG, "Migrated legacy data root to ${dataRoot.absolutePath}")
                return
            }
            legacyDataRoot.copyRecursively(dataRoot, overwrite = false)
            legacyDataRoot.deleteRecursively()
            Log.i(TAG, "Copied legacy data root to ${dataRoot.absolutePath}")
        }.onFailure { t ->
            Log.e(TAG, "Failed to migrate legacy data root", t)
        }
    }

    private fun buildRuntimeMarker(context: Context): String {
        val lastUpdateTime = runCatching {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        }.getOrElse { 0L }
        return "layout=$RUNTIME_LAYOUT_VERSION;apkUpdatedAt=$lastUpdateTime"
    }

    private fun copyAssetDirectory(assetManager: AssetManager, assetPath: String, targetDir: File) {
        val entries = assetManager.list(assetPath) ?: emptyArray()
        if (entries.isEmpty()) {
            copyAssetFile(assetManager, assetPath, targetDir)
            return
        }

        if (!targetDir.exists()) {
            targetDir.mkdirs()
        }

        for (entry in entries) {
            val childAssetPath = if (assetPath.isEmpty()) entry else "$assetPath/$entry"
            val childTarget = File(targetDir, entry)
            copyAssetDirectory(assetManager, childAssetPath, childTarget)
        }
    }

    private fun copyAssetFile(assetManager: AssetManager, assetPath: String, outFile: File) {
        outFile.parentFile?.mkdirs()
        assetManager.open(assetPath).use { input ->
            FileOutputStream(outFile).use { output ->
                input.copyTo(output)
            }
        }
    }

    fun isServerReady(): Boolean {
        return try {
            val url = URL("$SERVER_URL/api/ping")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 800
                readTimeout = 800
                doOutput = true
            }
            connection.outputStream.use { os -> os.write(ByteArray(0)) }
            val code = connection.responseCode
            connection.disconnect()
            pingFailures = 0
            code in 200..499
        } catch (e: Exception) {
            pingFailures += 1
            if (started.get() && !isNodeProcessRunning()) {
                Log.w(TAG, "Node process is not running while server is unreachable. Resetting start state.")
                started.set(false)
            }
            if (pingFailures % 30 == 0) {
                val detail = e.message ?: e.javaClass.simpleName
                Log.w(TAG, "Server not ready after $pingFailures probes: $detail, nodeRunning=${isNodeProcessRunning()}")
            }
            false
        }
    }

    fun collectDiagnostics(context: Context, maxTailChars: Int = 6000): String {
        val dir = runtimeDir ?: File(context.filesDir, RUNTIME_DIR_NAME)
        val dataRoot = dataRootDir ?: getPreferredDataRoot(context)
        val serverPluginsRoot = File(dataRoot, SERVER_PLUGINS_DIR_NAME)
        val globalExtensionsRoot = File(dataRoot, GLOBAL_EXTENSIONS_RELATIVE_PATH)
        val marker = File(dir, RUNTIME_MARKER)
        val bootstrap = File(dir, "bootstrap.js")
        val logFile = File(dir, BOOTSTRAP_LOG_FILE)
        val sb = StringBuilder()
        sb.append("started=").append(started.get())
            .append(", nodeRunning=").append(
                try {
                    isNodeProcessRunning()
                } catch (_: Throwable) {
                    false
                }
            )
            .append(", runtimeDir=").append(dir.absolutePath)
            .append(", dataRoot=").append(dataRoot.absolutePath)
            .append(", serverPluginsRoot=").append(serverPluginsRoot.absolutePath)
            .append(", globalExtensionsRoot=").append(globalExtensionsRoot.absolutePath)
            .append('\n')
        sb.append("exists(runtimeDir)=").append(dir.exists())
            .append(", exists(dataRoot)=").append(dataRoot.exists())
            .append(", exists(serverPluginsRoot)=").append(serverPluginsRoot.exists())
            .append(", exists(globalExtensionsRoot)=").append(globalExtensionsRoot.exists())
            .append(", exists(marker)=").append(marker.exists())
            .append(", exists(bootstrap.js)=").append(bootstrap.exists())
            .append(", exists(bootstrap.log)=").append(logFile.exists())
            .append('\n')
        if (marker.exists()) {
            runCatching {
                sb.append("marker=").append(marker.readText()).append('\n')
            }
        }
        if (logFile.exists()) {
            sb.append("bootstrap.log tail:\n")
            sb.append(readTail(logFile, maxTailChars))
        } else {
            sb.append("bootstrap.log tail: <missing>")
        }
        return sb.toString()
    }

    private fun readTail(file: File, maxChars: Int): String {
        return runCatching {
            val text = file.readText(Charsets.UTF_8)
            if (text.length <= maxChars) text else text.takeLast(maxChars)
        }.getOrElse { t ->
            "<failed to read bootstrap.log: ${t.message}>"
        }
    }
}
