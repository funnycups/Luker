// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LukerDiagnosticsExporterTraceTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun collect_latest_trace_file_picks_newest_non_empty_trace() {
        val cdpDir = tempFolder.newFolder("cdp")
        File(cdpDir, "luker-heap-20261113-000001.heapsnapshot").writeText("{}")
        val older = File(cdpDir, "luker-trace-20261113-000001.json").apply {
            writeText("""{"traceEvents":[{"name":"old"}]}""")
            setLastModified(1_000L)
        }
        val newer = File(cdpDir, "luker-trace-20261113-000002.json").apply {
            writeText("""{"traceEvents":[{"name":"new"}]}""")
            setLastModified(2_000L)
        }
        File(cdpDir, "luker-trace-20261113-000003.json").apply {
            writeText("")
            setLastModified(3_000L)
        }

        val picked = LukerDiagnosticsExporter.collectLatestTraceFile(cdpDir)
        assertEquals(newer.name, picked?.name)
        assertFalseSame(older, picked)
    }

    @Test
    fun collect_latest_trace_file_returns_null_when_no_valid_traces_exist() {
        val cdpDir = tempFolder.newFolder("cdp-empty")
        File(cdpDir, "luker-trace-empty.json").writeText("")
        assertNull(LukerDiagnosticsExporter.collectLatestTraceFile(cdpDir))
    }

    private fun assertFalseSame(unexpected: File, actual: File?) {
        assertEquals(false, unexpected == actual)
    }
}
