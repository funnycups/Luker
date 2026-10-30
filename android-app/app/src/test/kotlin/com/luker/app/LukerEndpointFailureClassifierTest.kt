// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

package com.luker.app

import android.webkit.WebViewClient
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LukerEndpointFailureClassifierTest {
    @Test
    fun http_404_on_the_main_frame_is_a_failure() {
        assertTrue(LukerEndpointFailureClassifier.shouldShowForHttpStatus(404, true))
    }

    @Test
    fun http_5xx_on_the_main_frame_is_a_failure() {
        assertTrue(LukerEndpointFailureClassifier.shouldShowForHttpStatus(500, true))
        assertTrue(LukerEndpointFailureClassifier.shouldShowForHttpStatus(599, true))
    }

    @Test
    fun http_4xx_other_than_404_is_not_a_failure() {
        for (statusCode in listOf(400, 401, 403, 429, 499)) {
            assertFalse(
                "status $statusCode",
                LukerEndpointFailureClassifier.shouldShowForHttpStatus(statusCode, true),
            )
        }
    }

    @Test
    fun http_failures_on_subresources_are_ignored() {
        for (statusCode in listOf(404, 500, 599)) {
            assertFalse(
                "status $statusCode",
                LukerEndpointFailureClassifier.shouldShowForHttpStatus(statusCode, false),
            )
        }
    }

    @Test
    fun a_main_frame_network_error_is_a_failure() {
        assertTrue(
            LukerEndpointFailureClassifier.shouldShowForNetworkError(
                WebViewClient.ERROR_HOST_LOOKUP,
                "net::ERR_NAME_NOT_RESOLVED",
                true,
            ),
        )
    }

    @Test
    fun a_canceled_navigation_is_not_a_failure() {
        assertFalse(
            LukerEndpointFailureClassifier.shouldShowForNetworkError(
                WebViewClient.ERROR_UNKNOWN,
                "net::ERR_ABORTED",
                true,
            ),
        )
    }

    @Test
    fun an_unknown_error_that_is_not_a_cancellation_is_a_failure() {
        assertTrue(
            LukerEndpointFailureClassifier.shouldShowForNetworkError(
                WebViewClient.ERROR_UNKNOWN,
                "net::ERR_CONNECTION_REFUSED",
                true,
            ),
        )
    }

    @Test
    fun an_unknown_error_without_a_description_is_not_a_failure() {
        assertFalse(
            LukerEndpointFailureClassifier.shouldShowForNetworkError(
                WebViewClient.ERROR_UNKNOWN,
                null,
                true,
            ),
        )
        assertFalse(
            LukerEndpointFailureClassifier.shouldShowForNetworkError(
                WebViewClient.ERROR_UNKNOWN,
                "  ",
                true,
            ),
        )
    }

    @Test
    fun network_errors_on_subresources_are_ignored() {
        for (errorCode in listOf(WebViewClient.ERROR_HOST_LOOKUP, WebViewClient.ERROR_UNKNOWN)) {
            assertFalse(
                "error $errorCode",
                LukerEndpointFailureClassifier.shouldShowForNetworkError(
                    errorCode,
                    "net::ERR_NAME_NOT_RESOLVED",
                    false,
                ),
            )
        }
    }
}
