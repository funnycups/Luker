// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.net.LocalSocket
import android.net.LocalSocketAddress
import java.io.DataInputStream
import java.io.IOException
import org.json.JSONArray
import org.json.JSONObject

/**
 * Connection primitives shared by the always-on collector client and the
 * on-demand capture sessions. Locates the abstract devtools socket for a
 * renderer pid, reads the `/json/list` response, and picks our own page
 * target out of it.
 *
 * Nothing here reports failures to a collector: a socket that cannot be
 * reached or a body that cannot be parsed throws [IOException], and a list
 * without a matching target yields `null`. Callers decide what that means.
 */
object LukerCdpTarget {

    const val SOCKET_NAME_PREFIX = "webview_devtools_remote_"
    const val ALLOWED_URL_PREFIX = "http://127.0.0.1:"

    fun socketName(pid: Int): String = "$SOCKET_NAME_PREFIX$pid"

    /**
     * Reads the HTTP response head off [input] and returns exactly
     * `Content-Length` bytes of body, decoded as UTF-8.
     */
    fun readHttpBody(input: DataInputStream): String {
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
        val statusMatch = Regex("^HTTP/\\d+\\.\\d+\\s+(\\d+)").find(headers)
        val status = statusMatch?.groupValues?.get(1)?.toIntOrNull()
        if (status != null && status >= 400) {
            throw IOException("http: status $status")
        }
        val lenMatch = Regex("(?i)Content-Length:\\s*(\\d+)").find(headers)
        val len = lenMatch?.groupValues?.get(1)?.toIntOrNull() ?: throw IOException("http: no Content-Length")
        val body = ByteArray(len)
        input.readFully(body)
        return String(body, Charsets.UTF_8)
    }

    /** Returns the first `page` target whose URL is served by our local server. */
    fun selectTarget(json: String): JSONObject? {
        val arr = JSONArray(json)
        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            if (obj.optString("type") == "page" &&
                obj.optString("url").startsWith(ALLOWED_URL_PREFIX)
            ) {
                return obj
            }
        }
        return null
    }

    /** Returns the `/devtools/...` WebSocket path of a target URL, or `""`. */
    fun extractPath(url: String): String {
        val idx = url.indexOf("/devtools/")
        return if (idx >= 0) url.substring(idx) else ""
    }

    /** Returns the browser-level `/devtools/...` WebSocket path from `/json/version` JSON, or `""`. */
    fun selectBrowserPath(versionJson: String): String {
        val url = JSONObject(versionJson).optString("webSocketDebuggerUrl", "")
        return extractPath(url)
    }

    /** Performs an HTTP GET against [path] over the abstract devtools socket for [pid]. */
    fun fetchHttpBody(pid: Int, path: String): String {
        LocalSocket().use { sock ->
            sock.connect(LocalSocketAddress(socketName(pid), LocalSocketAddress.Namespace.ABSTRACT))
            val out = sock.outputStream
            out.write("GET $path HTTP/1.1\r\nHost: localhost\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            out.flush()
            val input = DataInputStream(sock.inputStream)
            return readHttpBody(input)
        }
    }

    /**
     * Opens the abstract devtools socket for [pid] and returns the matching
     * target, or `null` when the list holds no local page.
     */
    fun fetchTarget(pid: Int): JSONObject? =
        selectTarget(fetchHttpBody(pid, "/json/list"))

    /**
     * Opens the abstract devtools socket for [pid] and returns the browser-level
     * WebSocket path advertised by `/json/version`, or `null` when unavailable.
     */
    fun fetchBrowserPath(pid: Int): String? =
        try {
            selectBrowserPath(fetchHttpBody(pid, "/json/version")).takeIf { it.isNotEmpty() }
        } catch (t: Throwable) {
            LukerDebugTrail.append("native", "cdp-target version-probe-fail err=${t.message ?: t.javaClass.simpleName}")
            null
        }
}
