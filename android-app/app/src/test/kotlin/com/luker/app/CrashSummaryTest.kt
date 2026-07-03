// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashSummaryTest {

    @Test
    fun emptyReportReturnsSentinel() {
        val out = buildCrashSummary("")
        // Either the "no fields" sentinel or an empty summary is acceptable
        // — production shows one of these lines in the dialog, both convey
        // "there's no structured data to display".
        assertTrue(
            "unexpected empty-report output: <$out>",
            out == "<no structured fields found in crash report>" || out.isEmpty(),
        )
    }

    @Test
    fun reportWithNoKnownKeysProducesNoKeyValueLines() {
        val report = """
            random noise line
            another=value_but_key_not_whitelisted
            zzz=something
        """.trimIndent()
        val out = buildCrashSummary(report)
        assertEquals("<no structured fields found in crash report>", out)
    }

    @Test
    fun reportWithAllKnownKeysAppearInWhitelistOrder() {
        // Deliberately shuffle input order — production wants a canonical
        // display order in the dialog so users can eyeball successive
        // reports against each other.
        val report = """
            android=14 (sdk=34)
            device=Pixel 7
            processName=com.luker.app
            pid=1234
            importance=FOREGROUND (100)
            reason=CRASH (4)
            url=https://example/
            rendererPriorityAtExit=0
            didCrash=true
            when=2026-01-02 03:04:05.678
            source=webview-render-process-gone
        """.trimIndent()
        val out = buildCrashSummary(report)
        val expected = """
            source=webview-render-process-gone
            when=2026-01-02 03:04:05.678
            didCrash=true
            rendererPriorityAtExit=0
            url=https://example/
            device=Pixel 7
            android=14 (sdk=34)
            reason=CRASH (4)
            importance=FOREGROUND (100)
            pid=1234
            processName=com.luker.app
        """.trimIndent()
        assertEquals(expected, out)
    }

    @Test
    fun duplicateKeysKeepFirstOccurrence() {
        val report = """
            source=first-source
            when=t1
            source=second-source
            when=t2
        """.trimIndent()
        val out = buildCrashSummary(report)
        assertTrue("first source not preserved: <$out>", out.contains("source=first-source"))
        assertFalse("later source should not appear: <$out>", out.contains("second-source"))
        assertTrue("first when not preserved: <$out>", out.contains("when=t1"))
        assertFalse("later when should not appear: <$out>", out.contains("t2"))
    }

    @Test
    fun equalsSignInValueIsPreservedIntact() {
        val report = "url=https://example.com/?a=1&b=2&c=3"
        val out = buildCrashSummary(report)
        assertEquals("url=https://example.com/?a=1&b=2&c=3", out)
    }
}
