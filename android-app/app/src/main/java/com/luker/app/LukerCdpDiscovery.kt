// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import java.io.IOException

/**
 * Waits for the WebView devtools abstract socket to appear, then binds one
 * client to it and stops. The socket name is `@webview_devtools_remote_<pid>`
 * where the pid is the pid of the *browser process that called
 * `WebView.setWebContentsDebuggingEnabled(true)`* — which in our app is
 * always this process itself (see Chromium `aw_devtools_server.cc`
 * `kSocketNameFormat` / `getpid()`).
 *
 * The earlier /proc/net/unix scan-and-discover approach is unusable on
 * Android 10+: /proc/net/* is SELinux-restricted for regular apps (vivo
 * Android 16 EACCES observed in the field). We do not need it — connecting
 * to your own uid's abstract socket is authorized by Chromium's
 * `CanUserConnectToDevTools` (uid == getuid()) and by the kernel (same-uid
 * abstract socket).
 *
 * Only one client is ever needed because one devtools server exposes every
 * target (all pages across all sandboxed renderers) over the same socket
 * via `/json/list`.
 */
class LukerCdpDiscovery(
    private val collector: LukerCdpCollector,
) : Thread("luker-cdp-discovery") {

    @Volatile var stopping = false

    init { isDaemon = true }

    companion object {
        // Poll every 250ms while the socket is not yet up. The devtools
        // server starts asynchronously on the browser IO thread after
        // setWebContentsDebuggingEnabled — typically <500ms after
        // Collector.start(), but can be longer on cold start or slow
        // devices, so we tolerate up to ~30s of misses before giving up.
        //
        // Once the socket is up we drop to a slower reconcile cadence,
        // since the browser-process pid never changes for the lifetime of
        // the process and the only reason to re-check is to re-spawn a
        // client that died (e.g. renderer crash).
        private const val PROBE_INTERVAL_MS = 250L
        private const val RECONCILE_INTERVAL_MS = 2000L
        private const val MAX_PROBE_ATTEMPTS = 120
        private const val SOCKET_NAME_PREFIX = "webview_devtools_remote_"
    }

    override fun run() {
        val myPid = Process.myPid()
        val socketName = "$SOCKET_NAME_PREFIX$myPid"
        val addr = LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT)

        var attempt = 0
        var everConnected = false
        while (!stopping) {
            if (isDevtoolsSocketUp(addr)) {
                if (!everConnected) {
                    LukerDebugTrail.append(
                        "native",
                        "cdp-collector state=socket-up pid=$myPid attempts=${attempt + 1}",
                    )
                    everConnected = true
                    attempt = 0
                }
                // Keep asking the collector to reconcile — no-op if the
                // client is already bound. If the client thread died (e.g.
                // renderer crash tore down the websocket) reconcile will
                // spin up a fresh one, since the browser-process pid never
                // changes and Chromium re-binds a devtools target for the
                // new renderer under the same socket name.
                collector.reconcile(setOf(myPid))
            } else if (!everConnected) {
                attempt++
                if (attempt >= MAX_PROBE_ATTEMPTS) {
                    LukerDebugTrail.append(
                        "native",
                        "cdp-collector state=discovery-give-up pid=$myPid attempts=$attempt reason=socket-never-up",
                    )
                    return
                }
            }
            try {
                sleep(if (everConnected) RECONCILE_INTERVAL_MS else PROBE_INTERVAL_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun isDevtoolsSocketUp(addr: LocalSocketAddress): Boolean {
        return try {
            LocalSocket().use { probe ->
                probe.connect(addr)
                true
            }
        } catch (_: IOException) {
            false
        } catch (_: Throwable) {
            false
        }
    }
}
