package com.luker.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.text.InputType
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.ConsoleMessage
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import java.io.File
import java.io.BufferedInputStream
import java.io.IOException
import java.io.PrintWriter
import java.io.StringWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private val tag = "LukerMainActivity"
    private val runtimeReportFileName = "luker-runtime-last-error.txt"
    private val messageAlertNotificationChannelId = "luker_message_alerts_v1"
    private val messageProgressNotificationChannelId = "luker_message_progress_v1"
    private val messageNotificationId = 12001
    private val messageProgressNotificationId = 12002
    private val streamDownloadNotificationId = 12003
    private val streamDownloadTerminalNotificationId = 12004
    private val broadFileChooserExtensions = setOf(
        "byaf",
        "charx",
        // Some OEM document pickers incorrectly treat exact JSON MIME filters as "open with".
        "json",
        "jsonl",
        "preset",
        "settings",
        "yaml",
        "yml",
    )
    private lateinit var contentRoot: View
    private lateinit var webView: WebView
    private lateinit var loadingOverlay: View
    private lateinit var loadingText: TextView
    private lateinit var fullscreenContainer: FrameLayout
    private var endpointDialog: AlertDialog? = null
    private var httpAuthDialog: AlertDialog? = null
    @Volatile
    private var runtimeFailureDialogShown: Boolean = false
    private var pendingFilePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermissionRequest: PermissionRequest? = null
    private var pendingWebPermissionResources: Array<String>? = null
    private var pendingSaveBytes: ByteArray? = null
    private var pendingSaveMimeType: String? = null
    private var pendingSaveFileName: String? = null
    private val streamRequestQueue: ArrayDeque<StreamRequest> = ArrayDeque()
    private var activeSafRequest: StreamRequest? = null
    private var activeDownloadRequest: StreamRequest? = null
    @Volatile
    private var cachedUserAgent: String? = null
    private val streamQueueLock = Any()
    private var pendingApkDownloadId: Long? = null
    private var apkDownloadReceiverRegistered = false
    private var immersiveModeEnabled: Boolean = false
    private var immersiveModeSource: String = "user"
    private var immersiveModeEnabledBeforeCustomView: Boolean = false
    private var pendingBackCheck: Boolean = false
    private var lastBackPressForExitMillis: Long = 0L
    private val confirmExitWindowMillis: Long = 2000L
    private var fullscreenCustomView: View? = null
    private var fullscreenCustomViewCallback: WebChromeClient.CustomViewCallback? = null
    private var contentRootBasePaddingLeft: Int = 0
    private var contentRootBasePaddingTop: Int = 0
    private var contentRootBasePaddingRight: Int = 0
    private var contentRootBasePaddingBottom: Int = 0
    private var lastAppliedImeOverlapBottom: Int = -1
    @Volatile
    private var backgroundKeepAliveEnabled: Boolean = false
    private val forceWebViewVisibleRunnable = Runnable {
        if (!backgroundKeepAliveEnabled || isFinishing || isDestroyed) return@Runnable
        if (!this::webView.isInitialized) return@Runnable
        try {
            webView.dispatchWindowVisibilityChanged(View.VISIBLE)
        } catch (t: Throwable) {
            Log.w(tag, "Failed to force WebView VISIBLE for background keep-alive", t)
        }
    }
    private val bootstrapSequence = AtomicInteger(0)
    private val recentHttpAuthAttempts = mutableMapOf<Pair<String, String>, LukerHttpAuthStore.Credentials>()
    private val backPressedCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (fullscreenCustomView != null) {
                lastBackPressForExitMillis = 0L
                hideCustomFullscreenView()
                return
            }

            if (immersiveModeEnabled && immersiveModeSource == "fullscreen_api") {
                lastBackPressForExitMillis = 0L
                applyImmersiveMode(false)
                syncWebImmersiveMode(false)
                return
            }

            if (this@MainActivity::webView.isInitialized && webView.canGoBack()) {
                lastBackPressForExitMillis = 0L
                webView.goBack()
                return
            }

            tryWebHandleBackOrConfirmExit()
        }
    }

    private val apkDownloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) {
                return
            }

            val finishedDownloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            val pendingId = pendingApkDownloadId ?: return
            if (finishedDownloadId <= 0L || pendingId != finishedDownloadId) {
                return
            }

            pendingApkDownloadId = null
            handleApkDownloadFinished(finishedDownloadId)
        }
    }

    private val fileChooserLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = pendingFilePathCallback ?: return@registerForActivityResult
        pendingFilePathCallback = null
        val chosenUris = if (result.resultCode == RESULT_OK) {
            val parsedUris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            if (!parsedUris.isNullOrEmpty()) parsedUris else extractChosenFileUris(result.data)
        } else {
            null
        }
        persistChosenFilePermissions(result.data, chosenUris)
        callback.onReceiveValue(chosenUris)
    }
    private val webPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { grants ->
        val request = pendingWebPermissionRequest
        val resources = pendingWebPermissionResources
        pendingWebPermissionRequest = null
        pendingWebPermissionResources = null
        if (request == null || resources == null) {
            return@registerForActivityResult
        }

        val allowed = resources.filter { resource ->
            when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> grants[Manifest.permission.RECORD_AUDIO] == true
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> grants[Manifest.permission.CAMERA] == true
                else -> false
            }
        }

        if (allowed.isEmpty()) {
            request.deny()
        } else {
            request.grant(allowed.toTypedArray())
        }
    }
    private val notificationPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) {
            Log.w(tag, "Notification permission denied. Foreground runtime notification may be hidden.")
            LukerEndpointStatusNotification.clear(applicationContext)
        } else {
            LukerEndpointStatusNotification.sync(applicationContext)
        }
    }
    private val saveFileLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val bytes = pendingSaveBytes
        val mimeType = pendingSaveMimeType
        val fileName = pendingSaveFileName
        pendingSaveBytes = null
        pendingSaveMimeType = null
        pendingSaveFileName = null

        val targetUri = result.data?.data
        if (result.resultCode != RESULT_OK || targetUri == null || bytes == null) {
            return@registerForActivityResult
        }

        Thread {
            try {
                contentResolver.openOutputStream(targetUri, "w")?.use { output ->
                    output.write(bytes)
                    output.flush()
                } ?: throw IOException("Unable to open output stream: $targetUri")
                runOnUiThread {
                    val savedName = fileName ?: getString(R.string.download_saved_fallback_name)
                    Toast.makeText(this, getString(R.string.download_saved, savedName), Toast.LENGTH_SHORT).show()
                }
            } catch (t: Throwable) {
                Log.e(tag, "Failed to save downloaded file (mime=$mimeType): $targetUri", t)
                runOnUiThread {
                    Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }
    private val saveFileStreamLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val req: StreamRequest?
        synchronized(streamQueueLock) {
            req = activeSafRequest
            activeSafRequest = null
        }
        val targetUri = result.data?.data
        if (req == null || result.resultCode != RESULT_OK || targetUri == null) {
            pumpStreamQueue()
            return@registerForActivityResult
        }
        synchronized(streamQueueLock) {
            activeDownloadRequest = req
        }
        Thread { performStreamDownload(req, targetUri) }.start()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        applyImmersiveMode(false)
        onBackPressedDispatcher.addCallback(this, backPressedCallback)

        contentRoot = findViewById(android.R.id.content)
        webView = findViewById(R.id.lukerWebView)
        loadingOverlay = findViewById(R.id.loadingOverlay)
        loadingText = findViewById(R.id.loadingText)
        fullscreenContainer = findViewById(R.id.fullscreenContainer)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
        }
        cachedUserAgent = runCatching { webView.settings.userAgentString }.getOrNull()
        contentRootBasePaddingLeft = contentRoot.paddingLeft
        contentRootBasePaddingTop = contentRoot.paddingTop
        contentRootBasePaddingRight = contentRoot.paddingRight
        contentRootBasePaddingBottom = contentRoot.paddingBottom
        installImeInsetsHandling()
        webView.addJavascriptInterface(LukerAndroidBridge(), "LukerAndroid")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage?): Boolean {
                if (message != null) {
                    val level = message.messageLevel()?.name ?: "LOG"
                    val source = message.sourceId().orEmpty()
                    val lineNo = message.lineNumber()
                    val text = message.message().orEmpty()
                    LukerDebugTrail.append(
                        "webconsole",
                        "$level $source:$lineNo $text",
                    )
                }
                return super.onConsoleMessage(message)
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null) {
                    callback?.onCustomViewHidden()
                    return
                }
                showCustomFullscreenView(view, callback)
            }

            override fun onHideCustomView() {
                hideCustomFullscreenView()
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                if (filePathCallback == null) {
                    return false
                }
                pendingFilePathCallback?.onReceiveValue(null)
                pendingFilePathCallback = filePathCallback

                val chooserIntent = buildFileChooserIntent(fileChooserParams)

                return try {
                    fileChooserLauncher.launch(chooserIntent)
                    true
                } catch (e: ActivityNotFoundException) {
                    pendingFilePathCallback = null
                    Log.e(tag, "No activity can handle file chooser intent", e)
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) {
                    return
                }
                val requestedResources = request.resources ?: emptyArray()
                if (requestedResources.isEmpty()) {
                    request.deny()
                    return
                }

                val requiredRuntimePermissions = requestedResources
                    .flatMap { resource ->
                        when (resource) {
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
                            else -> emptyList()
                        }
                    }
                    .distinct()

                if (requiredRuntimePermissions.isEmpty()) {
                    request.grant(requestedResources)
                    return
                }

                val allGranted = requiredRuntimePermissions.all { permission ->
                    ContextCompat.checkSelfPermission(this@MainActivity, permission) == PackageManager.PERMISSION_GRANTED
                }
                if (allGranted) {
                    request.grant(requestedResources)
                    return
                }

                pendingWebPermissionRequest?.deny()
                pendingWebPermissionRequest = request
                pendingWebPermissionResources = requestedResources
                webPermissionLauncher.launch(requiredRuntimePermissions.toTypedArray())
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest?) {
                if (pendingWebPermissionRequest == request) {
                    pendingWebPermissionRequest = null
                    pendingWebPermissionResources = null
                }
                super.onPermissionRequestCanceled(request)
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

            override fun onReceivedHttpAuthRequest(
                view: WebView?,
                handler: HttpAuthHandler?,
                host: String?,
                realm: String?,
            ) {
                val safeView = view ?: run {
                    handler?.cancel()
                    return
                }
                val safeHandler = handler ?: return
                val authHost = host?.trim().orEmpty().ifBlank {
                    Uri.parse(safeView.url.orEmpty()).host.orEmpty()
                }
                val authRealm = realm?.trim().orEmpty()
                val authKey = buildHttpAuthKey(authHost, authRealm)
                val storedCredentials = LukerHttpAuthStore.load(applicationContext, authHost, authRealm)
                val lastAttemptedCredentials = recentHttpAuthAttempts[authKey]

                if (storedCredentials != null && storedCredentials != lastAttemptedCredentials) {
                    recentHttpAuthAttempts[authKey] = storedCredentials
                    safeHandler.proceed(storedCredentials.username, storedCredentials.password)
                    return
                }

                if (storedCredentials != null && storedCredentials == lastAttemptedCredentials) {
                    LukerHttpAuthStore.clear(applicationContext, authHost, authRealm)
                }

                runOnUiThread {
                    showHttpAuthDialog(
                        handler = safeHandler,
                        host = authHost,
                        realm = authRealm,
                        prefill = lastAttemptedCredentials ?: storedCredentials,
                    )
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                recentHttpAuthAttempts.clear()
                installBlobDownloadBridge()
                loadingOverlay.visibility = View.GONE
            }

            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val crashed = detail?.didCrash() ?: false
                val rendererPriority = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    detail?.rendererPriorityAtExit()
                } else {
                    null
                }
                val url = runCatching { view?.url }.getOrNull()
                Log.w(tag, "WebView render process gone (didCrash=$crashed, url=$url)")
                runCatching {
                    (view?.parent as? ViewGroup)?.removeView(view)
                    view?.destroy()
                }
                LukerDebugTrail.append("native", "renderProcessGone didCrash=$crashed url=$url")
                val crash = LukerCrashCapture.captureWebViewCrash(
                    context = applicationContext,
                    webViewUrl = url,
                    didCrash = crashed,
                    rendererPriorityAtExit = rendererPriority,
                )
                val enrichedReport = buildString {
                    append(crash.report)
                    append("\n\n--- debug-trail ---\n")
                    append(LukerDebugTrail.dumpAll().ifEmpty { "<empty>" })
                    appendLogcatTails(this, applicationContext)
                }
                window.decorView.post {
                    if (isFinishing || isDestroyed) {
                        return@post
                    }
                    showWebViewCrashDialog(enrichedReport, crash.reportFile)
                }
                return true
            }
        }
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            handleWebViewDownload(url, userAgent, contentDisposition, mimeType)
        }
        registerApkDownloadReceiver()
        ensureNotificationPermissionIfNeeded()

        val launchAction = intent?.action
        bootstrapConfiguredEndpoint()
        handleLaunchIntent(intent)
        maybePromptForCustomEndpointOnLaunch(savedInstanceState, launchAction)
        maybeShowPreviousCrashReport()
    }

    private fun maybeShowPreviousCrashReport() {
        val crash = LukerCrashCapture.pollUnhandledCrash(applicationContext) ?: return
        Log.w(tag, "Detected abnormal exit from previous session: ${crash.report.lineSequence().firstOrNull()}")
        window.decorView.post {
            if (isFinishing || isDestroyed) {
                return@post
            }
            val fullReportFile = writeFullReportFile(crash.report) ?: crash.reportFile
            showReportDialog(
                titleRes = R.string.crash_report_dialog_title,
                introRes = R.string.crash_report_dialog_intro,
                shareSubjectRes = R.string.crash_report_share_subject,
                summary = buildCrashSummary(crash.report),
                fullReportFile = fullReportFile,
            )
        }
    }

    private fun buildFileChooserIntent(fileChooserParams: WebChromeClient.FileChooserParams?): Intent {
        val mimeSelection = resolveAcceptedMimeTypes(fileChooserParams)
        val chooserIntent = try {
            fileChooserParams?.createIntent()
        } catch (t: Throwable) {
            Log.w(tag, "Failed to create system file chooser intent", t)
            null
        } ?: buildFallbackFileChooserIntent()

        return normalizeFileChooserIntent(chooserIntent, fileChooserParams, mimeSelection)
    }

    private fun buildFallbackFileChooserIntent(): Intent {
        return Intent(Intent.ACTION_GET_CONTENT)
    }

    private fun normalizeFileChooserIntent(
        chooserIntent: Intent,
        fileChooserParams: WebChromeClient.FileChooserParams?,
        mimeSelection: MimeSelection,
    ): Intent {
        val targetIntent = extractFileChooserTargetIntent(chooserIntent) ?: chooserIntent
        targetIntent.addCategory(Intent.CATEGORY_OPENABLE)
        targetIntent.putExtra(
            Intent.EXTRA_ALLOW_MULTIPLE,
            fileChooserParams?.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE,
        )
        targetIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        if (targetIntent.action == Intent.ACTION_OPEN_DOCUMENT) {
            targetIntent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }

        when {
            mimeSelection.requiresBroadFilter || mimeSelection.mimeTypes.isEmpty() -> {
                // Non-standard extensions such as .jsonl are frequently exposed as generic files by Android providers.
                targetIntent.type = "*/*"
                targetIntent.removeExtra(Intent.EXTRA_MIME_TYPES)
            }
            mimeSelection.mimeTypes.size == 1 -> {
                targetIntent.type = mimeSelection.mimeTypes.first()
                targetIntent.removeExtra(Intent.EXTRA_MIME_TYPES)
            }
            else -> {
                targetIntent.type = "*/*"
                targetIntent.putExtra(Intent.EXTRA_MIME_TYPES, mimeSelection.mimeTypes.toTypedArray())
            }
        }

        chooserIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (targetIntent.action == Intent.ACTION_OPEN_DOCUMENT || chooserIntent.action == Intent.ACTION_OPEN_DOCUMENT) {
            chooserIntent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        }

        if (targetIntent !== chooserIntent) {
            chooserIntent.putExtra(Intent.EXTRA_INTENT, targetIntent)
        }

        return chooserIntent
    }

    @Suppress("DEPRECATION")
    private fun extractFileChooserTargetIntent(chooserIntent: Intent): Intent? {
        if (chooserIntent.action != Intent.ACTION_CHOOSER) {
            return chooserIntent
        }

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            chooserIntent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            chooserIntent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
    }

    private fun resolveAcceptedMimeTypes(fileChooserParams: WebChromeClient.FileChooserParams?): MimeSelection {
        val mimeTypes = linkedSetOf<String>()
        var requiresBroadFilter = false

        for (acceptType in tokenizeAcceptedFileTypes(fileChooserParams)) {
            val resolved = resolveAcceptTypeToMimeTypes(acceptType)
            if (resolved == null) {
                requiresBroadFilter = true
                continue
            }
            mimeTypes += resolved
        }

        return MimeSelection(
            mimeTypes = mimeTypes,
            requiresBroadFilter = requiresBroadFilter,
        )
    }

    private fun tokenizeAcceptedFileTypes(fileChooserParams: WebChromeClient.FileChooserParams?): List<String> {
        return fileChooserParams?.acceptTypes
            ?.asSequence()
            ?.flatMap { value -> value.split(',').asSequence() }
            ?.map { value -> value.trim() }
            ?.filter { value -> value.isNotEmpty() }
            ?.toList()
            .orEmpty()
    }

    private fun resolveAcceptTypeToMimeTypes(rawAcceptType: String): Set<String>? {
        val acceptType = rawAcceptType.trim().lowercase(Locale.ROOT)
        if (acceptType.isEmpty()) {
            return emptySet()
        }

        if (!acceptType.startsWith('.')) {
            return setOf(acceptType)
        }

        val extension = acceptType.removePrefix(".")
        if (extension in broadFileChooserExtensions) {
            return null
        }

        val mimeTypes = linkedSetOf<String>()
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)?.let(mimeTypes::add)
        when (extension) {
            "json" -> mimeTypes.add("application/json")
        }

        return mimeTypes.takeIf { it.isNotEmpty() }
    }

    private data class MimeSelection(
        val mimeTypes: Set<String>,
        val requiresBroadFilter: Boolean,
    )

    private fun persistChosenFilePermissions(resultData: Intent?, chosenUris: Array<Uri>?) {
        if (chosenUris.isNullOrEmpty()) {
            return
        }

        val resultFlags = resultData?.flags ?: 0
        val canPersist = (resultFlags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) != 0
        val readFlags = resultFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (!canPersist || readFlags == 0) {
            return
        }

        for (uri in chosenUris) {
            try {
                contentResolver.takePersistableUriPermission(uri, readFlags)
            } catch (error: SecurityException) {
                Log.d(tag, "Chosen URI does not support persistable permission: $uri", error)
            } catch (error: Throwable) {
                Log.w(tag, "Failed to persist chosen file permission: $uri", error)
            }
        }
    }

    private fun extractChosenFileUris(resultData: Intent?): Array<Uri>? {
        if (resultData == null) {
            return null
        }

        val uris = linkedSetOf<Uri>()
        resultData.data?.let(uris::add)
        resultData.dataString
            ?.takeIf { it.isNotBlank() }
            ?.let(Uri::parse)
            ?.let(uris::add)

        val clipData = resultData.clipData
        if (clipData != null) {
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index)?.uri?.let(uris::add)
            }
        }

        return uris.takeIf { it.isNotEmpty() }?.toTypedArray()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    private fun ensureNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return
        }
        val granted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun ensureMessageNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(messageAlertNotificationChannelId) == null) {
            val alertChannel = NotificationChannel(
                messageAlertNotificationChannelId,
                getString(R.string.message_alert_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = getString(R.string.message_alert_channel_description)
            }
            manager.createNotificationChannel(alertChannel)
        }
        if (manager.getNotificationChannel(messageProgressNotificationChannelId) == null) {
            val progressChannel = NotificationChannel(
                messageProgressNotificationChannelId,
                getString(R.string.message_progress_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = getString(R.string.message_progress_channel_description)
            }
            manager.createNotificationChannel(progressChannel)
        }
    }

    private fun showMessageCompletionNotification(rawTitle: String?, rawBody: String?) {
        clearMessageProgressNotificationInternal()

        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            return
        }

        ensureMessageNotificationChannels()

        val title = rawTitle?.trim().orEmpty().ifBlank {
            getString(R.string.message_notification_default_title)
        }
        val body = rawBody?.trim().orEmpty().ifBlank {
            getString(R.string.message_notification_default_body)
        }

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, messageAlertNotificationChannelId)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        runCatching {
            NotificationManagerCompat.from(this).notify(messageNotificationId, notification)
        }.onFailure {
            Log.w(tag, "Failed to post message completion notification", it)
        }
    }

    private fun showMessageProgressNotification(rawTitle: String?, rawBody: String?) {
        val granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            return
        }

        ensureMessageNotificationChannels()

        val title = rawTitle?.trim().orEmpty().ifBlank {
            getString(R.string.message_notification_default_title)
        }
        val body = rawBody?.trim().orEmpty().ifBlank {
            getString(R.string.message_notification_progress_body)
        }

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, messageProgressNotificationChannelId)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(false)
            .setContentIntent(pendingIntent)
            .build()

        runCatching {
            NotificationManagerCompat.from(this).notify(messageProgressNotificationId, notification)
        }.onFailure {
            Log.w(tag, "Failed to post message progress notification", it)
        }
    }

    private fun clearMessageProgressNotificationInternal() {
        runCatching {
            NotificationManagerCompat.from(this).cancel(messageProgressNotificationId)
        }.onFailure {
            Log.w(tag, "Failed to clear message progress notification", it)
        }
    }

    private inner class LukerAndroidBridge {
        @JavascriptInterface
        fun saveFileFromDataUrl(dataUrl: String?, suggestedName: String?, mimeType: String?) {
            if (dataUrl.isNullOrBlank()) {
                return
            }
            val parsed = parseDataUrl(dataUrl) ?: run {
                runOnUiThread { Toast.makeText(this@MainActivity, getString(R.string.download_failed), Toast.LENGTH_SHORT).show() }
                return
            }
            val resolvedName = sanitizeFileName(suggestedName)
            val resolvedMime = if (mimeType.isNullOrBlank()) parsed.first else mimeType
            runOnUiThread { requestSaveFile(parsed.second, resolvedName, resolvedMime) }
        }

        @JavascriptInterface
        fun installApkFromUrl(downloadUrl: String?, suggestedName: String?) {
            val url = downloadUrl?.trim().orEmpty()
            if (url.isEmpty()) {
                return
            }
            runOnUiThread {
                enqueueApkInstallDownload(url, suggestedName)
            }
        }

        @JavascriptInterface
        fun saveFileFromUrl(requestJson: String?) {
            val req = parseSaveFileFromUrlRequest(requestJson) ?: run {
                runOnUiThread { Toast.makeText(this@MainActivity, getString(R.string.download_failed), Toast.LENGTH_SHORT).show() }
                return
            }
            runOnUiThread { enqueueStreamRequest(req) }
        }

        @JavascriptInterface
        fun notifyMessageFinished(rawTitle: String?, rawBody: String?) {
            runOnUiThread {
                showMessageCompletionNotification(rawTitle, rawBody)
            }
        }

        @JavascriptInterface
        fun notifyMessageProgress(rawTitle: String?, rawBody: String?) {
            runOnUiThread {
                showMessageProgressNotification(rawTitle, rawBody)
            }
        }

        @JavascriptInterface
        fun clearMessageProgressNotification() {
            runOnUiThread {
                clearMessageProgressNotificationInternal()
            }
        }

        @JavascriptInterface
        fun setImmersiveModeEnabled(enabled: Boolean) {
            runOnUiThread {
                immersiveModeSource = "user"
                applyImmersiveMode(enabled)
            }
        }

        @JavascriptInterface
        fun setImmersiveModeEnabledWithSource(enabled: Boolean, source: String?) {
            runOnUiThread {
                immersiveModeSource = if (source.isNullOrBlank()) "user" else source
                applyImmersiveMode(enabled)
            }
        }

        @JavascriptInterface
        fun setSystemBarsColor(statusBarColor: String?, navigationBarColor: String?) {
            val parsedStatus = parseCssColor(statusBarColor)
            val parsedNavigation = parseCssColor(navigationBarColor) ?: parsedStatus
            if (parsedStatus == null && parsedNavigation == null) {
                return
            }
            runOnUiThread {
                applySystemBarsColor(parsedStatus, parsedNavigation)
            }
        }

        @JavascriptInterface
        fun setBackgroundKeepAliveEnabled(enabled: Boolean) {
            runOnUiThread {
                applyBackgroundKeepAlive(enabled)
            }
        }

        @JavascriptInterface
        fun setDebugRecordingEnabled(enabled: Boolean) {
            LukerAndroidDebugConfig.setEnabled(applicationContext, enabled)
            LukerLogcatTail.setEnabled(applicationContext, enabled)
            LukerDebugTrail.append("native", "debug-recording $enabled")
        }

        @JavascriptInterface
        fun pushDebugTrail(category: String?, text: String?) {
            LukerDebugTrail.append(category.orEmpty(), text.orEmpty())
        }

        @JavascriptInterface
        fun exportDiagnosticsBundle() {
            runOnUiThread {
                exportAndShareDiagnosticsBundle(R.string.debug_export_share_subject)
            }
        }
    }

    private var lastAppliedStatusBarColor: Int? = null
    private var lastAppliedNavigationBarColor: Int? = null

    private fun applyBackgroundKeepAlive(enabled: Boolean) {
        if (backgroundKeepAliveEnabled == enabled) return
        backgroundKeepAliveEnabled = enabled
        if (!this::webView.isInitialized) return
        if (!enabled) {
            webView.removeCallbacks(forceWebViewVisibleRunnable)
        }
    }

    private fun scheduleForceWebViewVisible() {
        if (!backgroundKeepAliveEnabled) return
        if (!this::webView.isInitialized) return
        webView.removeCallbacks(forceWebViewVisibleRunnable)
        webView.postDelayed(forceWebViewVisibleRunnable, 1000L)
    }

    private fun applySystemBarsColor(statusBarColor: Int?, navigationBarColor: Int?) {
        val opaqueStatus = statusBarColor?.let { it or 0xFF000000.toInt() }
        val opaqueNavigation = navigationBarColor?.let { it or 0xFF000000.toInt() }
        opaqueStatus?.let { lastAppliedStatusBarColor = it }
        opaqueNavigation?.let { lastAppliedNavigationBarColor = it }
        if (immersiveModeEnabled) {
            return
        }
        opaqueStatus?.let { window.statusBarColor = it }
        opaqueNavigation?.let { window.navigationBarColor = it }
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        opaqueStatus?.let { controller.isAppearanceLightStatusBars = isLightColor(it) }
        opaqueNavigation?.let { controller.isAppearanceLightNavigationBars = isLightColor(it) }
    }

    private fun reapplyLastSystemBarsColor() {
        if (lastAppliedStatusBarColor == null && lastAppliedNavigationBarColor == null) {
            return
        }
        applySystemBarsColor(lastAppliedStatusBarColor, lastAppliedNavigationBarColor)
    }

    private fun isLightColor(color: Int): Boolean {
        val r = ((color shr 16) and 0xFF) / 255.0
        val g = ((color shr 8) and 0xFF) / 255.0
        val b = (color and 0xFF) / 255.0
        val luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        return luma > 0.6
    }

    private fun parseCssColor(raw: String?): Int? {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return null

        if (trimmed.startsWith("#")) {
            return runCatching { android.graphics.Color.parseColor(trimmed) }.getOrNull()
        }

        val rgbaMatch = Regex(
            "^rgba?\\(\\s*(\\d+)[ ,]+(\\d+)[ ,]+(\\d+)(?:[ ,/]+([0-9]*\\.?[0-9]+%?))?\\s*\\)$",
            RegexOption.IGNORE_CASE,
        ).matchEntire(trimmed) ?: return null

        val r = rgbaMatch.groupValues[1].toIntOrNull()?.coerceIn(0, 255) ?: return null
        val g = rgbaMatch.groupValues[2].toIntOrNull()?.coerceIn(0, 255) ?: return null
        val b = rgbaMatch.groupValues[3].toIntOrNull()?.coerceIn(0, 255) ?: return null
        val alphaRaw = rgbaMatch.groupValues.getOrNull(4)?.takeIf { it.isNotEmpty() }
        val alpha = when {
            alphaRaw == null -> 255
            alphaRaw.endsWith("%") -> ((alphaRaw.removeSuffix("%").toDoubleOrNull() ?: 100.0) / 100.0 * 255.0).toInt().coerceIn(0, 255)
            else -> ((alphaRaw.toDoubleOrNull() ?: 1.0) * 255.0).toInt().coerceIn(0, 255)
        }
        return (alpha shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun showCustomFullscreenView(view: View, callback: WebChromeClient.CustomViewCallback?) {
        if (!this::fullscreenContainer.isInitialized) {
            callback?.onCustomViewHidden()
            return
        }

        if (fullscreenCustomView != null) {
            hideCustomFullscreenView()
        }

        (view.parent as? ViewGroup)?.removeView(view)

        immersiveModeEnabledBeforeCustomView = immersiveModeEnabled
        fullscreenCustomView = view
        fullscreenCustomViewCallback = callback

        fullscreenContainer.removeAllViews()
        fullscreenContainer.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        fullscreenContainer.visibility = View.VISIBLE
        fullscreenContainer.bringToFront()
        webView.visibility = View.GONE
        applyImmersiveMode(true)
        ViewCompat.requestApplyInsets(fullscreenContainer)
    }

    private fun hideCustomFullscreenView() {
        val callback = fullscreenCustomViewCallback
        if (fullscreenCustomView == null) {
            callback?.onCustomViewHidden()
            fullscreenCustomViewCallback = null
            return
        }

        fullscreenCustomView = null
        fullscreenCustomViewCallback = null
        fullscreenContainer.removeAllViews()
        fullscreenContainer.visibility = View.GONE
        webView.visibility = View.VISIBLE

        val restoreImmersiveMode = immersiveModeEnabledBeforeCustomView
        immersiveModeEnabledBeforeCustomView = false
        applyImmersiveMode(restoreImmersiveMode)
        syncWebImmersiveMode(restoreImmersiveMode)
        ViewCompat.requestApplyInsets(contentRoot)

        callback?.onCustomViewHidden()
    }

    private fun applyImmersiveMode(enabled: Boolean) {
        immersiveModeEnabled = enabled
        setKeyboardModeForImmersive(enabled)
        updateDisplayCutoutMode(enabled)
        WindowCompat.setDecorFitsSystemWindows(window, !enabled)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (enabled) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
            reapplyLastSystemBarsColor()
        }
        window.decorView.post {
            ViewCompat.requestApplyInsets(window.decorView)
            if (this::contentRoot.isInitialized) {
                ViewCompat.requestApplyInsets(contentRoot)
            }
            if (this::webView.isInitialized) {
                webView.requestLayout()
            }
        }
    }

    private fun updateDisplayCutoutMode(enabled: Boolean) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return
        }
        val params = window.attributes
        val desiredMode = if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        } else {
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        if (params.layoutInDisplayCutoutMode != desiredMode) {
            params.layoutInDisplayCutoutMode = desiredMode
            window.attributes = params
        }
    }

    private fun syncWebImmersiveMode(enabled: Boolean) {
        if (!this::webView.isInitialized) {
            return
        }
        val jsEnabled = if (enabled) "true" else "false"
        webView.evaluateJavascript(
            "window.__lukerSetImmersiveModeFromNative && window.__lukerSetImmersiveModeFromNative($jsEnabled);",
            null,
        )
    }

    private fun tryWebHandleBackOrConfirmExit() {
        if (pendingBackCheck) {
            return
        }
        if (!this::webView.isInitialized) {
            triggerExitOrConfirmToast()
            return
        }
        pendingBackCheck = true
        val script = "(function(){try{return (typeof window.__lukerHandleBack === 'function') ? String(window.__lukerHandleBack()) : 'noop';}catch(e){return 'noop';}})();"
        webView.evaluateJavascript(script) { rawResult ->
            runOnUiThread {
                pendingBackCheck = false
                val result = (rawResult ?: "").trim('"', ' ', '\n', '\r', '\t').lowercase()
                if (result == "consumed") {
                    lastBackPressForExitMillis = 0L
                    return@runOnUiThread
                }
                triggerExitOrConfirmToast()
            }
        }
    }

    private fun triggerExitOrConfirmToast() {
        val now = SystemClock.elapsedRealtime()
        if (lastBackPressForExitMillis != 0L && now - lastBackPressForExitMillis <= confirmExitWindowMillis) {
            backPressedCallback.isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            return
        }
        lastBackPressForExitMillis = now
        Toast.makeText(this, getString(R.string.press_back_again_to_exit), Toast.LENGTH_SHORT).show()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && immersiveModeEnabled) {
            applyImmersiveMode(true)
        }
        if (hasFocus && this::fullscreenContainer.isInitialized && fullscreenContainer.visibility == View.VISIBLE) {
            ViewCompat.requestApplyInsets(fullscreenContainer)
        }
        if (hasFocus && this::contentRoot.isInitialized) {
            ViewCompat.requestApplyInsets(contentRoot)
        }
        if (!hasFocus) {
            scheduleForceWebViewVisible()
        }
    }

    override fun onPause() {
        super.onPause()
        scheduleForceWebViewVisible()
    }

    override fun onStop() {
        super.onStop()
        scheduleForceWebViewVisible()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (immersiveModeEnabled) {
            applyImmersiveMode(true)
        }
        window.decorView.post {
            ViewCompat.requestApplyInsets(window.decorView)
            if (this::contentRoot.isInitialized) {
                ViewCompat.requestApplyInsets(contentRoot)
                contentRoot.requestLayout()
            }
            if (this::fullscreenContainer.isInitialized && fullscreenContainer.visibility == View.VISIBLE) {
                ViewCompat.requestApplyInsets(fullscreenContainer)
                fullscreenContainer.requestLayout()
            }
            if (this::webView.isInitialized) {
                webView.requestLayout()
                syncWebImmersiveMode(immersiveModeEnabled)
            }
        }
    }

    private fun setKeyboardModeForImmersive(enabled: Boolean) {
        val mode = if (enabled) {
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
        } else {
            WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
        window.setSoftInputMode(mode)
        if (!enabled) {
            resetContentRootImeInsetsAdjustment()
        }
    }

    private fun installImeInsetsHandling() {
        if (!this::contentRoot.isInitialized) {
            return
        }
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot) { _, insets ->
            applyImeInsetsToWebView(insets)
            insets
        }
        contentRoot.post {
            ViewCompat.requestApplyInsets(contentRoot)
        }
    }

    private fun resetContentRootImeInsetsAdjustment() {
        if (!this::contentRoot.isInitialized) {
            return
        }
        lastAppliedImeOverlapBottom = 0
        contentRoot.setPadding(
            contentRootBasePaddingLeft,
            contentRootBasePaddingTop,
            contentRootBasePaddingRight,
            contentRootBasePaddingBottom,
        )
        contentRoot.requestLayout()
        if (this::webView.isInitialized) {
            webView.requestLayout()
        }
    }

    private fun applyImeInsetsToWebView(insets: WindowInsetsCompat) {
        if (!this::webView.isInitialized) {
            return
        }

        if (!immersiveModeEnabled) {
            if (lastAppliedImeOverlapBottom != 0) {
                resetContentRootImeInsetsAdjustment()
            }
            return
        }

        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
        val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
        val navBottom = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        val imeOverlapBottom = if (imeVisible) {
            val overlap = (imeBottom - navBottom).coerceAtLeast(0)
            if (overlap == 0 && imeBottom > 0) imeBottom else overlap
        } else {
            0
        }

        if (imeOverlapBottom == lastAppliedImeOverlapBottom) {
            return
        }

        lastAppliedImeOverlapBottom = imeOverlapBottom
        contentRoot.setPadding(
            contentRootBasePaddingLeft,
            contentRootBasePaddingTop,
            contentRootBasePaddingRight,
            contentRootBasePaddingBottom + imeOverlapBottom,
        )
        contentRoot.requestLayout()
        webView.requestLayout()
    }

    private fun installBlobDownloadBridge() {
        val script = """
            (function () {
              if (window.__lukerAndroidDownloadBridgeInstalled) return;
              window.__lukerAndroidDownloadBridgeInstalled = true;
              if (!window.LukerAndroid || typeof window.LukerAndroid.saveFileFromDataUrl !== 'function') return;

              const topLukerAndroid = window.LukerAndroid;

              const applyToWindow = (win) => {
                try {
                  if (!win || win.__lukerAndroidDownloadBridgeApplied) return;
                  win.__lukerAndroidDownloadBridgeApplied = true;
                } catch (_) {
                  return;
                }

                let HTMLAnchorElementProto, URLObj, FileReaderCtor, fetchFn;
                try {
                  HTMLAnchorElementProto = win.HTMLAnchorElement && win.HTMLAnchorElement.prototype;
                  URLObj = win.URL;
                  FileReaderCtor = win.FileReader;
                  fetchFn = win.fetch ? win.fetch.bind(win) : null;
                  if (!HTMLAnchorElementProto || !URLObj || !FileReaderCtor || !fetchFn) return;
                } catch (_) {
                  return;
                }

                const pendingBlobRevocations = new Map();

                const toDataUrl = (blob) => new Promise((resolve, reject) => {
                  const reader = new FileReaderCtor();
                  reader.onload = () => resolve(String(reader.result || ''));
                  reader.onerror = reject;
                  reader.readAsDataURL(blob);
                });

                const handoffDownload = async (anchor) => {
                  try {
                    const href = String(anchor.href || '');
                    if (!href.startsWith('blob:') && !href.startsWith('data:')) return false;
                    const fileName = anchor.getAttribute('download') || 'download';
                    let dataUrl = href;
                    let mime = anchor.type || 'application/octet-stream';

                    if (href.startsWith('blob:')) {
                      const response = await fetchFn(href);
                      const blob = await response.blob();
                      mime = blob.type || mime;
                      dataUrl = await toDataUrl(blob);
                    }

                    topLukerAndroid.saveFileFromDataUrl(dataUrl, fileName, mime);
                    return true;
                  } catch (error) {
                    try { console.error('[LukerAndroid] blob download handoff failed', error); } catch (_) {}
                    return false;
                  }
                };

                const originalClick = HTMLAnchorElementProto.click;
                const originalRevokeObjectURL = URLObj.revokeObjectURL.bind(URLObj);

                HTMLAnchorElementProto.click = function () {
                  if (this && typeof this.hasAttribute === 'function' && this.hasAttribute('download')) {
                    const href = String(this.href || '');
                    if (href.startsWith('blob:') || href.startsWith('data:')) {
                      const pendingHandoff = Promise.resolve(handoffDownload(this))
                        .finally(() => pendingBlobRevocations.delete(href));
                      if (href.startsWith('blob:')) {
                        pendingBlobRevocations.set(href, pendingHandoff);
                      }
                      return;
                    }
                  }
                  return originalClick.call(this);
                };

                URLObj.revokeObjectURL = function (url) {
                  const href = String(url || '');
                  const pendingHandoff = pendingBlobRevocations.get(href);
                  if (pendingHandoff) {
                    pendingHandoff.finally(() => originalRevokeObjectURL(href));
                    return;
                  }
                  return originalRevokeObjectURL(href);
                };
              };

              const tryApplyToIframe = (iframe) => {
                const apply = () => {
                  try {
                    const childWin = iframe.contentWindow;
                    if (!childWin) return;
                    applyToWindow(childWin);
                  } catch (_) {}
                };
                apply();
                try { iframe.addEventListener('load', apply, false); } catch (_) {}
              };

              const scanAllIframes = (root) => {
                try {
                  const iframes = root.querySelectorAll('iframe');
                  for (let i = 0; i < iframes.length; i++) {
                    tryApplyToIframe(iframes[i]);
                  }
                } catch (_) {}
              };

              applyToWindow(window);
              scanAllIframes(document);

              try {
                const observer = new MutationObserver((mutations) => {
                  for (const m of mutations) {
                    if (m.type === 'childList') {
                      for (const node of m.addedNodes) {
                        if (!node || node.nodeType !== 1) continue;
                        if (node.tagName === 'IFRAME') {
                          tryApplyToIframe(node);
                        } else if (typeof node.querySelectorAll === 'function') {
                          const inner = node.querySelectorAll('iframe');
                          for (let i = 0; i < inner.length; i++) {
                            tryApplyToIframe(inner[i]);
                          }
                        }
                      }
                    } else if (m.type === 'attributes' && m.target && m.target.tagName === 'IFRAME') {
                      const iframe = m.target;
                      try {
                        const childWin = iframe.contentWindow;
                        if (childWin) {
                          try { delete childWin.__lukerAndroidDownloadBridgeApplied; } catch (_) {}
                        }
                      } catch (_) {}
                      tryApplyToIframe(iframe);
                    }
                  }
                });
                observer.observe(document.documentElement || document.body || document, {
                  childList: true,
                  subtree: true,
                  attributes: true,
                  attributeFilter: ['srcdoc', 'src'],
                });
              } catch (_) {}
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private fun handleWebViewDownload(
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val resolvedUrl = resolveDownloadUrl(url) ?: return
        val resolvedUri = runCatching { Uri.parse(resolvedUrl) }.getOrNull() ?: return
        if (!isWebViewSameOrigin(resolvedUri)) {
            enqueueDownload(url, userAgent, contentDisposition, mimeType)
            return
        }
        val fileName = sanitizeFileName(URLUtil.guessFileName(resolvedUrl, contentDisposition, mimeType))
        val resolvedMime = mimeType?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
        val req = StreamRequest(
            id = UUID.randomUUID().toString(),
            url = resolvedUrl,
            method = "GET",
            headers = emptyMap(),
            body = null,
            fileName = fileName,
            mimeType = resolvedMime,
        )
        synchronized(streamQueueLock) {
            streamRequestQueue.add(req)
        }
        pumpStreamQueue()
    }

    private fun enqueueDownload(
        url: String?,
        userAgent: String?,
        contentDisposition: String?,
        mimeType: String?,
    ) {
        val resolvedUrl = resolveDownloadUrl(url) ?: return
        val parsedUri = runCatching { Uri.parse(resolvedUrl) }.getOrNull() ?: return
        val scheme = parsedUri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return
        }
        try {
            val fileName = URLUtil.guessFileName(resolvedUrl, contentDisposition, mimeType)
            val request = DownloadManager.Request(parsedUri).apply {
                setTitle(fileName)
                setMimeType(mimeType)
                setDescription(getString(R.string.download_queued))
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                if (!userAgent.isNullOrBlank()) {
                    addRequestHeader("User-Agent", userAgent)
                }
                val cookies = CookieManager.getInstance().getCookie(resolvedUrl)
                if (!cookies.isNullOrBlank()) {
                    addRequestHeader("Cookie", cookies)
                }
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = getSystemService(DownloadManager::class.java)
            manager.enqueue(request)
            Toast.makeText(this, getString(R.string.download_started), Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            Log.e(tag, "Failed to enqueue download: $resolvedUrl", t)
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, parsedUri)) }
        }
    }

    private fun resolveDownloadUrl(rawUrl: String?): String? {
        val trimmedUrl = rawUrl?.trim().orEmpty()
        if (trimmedUrl.isEmpty()) {
            return null
        }

        val parsedUri = runCatching { Uri.parse(trimmedUrl) }.getOrNull() ?: return null
        val scheme = parsedUri.scheme?.lowercase()
        if (scheme == "http" || scheme == "https") {
            return parsedUri.toString()
        }
        if (scheme != null) {
            return null
        }

        val baseUrl = sequenceOf(
            if (this::webView.isInitialized) webView.url else null,
            LukerEndpointConfig.load(applicationContext).resolveBaseUrl(),
            LukerRuntimeManager.SERVER_URL,
        ).firstOrNull { !it.isNullOrBlank() } ?: return null

        val resolved = runCatching { java.net.URI(baseUrl).resolve(trimmedUrl).toString() }.getOrNull() ?: return null
        val resolvedScheme = runCatching { Uri.parse(resolved).scheme?.lowercase() }.getOrNull()
        return resolved.takeIf { resolvedScheme == "http" || resolvedScheme == "https" }
    }

    private fun requestSaveFile(bytes: ByteArray, fileName: String, mimeType: String) {
        if (pendingSaveBytes != null) {
            Toast.makeText(this, getString(R.string.download_in_progress), Toast.LENGTH_SHORT).show()
            return
        }
        pendingSaveBytes = bytes
        pendingSaveMimeType = mimeType
        pendingSaveFileName = fileName

        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, fileName)
        }
        try {
            saveFileLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
            Log.e(tag, "No activity can handle file save intent", e)
            pendingSaveBytes = null
            pendingSaveMimeType = null
            pendingSaveFileName = null
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun parseSaveFileFromUrlRequest(requestJson: String?): StreamRequest? {
        if (requestJson.isNullOrBlank()) return null
        val obj = runCatching { JSONObject(requestJson) }.getOrNull() ?: return null
        val url = obj.optString("url").trim()
        if (url.isEmpty()) return null
        val fileName = sanitizeFileName(obj.optString("fileName"))
        val mimeRaw = obj.optString("mimeType").trim()
        val mimeType = if (mimeRaw.isEmpty()) "application/octet-stream" else mimeRaw
        val method = obj.optString("method").trim().ifEmpty { "GET" }.uppercase(Locale.ROOT)
        if (method != "GET" && method != "POST") return null
        val headers = mutableMapOf<String, String>()
        obj.optJSONObject("headers")?.let { headersObj ->
            headersObj.keys().forEach { key ->
                val value = headersObj.optString(key)
                if (key.isNotBlank()) {
                    headers[key] = value
                }
            }
        }
        val body = obj.optString("body").takeIf { obj.has("body") && !obj.isNull("body") }
            ?.toByteArray(Charsets.UTF_8)
        return StreamRequest(
            id = UUID.randomUUID().toString(),
            url = url,
            method = method,
            headers = headers,
            body = body,
            fileName = fileName,
            mimeType = mimeType,
        )
    }

    private fun pumpStreamQueue() {
        val next: StreamRequest?
        synchronized(streamQueueLock) {
            if (activeSafRequest != null || activeDownloadRequest != null) return
            next = streamRequestQueue.pollFirst()
            if (next == null) return
            activeSafRequest = next
        }
        launchSafPickerFor(next!!)
    }

    private fun launchSafPickerFor(req: StreamRequest) {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = req.mimeType.ifBlank { "application/octet-stream" }
            putExtra(Intent.EXTRA_TITLE, req.fileName)
        }
        try {
            saveFileStreamLauncher.launch(intent)
        } catch (e: ActivityNotFoundException) {
            Log.e(tag, "No activity can handle file save intent for stream download", e)
            synchronized(streamQueueLock) { activeSafRequest = null }
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            pumpStreamQueue()
        }
    }

    private fun performStreamDownload(req: StreamRequest, targetUri: Uri) {
        var connection: HttpURLConnection? = null
        try {
            val resolvedUrl = req.url

            connection = (URL(resolvedUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 0
                requestMethod = req.method
                instanceFollowRedirects = false
            }

            val cookieFromCaller = req.headers.keys.any { it.equals("Cookie", ignoreCase = true) }
            for ((key, value) in req.headers) {
                connection.setRequestProperty(key, value)
            }
            if (!cookieFromCaller) {
                val cookies = CookieManager.getInstance().getCookie(resolvedUrl)
                if (!cookies.isNullOrBlank()) {
                    connection.setRequestProperty("Cookie", cookies)
                }
            }
            if (req.headers.keys.none { it.equals("User-Agent", ignoreCase = true) }) {
                runCatching { connection.setRequestProperty("User-Agent", cachedUserAgent) }
            }

            if (req.method == "POST" && req.body != null) {
                connection.doOutput = true
                connection.setFixedLengthStreamingMode(req.body.size)
                connection.outputStream.use { it.write(req.body) }
            }

            connection.connect()
            val code = connection.responseCode
            if (code !in 200..299) {
                val errorBody = runCatching {
                    connection.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) }
                }.getOrNull().orEmpty().take(200)
                Log.w(tag, "Stream download non-2xx (${code}) for ${req.fileName}: $errorBody")
                showStreamDownloadFailure(req.fileName, "HTTP $code${if (errorBody.isNotBlank()) ": $errorBody" else ""}")
                return
            }

            val totalLength = connection.contentLengthLong.let { if (it > 0) it else -1L }
            postStreamProgressNotification(req.fileName, 0L, totalLength)

            val outStream = contentResolver.openOutputStream(targetUri, "w")
            if (outStream == null) {
                Log.w(tag, "openOutputStream returned null for $targetUri")
                showStreamDownloadFailure(req.fileName, "saf open null")
                return
            }
            outStream.use { out ->
                BufferedInputStream(connection.inputStream, 16384).use { input ->
                    val buffer = ByteArray(16384)
                    var bytesWritten = 0L
                    var lastNotifyAtBytes = 0L
                    var lastNotifyAtMs = System.currentTimeMillis()
                    while (true) {
                        val read = input.read(buffer)
                        if (read <= 0) break
                        out.write(buffer, 0, read)
                        bytesWritten += read
                        val now = System.currentTimeMillis()
                        if (bytesWritten - lastNotifyAtBytes >= 200 * 1024 || now - lastNotifyAtMs >= 250) {
                            postStreamProgressNotification(req.fileName, bytesWritten, totalLength)
                            lastNotifyAtBytes = bytesWritten
                            lastNotifyAtMs = now
                        }
                    }
                    out.flush()
                    postStreamProgressNotification(req.fileName, bytesWritten, totalLength)
                }
            }
            postStreamSuccessNotification(req.fileName, targetUri, req.mimeType)
            runOnUiThread {
                Toast.makeText(this, getString(R.string.download_saved, req.fileName), Toast.LENGTH_SHORT).show()
            }
        } catch (t: Throwable) {
            Log.e(tag, "Stream download failed for ${req.fileName}", t)
            val reason = "${t.javaClass.simpleName}: ${t.message ?: "no message"}"
            showStreamDownloadFailure(req.fileName, reason)
        } finally {
            runCatching { connection?.disconnect() }
            synchronized(streamQueueLock) { activeDownloadRequest = null }
            runOnUiThread { pumpStreamQueue() }
        }
    }

    private fun showStreamDownloadFailure(fileName: String, reason: String? = null) {
        postStreamFailureNotification(fileName, reason)
        runOnUiThread {
            val text = if (reason.isNullOrBlank()) {
                getString(R.string.download_failed)
            } else {
                getString(R.string.download_failed) + " (" + reason + ")"
            }
            Toast.makeText(this, text, Toast.LENGTH_LONG).show()
        }
    }

    private fun postStreamProgressNotification(fileName: String, bytesWritten: Long, totalLength: Long) {
        if (!hasPostNotificationsPermission()) return
        ensureMessageNotificationChannels()
        val builder = NotificationCompat.Builder(this, messageProgressNotificationChannelId)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(fileName)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(buildOpenAppPendingIntent())
        if (totalLength > 0L) {
            val pct = ((bytesWritten.toDouble() / totalLength.toDouble()) * 100.0).toInt().coerceIn(0, 100)
            builder.setContentText(getString(R.string.download_progress_with_total, formatBytes(bytesWritten), formatBytes(totalLength)))
            builder.setProgress(100, pct, false)
        } else {
            builder.setContentText(getString(R.string.download_progress_bytes_only, formatBytes(bytesWritten)))
            builder.setProgress(0, 0, true)
        }
        runCatching {
            NotificationManagerCompat.from(this).notify(streamDownloadNotificationId, builder.build())
        }.onFailure { Log.w(tag, "Failed to post stream progress notification", it) }
    }

    private fun postStreamSuccessNotification(fileName: String, targetUri: Uri, mimeType: String) {
        if (!hasPostNotificationsPermission()) return
        ensureMessageNotificationChannels()
        val openIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(targetUri, mimeType.ifBlank { "application/octet-stream" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val openPending = PendingIntent.getActivity(
            this,
            streamDownloadNotificationId,
            openIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val builder = NotificationCompat.Builder(this, messageProgressNotificationChannelId)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(fileName)
            .setContentText(getString(R.string.download_saved, fileName))
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(openPending)
        runCatching {
            val nm = NotificationManagerCompat.from(this)
            nm.cancel(streamDownloadNotificationId)
            nm.notify(streamDownloadTerminalNotificationId, builder.build())
        }.onFailure { Log.w(tag, "Failed to post stream success notification", it) }
    }

    private fun postStreamFailureNotification(fileName: String, reason: String? = null) {
        if (!hasPostNotificationsPermission()) return
        ensureMessageNotificationChannels()
        val text = if (reason.isNullOrBlank()) {
            getString(R.string.download_failed)
        } else {
            getString(R.string.download_failed) + " (" + reason + ")"
        }
        val builder = NotificationCompat.Builder(this, messageProgressNotificationChannelId)
            .setSmallIcon(R.drawable.ic_notification_runtime)
            .setContentTitle(fileName)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(buildOpenAppPendingIntent())
        runCatching {
            val nm = NotificationManagerCompat.from(this)
            nm.cancel(streamDownloadNotificationId)
            nm.notify(streamDownloadTerminalNotificationId, builder.build())
        }.onFailure { Log.w(tag, "Failed to post stream failure notification", it) }
    }

    private fun buildOpenAppPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun hasPostNotificationsPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun enqueueStreamRequest(req: StreamRequest) {
        val resolvedUrl = resolveDownloadUrl(req.url)
        val resolvedUri = resolvedUrl?.let { runCatching { Uri.parse(it) }.getOrNull() }
        if (resolvedUrl == null || resolvedUri == null || !isWebViewSameOrigin(resolvedUri)) {
            Log.w(tag, "Rejecting stream download to non-same-origin URL: ${req.url}")
            showStreamDownloadFailure(req.fileName, "origin reject: ${req.url}")
            return
        }
        val resolved = req.copy(url = resolvedUrl)
        synchronized(streamQueueLock) {
            streamRequestQueue.add(resolved)
        }
        pumpStreamQueue()
    }

    private fun isWebViewSameOrigin(targetUri: Uri): Boolean {
        val targetScheme = targetUri.scheme?.lowercase() ?: return false
        if (targetScheme != "http" && targetScheme != "https") return false
        val targetHost = targetUri.host ?: return false
        val targetPort = effectivePort(targetScheme, targetUri.port)

        val webUrl = if (this::webView.isInitialized) webView.url else null
        if (!webUrl.isNullOrBlank()) {
            val webUri = runCatching { Uri.parse(webUrl) }.getOrNull()
            val webScheme = webUri?.scheme?.lowercase()
            val webHost = webUri?.host
            if (webUri != null && webScheme != null && webHost != null &&
                (webScheme == "http" || webScheme == "https")
            ) {
                val webPort = effectivePort(webScheme, webUri.port)
                return webScheme == targetScheme &&
                    webHost.equals(targetHost, ignoreCase = true) &&
                    webPort == targetPort
            }
        }

        return LukerRuntimeManager.isSameOriginUrl(targetUri)
    }

    private fun effectivePort(scheme: String, port: Int): Int {
        if (port != -1) return port
        return if (scheme == "https") 443 else 80
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes < 1024) return "${bytes} B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var value = bytes.toDouble() / 1024.0
        var unitIndex = 0
        while (value >= 1024.0 && unitIndex < units.size - 1) {
            value /= 1024.0
            unitIndex++
        }
        return String.format(Locale.ROOT, "%.1f %s", value, units[unitIndex])
    }

    private fun registerApkDownloadReceiver() {
        if (apkDownloadReceiverRegistered) {
            return
        }
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(apkDownloadReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(apkDownloadReceiver, filter)
        }
        apkDownloadReceiverRegistered = true
    }

    private fun enqueueApkInstallDownload(url: String, suggestedName: String?) {
        val parsedUri = runCatching { Uri.parse(url) }.getOrNull()
        val scheme = parsedUri?.scheme?.lowercase()
        if (parsedUri == null || (scheme != "http" && scheme != "https")) {
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            return
        }

        if (pendingApkDownloadId != null) {
            Toast.makeText(this, getString(R.string.update_download_in_progress), Toast.LENGTH_SHORT).show()
            return
        }

        val baseName = sanitizeFileName(suggestedName, getString(R.string.update_default_apk_file_name))
        val fileName = if (baseName.lowercase().endsWith(".apk")) baseName else "$baseName.apk"
        try {
            val request = DownloadManager.Request(parsedUri).apply {
                setTitle(fileName)
                setMimeType("application/vnd.android.package-archive")
                setDescription(getString(R.string.update_download_queued))
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            }
            val manager = getSystemService(DownloadManager::class.java)
            pendingApkDownloadId = manager.enqueue(request)
            Toast.makeText(this, getString(R.string.update_download_started), Toast.LENGTH_SHORT).show()
        } catch (t: Throwable) {
            pendingApkDownloadId = null
            Log.e(tag, "Failed to enqueue APK update download: $url", t)
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleApkDownloadFinished(downloadId: Long) {
        try {
            val manager = getSystemService(DownloadManager::class.java)
            val query = DownloadManager.Query().setFilterById(downloadId)
            manager.query(query).use { cursor ->
                if (!cursor.moveToFirst()) {
                    Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                    return
                }

                val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                if (status != DownloadManager.STATUS_SUCCESSFUL) {
                    Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                    return
                }
            }

            val apkUri = manager.getUriForDownloadedFile(downloadId)
            if (apkUri == null) {
                Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
                return
            }

            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            try {
                startActivity(installIntent)
                Toast.makeText(this, getString(R.string.update_install_prompt), Toast.LENGTH_SHORT).show()
            } catch (e: ActivityNotFoundException) {
                Log.e(tag, "No activity can handle APK install intent", e)
                Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
            }
        } catch (t: Throwable) {
            Log.e(tag, "Failed to process completed APK download", t)
            Toast.makeText(this, getString(R.string.download_failed), Toast.LENGTH_SHORT).show()
        }
    }

    private fun parseDataUrl(dataUrl: String): Pair<String, ByteArray>? {
        if (!dataUrl.startsWith("data:", ignoreCase = true)) {
            return null
        }
        val separatorIndex = dataUrl.indexOf(',')
        if (separatorIndex <= 5) {
            return null
        }
        val metadata = dataUrl.substring(5, separatorIndex)
        val payload = dataUrl.substring(separatorIndex + 1)
        val mimeType = metadata.substringBefore(';').ifBlank { "application/octet-stream" }
        val bytes = try {
            if (metadata.contains(";base64", ignoreCase = true)) {
                Base64.decode(payload, Base64.DEFAULT)
            } else {
                Uri.decode(payload).toByteArray(Charsets.UTF_8)
            }
        } catch (t: Throwable) {
            Log.e(tag, "Failed to decode data URL payload", t)
            return null
        }
        return mimeType to bytes
    }

    private fun sanitizeFileName(
        input: String?,
        fallback: String = getString(R.string.download_default_file_name),
    ): String {
        if (input.isNullOrBlank()) {
            return fallback
        }
        return input.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), "_").trim().ifBlank { fallback }
    }

    private fun buildHttpAuthKey(host: String, realm: String): Pair<String, String> {
        return host.trim().lowercase(Locale.ROOT) to realm.trim()
    }

    private fun showHttpAuthDialog(
        handler: HttpAuthHandler,
        host: String,
        realm: String,
        prefill: LukerHttpAuthStore.Credentials?,
    ) {
        if (isFinishing || isDestroyed) {
            handler.cancel()
            return
        }

        httpAuthDialog?.cancel()

        val padding = (20 * resources.displayMetrics.density).toInt()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, 0)
        }
        val descriptionView = TextView(this).apply {
            text = buildString {
                append(getString(R.string.http_auth_dialog_message))
                if (host.isNotBlank()) {
                    append("\n\n")
                    append(getString(R.string.http_auth_dialog_host, host))
                }
                if (realm.isNotBlank()) {
                    append('\n')
                    append(getString(R.string.http_auth_dialog_realm, realm))
                }
            }
        }
        val usernameInput = EditText(this).apply {
            hint = getString(R.string.http_auth_dialog_username_hint)
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
            setAutofillHints(View.AUTOFILL_HINT_USERNAME)
            setText(prefill?.username.orEmpty())
            setSelection(text.length)
        }
        val passwordInput = EditText(this).apply {
            hint = getString(R.string.http_auth_dialog_password_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setSingleLine(true)
            setAutofillHints(View.AUTOFILL_HINT_PASSWORD)
            setText(prefill?.password.orEmpty())
            setSelection(text.length)
        }
        container.addView(descriptionView)
        container.addView(
            usernameInput,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = padding / 2
            },
        )
        container.addView(
            passwordInput,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                topMargin = padding / 3
            },
        )

        val authKey = buildHttpAuthKey(host, realm)
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.http_auth_dialog_title)
            .setView(container)
            .setPositiveButton(R.string.http_auth_dialog_login, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val credentials = LukerHttpAuthStore.Credentials(
                    username = usernameInput.text?.toString().orEmpty(),
                    password = passwordInput.text?.toString().orEmpty(),
                )
                LukerHttpAuthStore.save(applicationContext, host, realm, credentials)
                recentHttpAuthAttempts[authKey] = credentials
                dialog.dismiss()
                handler.proceed(credentials.username, credentials.password)
            }
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
                dialog.cancel()
            }
        }
        dialog.setOnCancelListener {
            handler.cancel()
        }
        dialog.setOnDismissListener {
            if (httpAuthDialog === dialog) {
                httpAuthDialog = null
            }
        }

        httpAuthDialog = dialog
        dialog.show()
    }

    private fun bootstrapConfiguredEndpoint() {
        val selection = LukerEndpointConfig.load(applicationContext)
        val bootstrapToken = bootstrapSequence.incrementAndGet()
        runtimeFailureDialogShown = false
        loadingOverlay.visibility = View.VISIBLE
        LukerEndpointStatusNotification.sync(applicationContext, selection)

        if (!selection.usesDefaultLocalRuntime) {
            val baseUrl = selection.resolveBaseUrl()
            LukerRuntimeForegroundService.stop(applicationContext)
            loadingText.text = getString(R.string.loading_custom_endpoint, baseUrl)
            webView.stopLoading()
            webView.loadUrl(baseUrl)
            return
        }

        loadingText.setText(R.string.loading_runtime)

        val watchdogResult = LukerBootWatchdog.detectAndArm(
            applicationContext,
            LukerRuntimeManager.dataRootFor(applicationContext),
        )
        if (watchdogResult.tripped) {
            Log.w(
                tag,
                "Boot watchdog tripped (streak=${watchdogResult.failedStreak}, sentinel=${watchdogResult.sentinelPath}). " +
                    "Safe mode will be applied on this launch.",
            )
            runOnUiThread {
                if (isBootstrapCurrent(bootstrapToken) && !isFinishing && !isDestroyed) {
                    Toast.makeText(
                        this,
                        getString(R.string.safe_mode_tripped_toast),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }

        Thread {
            try {
                if (!isBootstrapCurrent(bootstrapToken)) {
                    return@Thread
                }
                val result = LukerRuntimeManager.startIfNeeded(applicationContext)
                if (!result.ok) {
                    if (!isBootstrapCurrent(bootstrapToken)) {
                        return@Thread
                    }
                    val detail = result.error?.trim()?.takeIf { it.isNotEmpty() }
                    val diagnostics = collectRuntimeDiagnosticsSafe()
                    val fallbackReason = getString(R.string.runtime_failure_reason_unknown)
                    Log.e(tag, "Runtime start failed: ${detail ?: fallbackReason}\n$diagnostics")
                    reportRuntimeFailure(detail ?: fallbackReason, diagnostics)
                    return@Thread
                }
                if (!isBootstrapCurrent(bootstrapToken)) {
                    return@Thread
                }
                LukerRuntimeForegroundService.start(applicationContext)

                runOnUiThread {
                    if (isBootstrapCurrent(bootstrapToken)) {
                        loadingText.setText(R.string.loading_webview)
                    }
                }
                waitUntilServerReady(SERVER_READY_TOTAL_BUDGET_MS, SERVER_READY_POLL_DELAY_MS, bootstrapToken)
            } catch (t: Throwable) {
                if (!isBootstrapCurrent(bootstrapToken)) {
                    return@Thread
                }
                Log.e(tag, "bootstrapRuntime crashed", t)
                val diagnostics = collectRuntimeDiagnosticsSafe()
                reportRuntimeFailure(
                    t.message ?: getString(R.string.runtime_failure_reason_unknown_error),
                    diagnostics,
                    t,
                )
            }
        }.start()
    }

    private fun waitUntilServerReady(totalBudgetMs: Long, delayMs: Long, bootstrapToken: Int) {
        val deadline = System.currentTimeMillis() + totalBudgetMs
        while (isBootstrapCurrent(bootstrapToken)) {
            if (LukerRuntimeManager.isServerReady()) {
                LukerBootWatchdog.markBootSucceeded(applicationContext)
                runOnUiThread {
                    if (isBootstrapCurrent(bootstrapToken)) {
                        webView.loadUrl(LukerRuntimeManager.SERVER_URL)
                    }
                }
                return
            }

            if (!LukerRuntimeManager.isNodeProcessRunning()) {
                val diagnostics = LukerRuntimeManager.collectDiagnostics(applicationContext)
                Log.e(tag, "Node runtime stopped before server became ready.\n$diagnostics")
                reportRuntimeFailure(getString(R.string.runtime_failure_reason_node_exited), diagnostics)
                return
            }

            if (System.currentTimeMillis() >= deadline) {
                val diagnostics = LukerRuntimeManager.collectDiagnostics(applicationContext)
                Log.e(tag, "Server readiness timed out.\n$diagnostics")
                reportRuntimeFailure(getString(R.string.loading_failed_timeout), diagnostics)
                return
            }

            Thread.sleep(delayMs)
        }
    }

    private fun isBootstrapCurrent(bootstrapToken: Int): Boolean {
        return bootstrapSequence.get() == bootstrapToken && !isDestroyed && !isFinishing
    }

    private fun maybePromptForCustomEndpointOnLaunch(savedInstanceState: Bundle?, launchAction: String?) {
        if (savedInstanceState != null || launchAction == ACTION_OPEN_ENDPOINT_SETTINGS) {
            return
        }
        val selection = LukerEndpointConfig.load(applicationContext)
        if (!selection.usesDefaultLocalRuntime) {
            window.decorView.post { showEndpointDialog() }
        }
    }

    private fun handleLaunchIntent(intent: Intent?) {
        when (intent?.action) {
            ACTION_OPEN_ENDPOINT_SETTINGS -> {
                intent.action = null
                window.decorView.post { showEndpointDialog() }
            }
            ACTION_RELOAD_WEBVIEW -> {
                intent.action = null
                if (this::webView.isInitialized) {
                    webView.reload()
                }
            }
        }
    }

    private fun showEndpointDialog() {
        if (isFinishing || isDestroyed) {
            return
        }
        endpointDialog?.takeIf { it.isShowing }?.let { return }

        val selection = LukerEndpointConfig.load(applicationContext)
        val padding = (20 * resources.displayMetrics.density).toInt()
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, 0)
        }
        val descriptionView = TextView(this).apply {
            text = buildString {
                append(
                    if (selection.usesDefaultLocalRuntime) {
                        getString(R.string.endpoint_dialog_current_default)
                    } else {
                        getString(R.string.endpoint_dialog_current_custom, selection.resolveBaseUrl())
                    },
                )
                append("\n\n")
                append(getString(R.string.endpoint_dialog_message))
            }
        }
        val inputView = EditText(this).apply {
            hint = getString(R.string.endpoint_dialog_hint)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            setText(selection.customBaseUrl.orEmpty())
            setSelection(text.length)
        }
        container.addView(descriptionView)
        container.addView(
            inputView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ),
        )

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.endpoint_dialog_title)
            .setView(container)
            .setPositiveButton(R.string.endpoint_dialog_save, null)
            .setNeutralButton(R.string.endpoint_dialog_reset_default, null)
            .setNegativeButton(R.string.endpoint_dialog_continue, null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val normalizedEndpoint = LukerEndpointConfig.normalizeCustomBaseUrl(inputView.text?.toString())
                if (normalizedEndpoint == null) {
                    inputView.error = getString(R.string.endpoint_invalid_url)
                    return@setOnClickListener
                }
                LukerEndpointConfig.saveCustom(applicationContext, normalizedEndpoint)
                Toast.makeText(
                    this,
                    getString(R.string.endpoint_saved, normalizedEndpoint),
                    Toast.LENGTH_SHORT,
                ).show()
                dialog.dismiss()
                bootstrapConfiguredEndpoint()
            }
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                LukerEndpointConfig.resetToDefault(applicationContext)
                Toast.makeText(
                    this,
                    getString(R.string.endpoint_reset_default_done),
                    Toast.LENGTH_SHORT,
                ).show()
                dialog.dismiss()
                bootstrapConfiguredEndpoint()
            }
        }
        dialog.setOnDismissListener {
            if (endpointDialog === dialog) {
                endpointDialog = null
            }
        }

        endpointDialog = dialog
        dialog.show()
    }

    private fun collectRuntimeDiagnosticsSafe(): String {
        return runCatching { LukerRuntimeManager.collectDiagnostics(applicationContext) }
            .getOrElse { t -> "diagnostics_unavailable: ${t.message ?: t.javaClass.simpleName}" }
    }

    private fun reportRuntimeFailure(
        reason: String,
        diagnostics: String,
        throwable: Throwable? = null,
    ) {
        val safeReason = reason.trim().ifEmpty { getString(R.string.runtime_failure_reason_unknown_error) }
        val report = buildRuntimeFailureReport(safeReason, diagnostics, throwable)
        val reportFile = runCatching { persistRuntimeReport(report) }.getOrNull()

        runOnUiThread {
            loadingText.text = getString(R.string.loading_failed_with_reason, safeReason)
            if (runtimeFailureDialogShown) {
                return@runOnUiThread
            }
            runtimeFailureDialogShown = true
            showRuntimeFailureDialog(report, reportFile)
        }
    }

    private fun buildRuntimeFailureReport(
        reason: String,
        diagnostics: String,
        throwable: Throwable?,
    ): String {
        val throwableText = throwable?.let {
            val writer = StringWriter()
            PrintWriter(writer).use { printer ->
                throwable.printStackTrace(printer)
            }
            writer.toString().trim()
        }

        return buildString {
            append("reason=").append(reason).append('\n')
            append("server=").append(LukerEndpointConfig.load(applicationContext).resolveBaseUrl()).append('\n')
            append("device=").append(android.os.Build.MANUFACTURER)
                .append(' ')
                .append(android.os.Build.MODEL)
                .append('\n')
            append("android=").append(android.os.Build.VERSION.RELEASE)
                .append(" (sdk=").append(android.os.Build.VERSION.SDK_INT).append(")\n")
            append("package=").append(packageName).append('\n')
            append("timestamp=").append(System.currentTimeMillis()).append('\n')
            if (!throwableText.isNullOrEmpty()) {
                append("\nstacktrace:\n").append(throwableText).append('\n')
            }
            append("\ndiagnostics:\n").append(diagnostics.trim())
        }
    }

    private fun persistRuntimeReport(report: String): File {
        val file = File(filesDir, runtimeReportFileName)
        file.writeText(report, Charsets.UTF_8)
        return file
    }

    private fun showRuntimeFailureDialog(report: String, reportFile: File?) {
        val fullReportFile = writeFullReportFile(report) ?: reportFile
        showReportDialog(
            titleRes = R.string.runtime_error_dialog_title,
            introRes = R.string.runtime_error_dialog_intro,
            shareSubjectRes = R.string.runtime_error_share_subject,
            summary = buildCrashSummary(report),
            fullReportFile = fullReportFile,
        )
    }

    private fun showWebViewCrashDialog(report: String, reportFile: File?) {
        val fullReportFile = writeFullReportFile(report) ?: reportFile
        showReportDialog(
            titleRes = R.string.webview_crash_dialog_title,
            introRes = R.string.webview_crash_dialog_intro,
            shareSubjectRes = R.string.webview_crash_share_subject,
            summary = buildCrashSummary(report),
            fullReportFile = fullReportFile,
            onDismiss = {
                if (!isFinishing && !isDestroyed) {
                    recreate()
                }
            },
        )
    }

    private fun showReportDialog(
        titleRes: Int,
        introRes: Int,
        shareSubjectRes: Int,
        summary: String,
        fullReportFile: File?,
        onDismiss: (() -> Unit)? = null,
    ) {
        val message = buildString {
            append(getString(introRes))
            append("\n\n")
            append(summary)
            if (fullReportFile != null) {
                append('\n').append(getString(R.string.runtime_error_report_saved, fullReportFile.absolutePath))
            }
            if (!LukerAndroidDebugConfig.isEnabled(applicationContext)) {
                append(getString(R.string.crash_dialog_debug_hint))
            }
        }

        AlertDialog.Builder(this)
            .setTitle(titleRes)
            .setMessage(message)
            .setPositiveButton(R.string.diagnostics_export_bundle) { _, _ ->
                exportAndShareDiagnosticsBundle(shareSubjectRes)
            }
            .setNegativeButton(R.string.crash_dialog_close, null)
            .setOnDismissListener { onDismiss?.invoke() }
            .setCancelable(false)
            .show()
    }

    private fun exportAndShareDiagnosticsBundle(shareSubjectRes: Int) {
        runCatching {
            val export = LukerDiagnosticsExporter.exportTo(applicationContext)
            val intent = Intent(export.intent).apply {
                putExtra(Intent.EXTRA_SUBJECT, getString(shareSubjectRes))
            }
            startActivity(Intent.createChooser(intent, getString(R.string.diagnostics_export_bundle)))
            Toast.makeText(
                this,
                getString(R.string.diagnostics_export_saved, export.zip.absolutePath),
                Toast.LENGTH_LONG,
            ).show()
        }.onFailure { t ->
            Log.w(tag, "Failed to export diagnostics bundle", t)
            Toast.makeText(
                this,
                getString(R.string.diagnostics_export_failed, t.message ?: t.javaClass.simpleName),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    private fun appendLogcatTails(sb: StringBuilder, context: Context) {
        sb.append("\n\n--- logcat tail ---\n")
        val current = LukerLogcatTail.currentLogFile(context)
        val last = LukerLogcatTail.lastLogFile(context)
        if (!current.isFile && !last.isFile) {
            sb.append("<not recorded>")
            return
        }
        val tailLimit = 64 * 1024L
        if (last.isFile) {
            sb.append("--- last ---\n").append(readTailUtf8(last, tailLimit)).append('\n')
        }
        if (current.isFile) {
            sb.append("--- current ---\n").append(readTailUtf8(current, tailLimit))
        }
    }

    private fun readTailUtf8(file: File, maxBytes: Long): String {
        if (!file.isFile) return ""
        val length = file.length()
        if (length <= maxBytes) return file.readText(Charsets.UTF_8)
        return file.inputStream().use { input ->
            val skip = length - maxBytes
            var remaining = skip
            val buf = ByteArray(8192)
            while (remaining > 0) {
                val toSkip = minOf(remaining, buf.size.toLong())
                val skipped = input.read(buf, 0, toSkip.toInt())
                if (skipped <= 0) break
                remaining -= skipped
            }
            input.readBytes().toString(Charsets.UTF_8)
        }
    }

    private fun writeFullReportFile(enriched: String): File? {
        val target = File(filesDir, FULL_REPORT_FILE_NAME)
        val direct = runCatching { target.writeText(enriched, Charsets.UTF_8); target }.getOrNull()
        if (direct != null) return direct
        return runCatching {
            target.writeText("full report write failed: <see logcat>", Charsets.UTF_8)
            target
        }.getOrNull()
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) {
            webView.removeCallbacks(forceWebViewVisibleRunnable)
        }
        backgroundKeepAliveEnabled = false
        endpointDialog?.dismiss()
        endpointDialog = null
        httpAuthDialog?.cancel()
        httpAuthDialog = null
        pendingFilePathCallback?.onReceiveValue(null)
        pendingFilePathCallback = null
        pendingWebPermissionRequest?.deny()
        pendingWebPermissionRequest = null
        pendingWebPermissionResources = null
        pendingSaveBytes = null
        pendingSaveMimeType = null
        pendingSaveFileName = null
        pendingApkDownloadId = null
        if (apkDownloadReceiverRegistered) {
            runCatching { unregisterReceiver(apkDownloadReceiver) }
            apkDownloadReceiverRegistered = false
        }
        super.onDestroy()
    }

    companion object {
        const val ACTION_OPEN_ENDPOINT_SETTINGS = "com.luker.app.action.OPEN_ENDPOINT_SETTINGS"
        const val ACTION_RELOAD_WEBVIEW = "com.luker.app.action.RELOAD_WEBVIEW"
        const val FULL_REPORT_FILE_NAME = "luker-last-crash-full-report.txt"
        private const val SERVER_READY_TOTAL_BUDGET_MS: Long = 240_000L
        private const val SERVER_READY_POLL_DELAY_MS: Long = 100L
    }

    private data class StreamRequest(
        val id: String,
        val url: String,
        val method: String,
        val headers: Map<String, String>,
        val body: ByteArray?,
        val fileName: String,
        val mimeType: String,
    )
}
