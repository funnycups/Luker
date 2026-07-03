// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.DataInputStream
import java.io.IOException
import org.json.JSONObject

/**
 * One per detected renderer pid. Talks HTTP GET /json/list over
 * @webview_devtools_remote_<pid>, filters for a target whose URL starts with
 * http://127.0.0.1: (our local server), opens a WebSocket to its
 * webSocketDebuggerUrl, subscribes to Log/Runtime/Inspector, and forwards
 * every incoming CDP message string to the collector's writer queue.
 *
 * On any IOException the thread exits and the collector removes itself
 * from the clients map; DiscoveryThread will not re-spawn if the pid is
 * in failedPids with count >= 3.
 */
class LukerCdpClient(
    val pid: Int,
    private val collector: LukerCdpCollector,
) : Thread("luker-cdp-client-$pid") {

    @Volatile var stopping = false
    @Volatile private var socket: LocalSocket? = null

    init { isDaemon = true }

    fun requestStop() {
        stopping = true
        runCatching { socket?.close() }
    }

    companion object {
        private const val SOCKET_NAME_PREFIX = "webview_devtools_remote_"
        private const val ALLOWED_URL_PREFIX = "http://127.0.0.1:"
    }

    override fun run() {
        try {
            val target = fetchTarget() ?: return
            val wsPath = extractPath(target.optString("webSocketDebuggerUrl", ""))
            if (wsPath.isEmpty()) {
                LukerDebugTrail.append("native", "cdp-collector state=no-ws-path pid=$pid")
                collector.markFailedPid(pid)
                return
            }
            runWebSocket(wsPath)
        } catch (e: IOException) {
            LukerDebugTrail.append("native", "cdp-collector state=client-io pid=$pid err=${e.message ?: "io"}")
            collector.markFailedPid(pid)
        } catch (t: Throwable) {
            LukerDebugTrail.append("native", "cdp-collector state=client-err pid=$pid err=${t.message ?: t.javaClass.simpleName}")
            collector.markFailedPid(pid)
        } finally {
            collector.removeClient(pid)
        }
    }

    private fun fetchTarget(): JSONObject? {
        LocalSocket().use { sock ->
            sock.connect(LocalSocketAddress("$SOCKET_NAME_PREFIX$pid", LocalSocketAddress.Namespace.ABSTRACT))
            val out = sock.outputStream
            out.write("GET /json/list HTTP/1.1\r\nHost: localhost\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            out.flush()
            val input = DataInputStream(sock.inputStream)
            val body = readHttpBody(input)
            val arr = org.json.JSONArray(body)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                if (obj.optString("type") == "page" &&
                    obj.optString("url").startsWith(ALLOWED_URL_PREFIX)) {
                    return obj
                }
            }
            LukerDebugTrail.append("native", "cdp-collector state=no-target pid=$pid targets=${arr.length()}")
            collector.markFailedPid(pid)
            return null
        }
    }

    private fun readHttpBody(input: DataInputStream): String {
        val headerBuf = StringBuilder()
        var crlfCrlf = 0
        while (crlfCrlf < 4) {
            val b = input.read()
            if (b == -1) throw IOException("http: eof in headers")
            headerBuf.append(b.toChar())
            when {
                crlfCrlf == 0 && b == '\r'.code -> crlfCrlf = 1
                crlfCrlf == 1 && b == '\n'.code -> crlfCrlf = 2
                crlfCrlf == 2 && b == '\r'.code -> crlfCrlf = 3
                crlfCrlf == 3 && b == '\n'.code -> crlfCrlf = 4
                else -> crlfCrlf = if (b == '\r'.code) 1 else 0
            }
        }
        val headers = headerBuf.toString()
        val lenMatch = Regex("(?i)Content-Length:\\s*(\\d+)").find(headers)
        val len = lenMatch?.groupValues?.get(1)?.toIntOrNull() ?: throw IOException("http: no Content-Length")
        val body = ByteArray(len)
        input.readFully(body)
        return String(body, Charsets.UTF_8)
    }

    private fun extractPath(url: String): String {
        val idx = url.indexOf("/devtools/")
        return if (idx >= 0) url.substring(idx) else ""
    }

    private fun runWebSocket(wsPath: String) {
        val sock = LocalSocket()
        sock.connect(LocalSocketAddress("$SOCKET_NAME_PREFIX$pid", LocalSocketAddress.Namespace.ABSTRACT))
        socket = sock
        try {
            val ws = LukerWebSocketClient(sock.inputStream, sock.outputStream)
            ws.handshake(wsPath)
            LukerDebugTrail.append("native", "cdp-collector state=bind pid=$pid")
            ws.sendText("""{"id":1,"method":"Log.enable"}""")
            ws.sendText("""{"id":2,"method":"Runtime.enable"}""")
            ws.sendText("""{"id":3,"method":"Inspector.enable"}""")
            while (!stopping) {
                val msg = ws.readMessage()
                val entry = LukerCdpWriter.Entry(pid, System.currentTimeMillis(), msg)
                collector.enqueueEvent(entry)
            }
        } finally {
            socket = null
            runCatching { sock.close() }
        }
    }
}
