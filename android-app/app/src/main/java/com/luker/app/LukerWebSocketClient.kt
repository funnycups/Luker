// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.SecureRandom
import java.util.Base64
import kotlin.experimental.xor

/**
 * Minimal RFC 6455 WebSocket client over any pair of streams (used with
 * android.net.LocalSocket to talk to Chromium's DevTools endpoint exposed
 * as @webview_devtools_remote_<pid>).
 *
 * Not thread-safe: caller must serialize sendText() and readMessage().
 * Client frames are always masked (RFC 6455 required). Server frames are
 * always unmasked (spec violation is treated as a protocol error and
 * causes IOException so the caller can close and retry).
 *
 * Supports text opcode + fragmentation via continuation. Ping is auto-Ponged.
 * Close and unknown opcodes throw IOException.
 *
 * Payload cap: MAX_MESSAGE_BYTES per assembled message; exceeding it
 * throws IOException so the caller can log payload-oversize.
 */
class LukerWebSocketClient(
    private val input: InputStream,
    private val output: OutputStream,
) {
    private val din = DataInputStream(input)
    private val dout = DataOutputStream(output)
    private val random = SecureRandom()

    companion object {
        private const val OPCODE_CONT: Byte = 0x0
        private const val OPCODE_TEXT: Byte = 0x1
        private const val OPCODE_BIN: Byte = 0x2
        private const val OPCODE_CLOSE: Byte = 0x8
        private const val OPCODE_PING: Byte = 0x9
        private const val OPCODE_PONG: Byte = 0xA.toByte()
        private const val MAX_MESSAGE_BYTES = 1024 * 1024
    }

    /**
     * Performs the HTTP/1.1 Upgrade handshake on `path` (must start with /).
     * Does not validate Sec-WebSocket-Accept — LocalSocket has no MITM
     * surface so the accept-key check adds no security value here.
     */
    fun handshake(path: String) {
        val keyBytes = ByteArray(16).also { random.nextBytes(it) }
        val key = Base64.getEncoder().encodeToString(keyBytes)
        val req = buildString {
            append("GET ").append(path).append(" HTTP/1.1\r\n")
            append("Host: localhost\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Key: ").append(key).append("\r\n")
            append("Sec-WebSocket-Version: 13\r\n")
            append("\r\n")
        }
        dout.write(req.toByteArray(Charsets.ISO_8859_1))
        dout.flush()

        val statusLine = readLine() ?: throw IOException("ws-handshake: server closed before status line")
        if (!statusLine.startsWith("HTTP/1.1 101")) {
            throw IOException("ws-handshake: unexpected status: $statusLine")
        }
        while (true) {
            val line = readLine() ?: throw IOException("ws-handshake: server closed in headers")
            if (line.isEmpty()) break
        }
    }

    private fun readLine(): String? {
        val buf = ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString("ISO-8859-1")
            if (prev == '\r'.code && b == '\n'.code) {
                val bytes = buf.toByteArray()
                return String(bytes, 0, bytes.size - 1, Charsets.ISO_8859_1)
            }
            buf.write(b)
            prev = b
        }
    }

    @Synchronized
    fun sendText(text: String) {
        val payload = text.toByteArray(Charsets.UTF_8)
        writeFrame(fin = true, opcode = OPCODE_TEXT, payload = payload)
    }

    private fun sendPong(payload: ByteArray) {
        writeFrame(fin = true, opcode = OPCODE_PONG, payload = payload)
    }

    private fun writeFrame(fin: Boolean, opcode: Byte, payload: ByteArray) {
        val b0 = ((if (fin) 0x80 else 0x00) or (opcode.toInt() and 0x0F)).toByte()
        dout.writeByte(b0.toInt())
        val len = payload.size
        when {
            len < 126 -> dout.writeByte(0x80 or len)
            len < 65536 -> {
                dout.writeByte(0x80 or 126)
                dout.writeShort(len)
            }
            else -> {
                dout.writeByte(0x80 or 127)
                dout.writeLong(len.toLong())
            }
        }
        val mask = ByteArray(4).also { random.nextBytes(it) }
        dout.write(mask)
        val masked = ByteArray(payload.size)
        for (i in payload.indices) masked[i] = payload[i] xor mask[i and 3]
        dout.write(masked)
        dout.flush()
    }

    /**
     * Reads a complete (possibly fragmented) text message. Handles auto-pong.
     * Throws IOException on close, binary opcode, oversize, or masked server frame.
     */
    fun readMessage(): String {
        val assembled = ByteArrayOutputStream()
        var expectedOpcode: Byte = -1
        while (true) {
            val b0 = din.readUnsignedByte()
            val b1 = din.readUnsignedByte()
            val fin = (b0 and 0x80) != 0
            val opcode = (b0 and 0x0F).toByte()
            val masked = (b1 and 0x80) != 0
            if (masked) throw IOException("ws-read: server frame is masked")
            var len = (b1 and 0x7F).toLong()
            if (len == 126L) len = din.readUnsignedShort().toLong()
            else if (len == 127L) len = din.readLong()
            if (len < 0 || len > MAX_MESSAGE_BYTES) throw IOException("ws-read: frame len $len exceeds cap")
            val payload = ByteArray(len.toInt())
            din.readFully(payload)
            when (opcode) {
                OPCODE_PING -> { sendPong(payload); continue }
                OPCODE_PONG -> continue
                OPCODE_CLOSE -> throw IOException("ws-read: close frame received")
                OPCODE_TEXT -> {
                    if (expectedOpcode.toInt() != -1) throw IOException("ws-read: new data frame during fragmentation")
                    expectedOpcode = OPCODE_TEXT
                }
                OPCODE_CONT -> {
                    if (expectedOpcode.toInt() == -1) throw IOException("ws-read: continuation without start")
                }
                OPCODE_BIN -> throw IOException("ws-read: binary opcode not supported")
                else -> throw IOException("ws-read: unknown opcode ${opcode.toInt()}")
            }
            if (assembled.size() + payload.size > MAX_MESSAGE_BYTES) {
                throw IOException("ws-read: assembled message exceeds ${MAX_MESSAGE_BYTES} bytes")
            }
            assembled.write(payload)
            if (fin) return assembled.toString("UTF-8")
        }
    }
}
