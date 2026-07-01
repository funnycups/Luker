// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class LukerAndroidDebugConfigTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("luker_android_debug_config", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .commit()
    }

    @Test
    fun is_enabled_default_false() {
        assertFalse(LukerAndroidDebugConfig.isEnabled(context))
    }

    @Test
    fun set_enabled_true_then_read_back_true() {
        LukerAndroidDebugConfig.setEnabled(context, true)
        assertTrue(LukerAndroidDebugConfig.isEnabled(context))
    }

    @Test
    fun set_enabled_false_then_read_back_false() {
        LukerAndroidDebugConfig.setEnabled(context, true)
        LukerAndroidDebugConfig.setEnabled(context, false)
        assertFalse(LukerAndroidDebugConfig.isEnabled(context))
    }
}
