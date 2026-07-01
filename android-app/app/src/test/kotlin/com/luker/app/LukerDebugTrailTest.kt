// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Field

class LukerDebugTrailTest {
    @After
    fun tearDown() {
        LukerDebugTrail.resetForTest()
    }

    @Test
    fun append_then_dump_preserves_order() {
        LukerDebugTrail.append("console", "first")
        LukerDebugTrail.append("console", "second")
        LukerDebugTrail.append("native", "third")

        val dump = LukerDebugTrail.dumpAll()
        val lines = dump.trimEnd().lineSequence().toList()
        assertEquals(3, lines.size)
        assertTrue(lines[0].endsWith(" console first"))
        assertTrue(lines[1].endsWith(" console second"))
        assertTrue(lines[2].endsWith(" native third"))
    }

    @Test
    fun ring_buffer_overflow_keeps_only_last_2048_lines() {
        for (i in 1..3000) {
            LukerDebugTrail.append("console", "line$i")
        }
        val dump = LukerDebugTrail.dumpAll()
        val lines = dump.trimEnd().lineSequence().toList()

        assertEquals(2048, lines.size)
        assertTrue(lines.first().endsWith(" console line953"))
        assertTrue(lines.last().endsWith(" console line3000"))
    }

    @Test
    fun oversized_line_is_truncated_with_marker() {
        val payload = "x".repeat(2000)
        LukerDebugTrail.append("console", payload)

        val dump = LukerDebugTrail.dumpAll().trimEnd()
        assertTrue("expected truncation marker, got: ${dump.takeLast(40)}",
            dump.endsWith("…[truncated]"))
        assertFalse("trimmed line should be shorter than raw payload",
            dump.length > 2000)
    }

    @Test
    fun empty_dump_returns_empty_string() {
        assertEquals("", LukerDebugTrail.dumpAll())
    }

    @Test
    fun append_with_null_unsafe_inputs_does_not_throw() {
        // Defensive: append() is called from JS bridge; both args are non-null
        // per signature, but a blank category and empty text must be tolerated.
        LukerDebugTrail.append("", "")
        LukerDebugTrail.append("category-only", "")
        val dump = LukerDebugTrail.dumpAll().trimEnd()
        assertEquals(2, dump.lineSequence().count())
    }
}
