// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.content.Context

/**
 * Tiny SharedPreferences wrapper for the "Android debug recording" user
 * toggle. Read on every process onCreate so LukerLogcatTail can resume
 * without waiting for the frontend to inject the JS bridge.
 */
object LukerAndroidDebugConfig {
    private const val PREF_NAME = "luker_android_debug_config"
    private const val KEY_ENABLED = "android_debug_recording_enabled"

    fun isEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_ENABLED, false)
    }

    fun setEnabled(context: Context, value: Boolean) {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_ENABLED, value).apply()
    }
}
