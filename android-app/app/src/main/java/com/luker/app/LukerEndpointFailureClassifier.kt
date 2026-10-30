// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.webkit.WebViewClient

object LukerEndpointFailureClassifier {
    fun shouldShowForHttpStatus(statusCode: Int, isForMainFrame: Boolean): Boolean {
        if (!isForMainFrame) return false
        return statusCode == 404 || statusCode in 500..599
    }

    fun shouldShowForNetworkError(
        errorCode: Int,
        description: String?,
        isForMainFrame: Boolean,
    ): Boolean {
        if (!isForMainFrame) return false
        if (errorCode == WebViewClient.ERROR_UNKNOWN) {
            val detail = description?.trim().orEmpty()
            if (detail.isEmpty() || detail.contains("ERR_ABORTED")) {
                return false
            }
        }
        return true
    }
}
