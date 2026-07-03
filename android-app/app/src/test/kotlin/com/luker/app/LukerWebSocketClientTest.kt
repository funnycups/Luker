// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import kotlin.experimental.xor

class LukerWebSocketClientTest {

    // -------- helpers --------

    /**
     * Builds a raw server-to-client frame. `masked=true` is only for
     * negative testing (spec-violating server frame); real servers
     * always send unmasked.
     */
    private fun frame(
        fin: Boolean,
        opcode: Int,
        payload: ByteArray,
        masked: Boolean = false,
    ): ByteArray {
        val out = ByteArrayOutputStream()
        val b0 = ((if (fin) 0x80 else 0x00) or (opcode and 0x0F)).toByte()
        out.write(b0.toInt() and 0xFF)
        val maskBit = if (masked) 0x80 else 0x00
        val len = payload.size
        when {
            len < 126 -> out.write(maskBit or len)
            len < 65536 -> {
                out.write(maskBit or 126)
                out.write((len ushr 8) and 0xFF)
                out.write(len and 0xFF)
            }
            else -> {
                out.write(maskBit or 127)
                val v = len.toLong()
                for (shift in 56 downTo 0 step 8) out.write(((v ushr shift) and 0xFF).toInt())
            }
        }
        val mask = ByteArray(4) { (it + 1).toByte() } // deterministic non-zero
        val body: ByteArray
        if (masked) {
            out.write(mask)
            body = ByteArray(payload.size) { i -> payload[i] xor mask[i and 3] }
        } else {
            body = payload
        }
        out.write(body)
        return out.toByteArray()
    }

    /** Builds a fake handshake response line stream. Not used here; we
     *  drive the client past handshake by never calling handshake() — the
     *  public sendText/readMessage do not require it. */
    private fun clientOver(inputBytes: ByteArray): Pair<LukerWebSocketClient, ByteArrayOutputStream> {
        val input: InputStream = ByteArrayInputStream(inputBytes)
        val output = ByteArrayOutputStream()
        return LukerWebSocketClient(input, object : OutputStream() {
            override fun write(b: Int) = output.write(b)
            override fun write(b: ByteArray, off: Int, len: Int) = output.write(b, off, len)
        }) to output
    }

    // -------- outgoing frame mask+xor round trip --------

    @Test
    fun outgoingTextFrameIsMaskedAndXorRoundTrips() {
        val (client, out) = clientOver(ByteArray(0))
        val text = "hello-world"
        client.sendText(text)
        val bytes = out.toByteArray()
        // b0: FIN=1, opcode=TEXT (0x1) → 0x81
        assertEquals(0x81.toByte(), bytes[0])
        // b1: MASK bit set, len=11 (payload length)
        val b1 = bytes[1].toInt() and 0xFF
        assertTrue("MASK bit must be set on client frames", (b1 and 0x80) != 0)
        assertEquals(text.toByteArray(Charsets.UTF_8).size, b1 and 0x7F)
        // mask is at bytes 2..5 (small-len path), masked payload at 6..
        val mask = bytes.copyOfRange(2, 6)
        val masked = bytes.copyOfRange(6, bytes.size)
        val unmasked = ByteArray(masked.size) { i -> masked[i] xor mask[i and 3] }
        assertArrayEquals(text.toByteArray(Charsets.UTF_8), unmasked)
    }

    // -------- incoming masked-server-frame rejection --------

    @Test
    fun maskedServerFrameIsRejected() {
        val bytes = frame(fin = true, opcode = 0x1, payload = "x".toByteArray(), masked = true)
        val (client, _) = clientOver(bytes)
        try {
            client.readMessage()
            fail("expected IOException for masked server frame")
        } catch (e: IOException) {
            assertTrue(e.message?.contains("masked") == true)
        }
    }

    // -------- fragmented text assembly --------

    @Test
    fun fragmentedTextAssemblesAcrossContFrames() {
        val out = ByteArrayOutputStream()
        out.write(frame(fin = false, opcode = 0x1, payload = "one-".toByteArray()))
        out.write(frame(fin = false, opcode = 0x0, payload = "two-".toByteArray()))
        out.write(frame(fin = true, opcode = 0x0, payload = "three".toByteArray()))
        val (client, _) = clientOver(out.toByteArray())
        assertEquals("one-two-three", client.readMessage())
    }

    // -------- control frame during fragmentation is transparent --------

    @Test
    fun pingDuringFragmentationDoesNotBreakAssembly() {
        val out = ByteArrayOutputStream()
        out.write(frame(fin = false, opcode = 0x1, payload = "hello".toByteArray()))
        // Interleaved PING — should be auto-ponged and skipped.
        out.write(frame(fin = true, opcode = 0x9, payload = "ping-body".toByteArray()))
        out.write(frame(fin = true, opcode = 0x0, payload = "world".toByteArray()))
        val (client, writtenOut) = clientOver(out.toByteArray())
        assertEquals("helloworld", client.readMessage())
        // Pong was written back (opcode 0xA, FIN=1 → 0x8A). Client masks it.
        val response = writtenOut.toByteArray()
        assertTrue("expected pong frame to be sent", response.isNotEmpty())
        assertEquals(0x8A.toByte(), response[0])
    }

    // -------- oversize per-frame rejection --------

    @Test
    fun singleFrameOverCapIsRejected() {
        // Header only — we don't need to append 1MB+1 bytes because the
        // client checks the declared length before readFully consumes
        // the payload.
        val hdr = ByteArrayOutputStream()
        hdr.write(0x81) // FIN=1, TEXT
        hdr.write(127) // extended 64-bit length, no MASK
        val len = (1024L * 1024L) + 1L
        for (shift in 56 downTo 0 step 8) hdr.write(((len ushr shift.toInt()) and 0xFF).toInt())
        val (client, _) = clientOver(hdr.toByteArray())
        try {
            client.readMessage()
            fail("expected IOException for oversize frame")
        } catch (e: IOException) {
            assertTrue(
                "unexpected message: ${e.message}",
                e.message?.contains("exceeds cap") == true,
            )
        }
    }

    // -------- oversize per-assembled rejection --------

    @Test
    fun assembledFragmentsOverCapAreRejected() {
        // Each fragment is 512KB, three fragments = 1.5MB total, first
        // two fit under the per-frame cap (1MB) but the assembled
        // buffer will trip the assembled cap on the third.
        val chunk = ByteArray(512 * 1024) { 'a'.code.toByte() }
        val out = ByteArrayOutputStream()
        out.write(frame(fin = false, opcode = 0x1, payload = chunk))
        out.write(frame(fin = false, opcode = 0x0, payload = chunk))
        out.write(frame(fin = true, opcode = 0x0, payload = chunk))
        val (client, _) = clientOver(out.toByteArray())
        try {
            client.readMessage()
            fail("expected IOException for oversize assembled message")
        } catch (e: IOException) {
            assertTrue(
                "unexpected message: ${e.message}",
                e.message?.contains("exceeds") == true,
            )
        }
    }

    // -------- length encoding boundaries --------

    @Test
    fun lengthBoundary125IsOneByte() {
        val payload = ByteArray(125) { 'a'.code.toByte() }
        val bytes = frame(fin = true, opcode = 0x1, payload = payload)
        // header size = 2 (b0+b1), no extended length
        assertEquals(2 + 125, bytes.size)
        val (client, _) = clientOver(bytes)
        assertEquals(String(payload), client.readMessage())
    }

    @Test
    fun lengthBoundary126TriggersTwoByteExtended() {
        val payload = ByteArray(126) { 'b'.code.toByte() }
        val bytes = frame(fin = true, opcode = 0x1, payload = payload)
        // header size = 2 + 2-byte extended
        assertEquals(4 + 126, bytes.size)
        assertEquals(126, bytes[1].toInt() and 0x7F)
        val (client, _) = clientOver(bytes)
        assertEquals(String(payload), client.readMessage())
    }

    @Test
    fun lengthBoundary127TriggersEightByteExtended() {
        // 65536 is the boundary that flips to 8-byte extended in the
        // builder mirroring the client's writeFrame. Stay under the
        // 1MB assembled cap.
        val payload = ByteArray(65536) { 'c'.code.toByte() }
        val bytes = frame(fin = true, opcode = 0x1, payload = payload)
        // header size = 2 + 8-byte extended
        assertEquals(10 + 65536, bytes.size)
        assertEquals(127, bytes[1].toInt() and 0x7F)
        val (client, _) = clientOver(bytes)
        assertEquals(String(payload), client.readMessage())
    }
}
