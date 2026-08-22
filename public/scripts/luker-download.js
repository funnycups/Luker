// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Bridge-aware helper for downloading a server-produced file. When running
// inside the Luker Android app, hands the request off to the native
// LukerAndroid.saveFileFromUrl bridge so the native side fetches the URL
// with HttpURLConnection and streams the response body directly into a
// user-picked SAF file. That path avoids the WebView blob→FileReader
// →base64 dataURL→JavascriptInterface chain, which has practical size
// limits and has been observed to fail for large chat exports.
//
// The endpoint MUST return the raw file bytes (not a JSON envelope). On
// Android the native code writes the response body verbatim to the target
// file; if the server wraps the payload in JSON, the user gets JSON on
// disk. In the browser we also skip re-parsing and just Blob() the
// response body.
//
// Callers own the toast/progress lifecycle. The Android branch is
// fire-and-forget from the web side — the native code shows its own
// success/failure toast when the SAF write completes.

/**
 * @typedef {Object} DownloadFromServerOptions
 * @property {string} url            Same-origin endpoint URL.
 * @property {string} fileName       Suggested filename shown in SAF / used as <a download>.
 * @property {string} mimeType       MIME type for the saved file.
 * @property {'GET'|'POST'} [method] HTTP method. Default 'GET'.
 * @property {Record<string,string>} [headers] Request headers.
 * @property {string|null} [body]    Serialized request body (POST only).
 */

/**
 * @typedef {Object} DownloadFromServerResult
 * @property {'android'|'browser'} via  Which code path handled the download.
 */

/**
 * Downloads a server-produced file, preferring the native bridge on Android.
 * Throws on browser-side fetch/blob failure; Android failures surface as a
 * native toast (see MainActivity.performStreamDownload).
 *
 * When the browser fetch returns non-2xx, the thrown Error carries `.status`
 * (HTTP status code) and `.serverMessage` (the `error` field from a JSON
 * response body if present) so callers can render specific messages.
 *
 * @param {DownloadFromServerOptions} opts
 * @returns {Promise<DownloadFromServerResult>}
 */
export async function downloadFromServer(opts) {
    const { url, fileName, mimeType, method = 'GET', headers = {}, body = null } = opts || {};
    if (!url || !fileName || !mimeType) {
        throw new Error('downloadFromServer: url, fileName and mimeType are required');
    }

    const bridge = (typeof window !== 'undefined') ? window.LukerAndroid : null;
    if (bridge && typeof bridge.saveFileFromUrl === 'function') {
        bridge.saveFileFromUrl(JSON.stringify({ url, fileName, mimeType, method, headers, body }));
        return { via: 'android' };
    }

    const response = await fetch(url, { method, headers, body });
    if (!response.ok) {
        let serverMessage = '';
        try {
            const data = await response.clone().json();
            if (data && typeof data.error === 'string') {
                serverMessage = data.error;
            }
        } catch (_) {
            // Response is not a JSON envelope. Fall through to a generic error.
        }
        const err = new Error(serverMessage || `${response.status} ${response.statusText}`);
        err.status = response.status;
        err.serverMessage = serverMessage;
        throw err;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
    return { via: 'browser' };
}
