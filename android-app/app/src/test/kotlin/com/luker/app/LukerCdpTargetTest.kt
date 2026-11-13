// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
class LukerCdpTargetTest {

    @Test
    fun extract_path_keeps_from_devtools_onward() {
        assertEquals(
            "/devtools/page/ABC",
            LukerCdpTarget.extractPath("ws://127.0.0.1:9222/devtools/page/ABC"),
        )
    }

    @Test
    fun extract_path_is_empty_without_devtools_segment() {
        assertEquals("", LukerCdpTarget.extractPath("ws://127.0.0.1:9222/json/list"))
    }

    @Test
    fun select_target_picks_the_local_page() {
        val json = """
            [{"type":"service_worker","url":"http://127.0.0.1:8000/sw.js"},
             {"type":"page","url":"http://127.0.0.1:8000/index.html","webSocketDebuggerUrl":"ws://x/devtools/page/A"}]
        """.trimIndent()

        assertEquals("ws://x/devtools/page/A", LukerCdpTarget.selectTarget(json)?.optString("webSocketDebuggerUrl"))
    }

    @Test
    fun select_target_skips_non_local_and_non_page_entries() {
        val json = """
            [{"type":"page","url":"https://example.com/","webSocketDebuggerUrl":"ws://x/devtools/page/B"},
             {"type":"other","url":"http://127.0.0.1:8000/","webSocketDebuggerUrl":"ws://x/devtools/page/C"}]
        """.trimIndent()

        assertNull(LukerCdpTarget.selectTarget(json))
    }

    @Test
    fun read_http_body_returns_exactly_content_length_bytes() {
        val raw = "HTTP/1.1 200 OK\r\ncontent-length: 7\r\n\r\n[{\"a\":1}]"
        val body = LukerCdpTarget.readHttpBody(DataInputStream(ByteArrayInputStream(raw.toByteArray())))

        assertEquals("[{\"a\":1", body)
    }

    @Test(expected = IOException::class)
    fun read_http_body_rejects_a_response_without_content_length() {
        val raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
        LukerCdpTarget.readHttpBody(DataInputStream(ByteArrayInputStream(raw.toByteArray())))
    }

    @Test
    fun select_browser_path_extracts_devtools_browser_websocket_path() {
        val json = """{"Browser":"Chrome/144.0.0.0","webSocketDebuggerUrl":"ws://localhost/devtools/browser/abc-123"}"""
        assertEquals("/devtools/browser/abc-123", LukerCdpTarget.selectBrowserPath(json))
    }

    @Test
    fun select_browser_path_returns_empty_when_websocket_url_missing() {
        assertEquals("", LukerCdpTarget.selectBrowserPath("""{"Browser":"Chrome/144.0.0.0"}"""))
        assertEquals("", LukerCdpTarget.selectBrowserPath("{}"))
    }
}
