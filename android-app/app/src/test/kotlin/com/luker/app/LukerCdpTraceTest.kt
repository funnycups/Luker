// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayOutputStream
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
class LukerCdpTraceTest {

    @Test
    fun begin_requests_report_events_and_writes_json_header() {
        val channel = FakeChannel(listOf("""{"id":1,"result":{}}"""))
        val sink = ByteArrayOutputStream()

        val session = TraceSession(channel, sink)
        session.begin()

        assertTrue(channel.sent[0].contains("Tracing.start"))
        assertTrue(channel.sent[0].contains("ReportEvents"))
        assertEquals("""{"traceEvents":[""", sink.toString("UTF-8"))
        assertTrue(session.isOpen)
    }

    @Test
    fun finish_streams_data_collected_events_and_seals_valid_json() {
        val channel = FakeChannel(
            listOf(
                """{"id":1,"result":{}}""",
                """{"method":"Tracing.dataCollected","params":{"value":[{"name":"a","ph":"X","ts":1,"dur":2}]}}""",
                """{"method":"Tracing.dataCollected","params":{"value":[{"name":"b","ph":"I","ts":5}]}}""",
                """{"method":"Tracing.tracingComplete","params":{}}""",
            ),
        )
        val sink = ByteArrayOutputStream()
        val session = TraceSession(channel, sink)
        session.begin()

        val written = session.finish()
        val text = sink.toString("UTF-8")

        assertTrue(text.endsWith("]}\n"))
        assertEquals(sink.size().toLong(), written)
        val parsed = JSONObject(text)
        val events = parsed.getJSONArray("traceEvents")
        assertEquals(2, events.length())
        assertEquals("a", events.getJSONObject(0).getString("name"))
        assertEquals("b", events.getJSONObject(1).getString("name"))
        assertFalse(session.isOpen)
    }

    @Test
    fun seal_if_open_after_unexpected_eof_preserves_partial_valid_json() {
        val eofChannel = object : CdpChannel {
            val sent = mutableListOf<String>()
            private val messages = listOf(
                """{"id":1,"result":{}}""",
                """{"method":"Tracing.dataCollected","params":{"value":[{"name":"partial","ph":"X","ts":10,"dur":4}]}}""",
            )
            private var index = 0

            override fun sendText(text: String) {
                sent.add(text)
            }

            override fun readMessage(): String {
                if (index >= messages.size) {
                    throw IOException("ws-read: close frame received")
                }
                return messages[index++]
            }
        }

        val sink = ByteArrayOutputStream()
        val session = TraceSession(eofChannel, sink)
        session.begin()

        // Pump until channel hits EOF, simulating renderer crash mid-trace
        try {
            session.pumpUntilClosed()
        } catch (_: IOException) {
            // expected EOF
        }
        val written = session.sealIfOpen()
        val text = sink.toString("UTF-8")

        assertTrue(text.endsWith("]}\n"))
        assertEquals(sink.size().toLong(), written)
        val parsed = JSONObject(text)
        assertEquals(1, parsed.getJSONArray("traceEvents").length())
        assertEquals("partial", parsed.getJSONArray("traceEvents").getJSONObject(0).getString("name"))
        assertFalse(session.isOpen)
    }

    @Test
    fun is_active_recording_becomes_false_immediately_while_finish_is_draining() {
        val enterFinishRead = java.util.concurrent.CountDownLatch(1)
        val releaseComplete = java.util.concurrent.CountDownLatch(1)
        val blockingChannel = object : CdpChannel {
            private var sentStartAck = false
            override fun sendText(text: String) {}
            override fun readMessage(): String {
                if (!sentStartAck) {
                    sentStartAck = true
                    return """{"id":1,"result":{}}"""
                }
                enterFinishRead.countDown()
                releaseComplete.await()
                return """{"method":"Tracing.tracingComplete","params":{}}"""
            }
        }

        val session = TraceSession(blockingChannel, ByteArrayOutputStream())
        session.begin()
        assertTrue(session.isActiveRecording)

        val worker = Thread { session.finish() }
        worker.start()
        enterFinishRead.await()

        assertFalse(session.isActiveRecording)
        releaseComplete.countDown()
        worker.join(2_000)
        assertFalse(session.isOpen)
        assertFalse(session.isActiveRecording)
    }
}
