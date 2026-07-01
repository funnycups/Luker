// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LukerLogcatTailRotationTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun rotate_current_to_last_overwrites_existing_last() {
        val current = File(tmp.root, "logcat.current").apply { writeText("CURRENT") }
        val last = File(tmp.root, "logcat.last").apply { writeText("OLD_LAST") }

        LukerLogcatTail.rotateForTest(current, last)

        assertFalse("current should be gone after rotate", current.exists())
        assertTrue("last should exist after rotate", last.exists())
        assertEquals("CURRENT", last.readText())
    }

    @Test
    fun rotate_with_no_existing_last_still_works() {
        val current = File(tmp.root, "logcat.current").apply { writeText("CONTENT") }
        val last = File(tmp.root, "logcat.last")
        assertFalse(last.exists())

        LukerLogcatTail.rotateForTest(current, last)

        assertFalse(current.exists())
        assertTrue(last.exists())
        assertEquals("CONTENT", last.readText())
    }

    @Test
    fun rotate_with_no_current_is_noop() {
        val current = File(tmp.root, "logcat.current")
        val last = File(tmp.root, "logcat.last").apply { writeText("KEEP") }
        assertFalse(current.exists())

        LukerLogcatTail.rotateForTest(current, last)

        assertFalse(current.exists())
        assertEquals("KEEP", last.readText())
    }
}
