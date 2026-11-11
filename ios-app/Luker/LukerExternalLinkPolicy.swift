// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation

enum LukerLinkRoute {
    case inApp
    case systemBrowser
}

/// Process-wide copy of the "open external links in the system browser"
/// preference. The page pushes it through the bridge after loading; the
/// navigation delegate reads it on every request.
final class LukerExternalLinkSettings {
    static let shared = LukerExternalLinkSettings()

    var openExternally = true

    private init() {}
}

/// Decides where a navigation request is handled.
///
/// Only `http` and `https` URLs whose origin differs from the app origin can
/// leave the app. Every other scheme (`blob:`, `data:`, `about:`, `file:`) —
/// and everything without an authority — stays in the WebView. A page that is
/// itself outside the app origin is a session the app admitted on purpose — a
/// server redirect into a sign-in page, for instance — and the page's own
/// navigations, form posts included, belong to that session. They stay in the
/// WebView regardless of the target and of the toggle, because the app page is
/// already off screen and the system browser would break the flow mid-way. An
/// empty or unknown current URL counts as the app page.
enum LukerExternalLinkPolicy {
    /// The lowercased `scheme://host[:port]` part of `url`, with the scheme
    /// default port dropped. Returns an empty string when the URL has no
    /// scheme or no authority.
    static func origin(of url: URL?) -> String {
        guard let url,
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else {
            return ""
        }
        let usesDefaultPort = (scheme == "http" && url.port == 80)
            || (scheme == "https" && url.port == 443)
        if let port = url.port, !usesDefaultPort {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    static func isExternal(_ url: URL?, appOrigin: String) -> Bool {
        guard let scheme = url?.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return false
        }
        let origin = origin(of: url)
        return !origin.isEmpty && origin != appOrigin
    }

    /// Routes a top-level navigation. `currentURL` is the URL the main frame is
    /// on right before this request; a frame that is already outside the app
    /// origin keeps the request in the app so an admitted redirect session
    /// survives.
    static func routeTopLevelNavigation(
        url: URL?,
        currentURL: URL?,
        appOrigin: String,
        openExternally: Bool
    ) -> LukerLinkRoute {
        let currentOrigin = origin(of: currentURL)
        if !currentOrigin.isEmpty && currentOrigin != appOrigin {
            return .inApp
        }
        guard isExternal(url, appOrigin: appOrigin) else {
            return .inApp
        }
        return openExternally ? .systemBrowser : .inApp
    }
}
