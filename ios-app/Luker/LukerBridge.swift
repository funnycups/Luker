// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation
import UIKit
import WebKit

protocol LukerBridgePresenter: AnyObject {
    func presentEndpointSettings()
    func exportDiagnosticsBundle()
    func reloadWebView()
    func applyEndpointChange()
    func applySystemBarsColor(top: UIColor, bottom: UIColor)
}

/// Installs `window.LukerIOS` and the console capture hook into the WebView.
///
/// Both handlers are native-only surfaces: the bridge is the same shape the
/// HarmonyOS shell exposes for generation-scoped keep-alive, and the console
/// hook records messages even when the page itself is too broken to export
/// anything.
final class LukerBridge: NSObject {
    static let bridgeHandlerName = "lukerBridge"
    static let consoleHandlerName = "lukerConsole"

    weak var presenter: LukerBridgePresenter?

    func install(into userContentController: WKUserContentController) {
        userContentController.addScriptMessageHandler(
            self,
            contentWorld: .page,
            name: Self.bridgeHandlerName
        )
        userContentController.add(self, name: Self.consoleHandlerName)
        userContentController.addUserScript(WKUserScript(
            source: Self.bridgeScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        userContentController.addUserScript(WKUserScript(
            source: Self.consoleScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
    }

    // MARK: - Bridge

    private func handleBridge(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        guard let method = body["method"] as? String else {
            reply(nil, "missing method")
            return
        }

        switch method {
        case "setGenerationActive":
            LukerKeepAliveManager.shared.setGenerationActive(body["active"] as? Bool ?? false)
            reply(nil, nil)

        case "notifyMessageFinished":
            let title = body["title"] as? String ?? "Luker"
            let text = body["body"] as? String ?? ""
            LukerNotificationManager.shared.notifyReplyReady(title: title, body: text)
            reply(nil, nil)

        case "requestNotificationPermission":
            LukerNotificationManager.shared.requestAuthorization { granted in
                reply(granted, nil)
            }

        case "getEndpoint":
            let selection = LukerEndpointConfig.shared.selection
            reply([
                "baseUrl": selection.baseURL.absoluteString,
                "usesLocalRuntime": selection.usesLocalRuntime,
            ], nil)

        case "setEndpoint":
            do {
                let saved = try LukerEndpointConfig.shared.save(body["value"] as? String)
                DispatchQueue.main.async { [weak self] in
                    self?.presenter?.applyEndpointChange()
                }
                reply([
                    "ok": true,
                    "baseUrl": (saved?.absoluteString as Any?) ?? NSNull(),
                    "restartRequired": false,
                ], nil)
            } catch {
                reply([
                    "ok": false,
                    "error": error.localizedDescription,
                ], nil)
            }

        case "openEndpointSettings":
            LukerDeepLinkRouter.shared.handle(URL(string: "luker://endpoint")!)
            reply(nil, nil)

        case "reloadWebView":
            DispatchQueue.main.async { [weak self] in
                self?.presenter?.reloadWebView()
            }
            reply(nil, nil)

        case "pushDebugTrail":
            let category = body["category"] as? String ?? "web"
            let text = body["text"] as? String ?? ""
            LukerDebugTrail.shared.append(category: category, text: String(text.prefix(8000)))
            reply(nil, nil)

        case "exportDiagnosticsBundle":
            DispatchQueue.main.async { [weak self] in
                self?.presenter?.exportDiagnosticsBundle()
            }
            reply(nil, nil)

        case "setSystemBarsColor":
            guard let rawTop = (body["topColor"] as? String) ?? (body["color"] as? String),
                  let topColor = Self.color(fromCSS: rawTop) else {
                reply(nil, "invalid color")
                return
            }
            let bottomColor: UIColor
            if let rawBottom = body["bottomColor"] as? String, !rawBottom.isEmpty {
                guard let parsedBottom = Self.color(fromCSS: rawBottom) else {
                    reply(nil, "invalid bottom color")
                    return
                }
                bottomColor = parsedBottom
            } else {
                bottomColor = topColor
            }
            presenter?.applySystemBarsColor(top: topColor, bottom: bottomColor)
            reply(nil, nil)

        case "setOpenExternalLinksInBrowser":
            LukerExternalLinkSettings.shared.openExternally = body["enabled"] as? Bool ?? true
            reply(nil, nil)

        default:
            reply(nil, "unknown method: \(method)")
        }
    }

    private static func color(fromCSS value: String) -> UIColor? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        if trimmed.hasPrefix("#") {
            let hex = String(trimmed.dropFirst())
            guard let raw = UInt64(hex, radix: 16) else { return nil }
            switch hex.count {
            case 3:
                return UIColor(
                    red: CGFloat((raw >> 8) & 0xF) / 15,
                    green: CGFloat((raw >> 4) & 0xF) / 15,
                    blue: CGFloat(raw & 0xF) / 15,
                    alpha: 1
                )
            case 6:
                return UIColor(
                    red: CGFloat((raw >> 16) & 0xFF) / 255,
                    green: CGFloat((raw >> 8) & 0xFF) / 255,
                    blue: CGFloat(raw & 0xFF) / 255,
                    alpha: 1
                )
            case 8:
                return UIColor(
                    red: CGFloat((raw >> 24) & 0xFF) / 255,
                    green: CGFloat((raw >> 16) & 0xFF) / 255,
                    blue: CGFloat((raw >> 8) & 0xFF) / 255,
                    alpha: 1
                )
            default:
                return nil
            }
        }

        guard let open = trimmed.firstIndex(of: "("),
              let close = trimmed.lastIndex(of: ")") else {
            return nil
        }
        let name = trimmed[..<open].trimmingCharacters(in: .whitespaces)
        guard name == "rgb" || name == "rgba" else { return nil }
        let body = trimmed[trimmed.index(after: open)..<close]
        let parts = body.split(whereSeparator: { $0 == "," || $0 == "/" || $0 == " " })
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard parts.count >= 3 else { return nil }

        func channel(_ raw: String) -> CGFloat? {
            if raw.hasSuffix("%") {
                guard let percent = Double(raw.dropLast()) else { return nil }
                return CGFloat(percent / 100)
            }
            guard let value = Double(raw) else { return nil }
            return CGFloat(value / 255)
        }

        guard let red = channel(parts[0]),
              let green = channel(parts[1]),
              let blue = channel(parts[2]) else {
            return nil
        }
        return UIColor(red: red, green: green, blue: blue, alpha: 1)
    }

    // MARK: - Scripts

    private static let bridgeScript = """
    (function() {
        if (window.LukerIOS) return;
        const handler = window.webkit.messageHandlers.\(bridgeHandlerName);
        if (!handler) return;
        const post = (payload) => handler.postMessage(payload);
        window.LukerIOS = {
            setGenerationActive(active) {
                post({ method: 'setGenerationActive', active: !!active });
            },
            setSystemBarsColor(topColor, bottomColor) {
                const top = String(topColor == null ? '' : topColor);
                const bottom = bottomColor == null ? top : String(bottomColor);
                post({ method: 'setSystemBarsColor', topColor: top, bottomColor: bottom });
            },
            setOpenExternalLinksInBrowser(enabled) {
                post({ method: 'setOpenExternalLinksInBrowser', enabled: !!enabled });
            },
            notifyMessageFinished(title, body) {
                post({
                    method: 'notifyMessageFinished',
                    title: String(title == null ? '' : title),
                    body: String(body == null ? '' : body),
                });
            },
            requestNotificationPermission() {
                return handler.postMessage({ method: 'requestNotificationPermission' });
            },
            getEndpoint() {
                return handler.postMessage({ method: 'getEndpoint' });
            },
            setEndpoint(value) {
                return handler.postMessage({ method: 'setEndpoint', value: String(value == null ? '' : value) });
            },
            openEndpointSettings() {
                post({ method: 'openEndpointSettings' });
            },
            reloadWebView() {
                post({ method: 'reloadWebView' });
            },
            pushDebugTrail(category, text) {
                post({
                    method: 'pushDebugTrail',
                    category: String(category == null ? '' : category),
                    text: String(text == null ? '' : text),
                });
            },
            exportDiagnosticsBundle() {
                post({ method: 'exportDiagnosticsBundle' });
            },
        };
    })();
    """

    private static let consoleScript = """
    (function() {
        if (window.__lukerConsoleInstalled) return;
        window.__lukerConsoleInstalled = true;
        const handler = window.webkit.messageHandlers.\(consoleHandlerName);
        if (!handler) return;
        const describe = (value) => {
            if (typeof value === 'string') return value;
            if (value instanceof Error) return value.stack || value.message || String(value);
            try {
                return JSON.stringify(value);
            } catch (_) {
                return String(value);
            }
        };
        const post = (level, values) => {
            try {
                let text = values.map(describe).join(' ');
                if (text.length > 8000) text = text.slice(0, 8000) + '…[truncated]';
                handler.postMessage({ level, text, source: location.href });
            } catch (_) {
                // A broken console must never break the page.
            }
        };
        ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
            const original = console[level];
            console[level] = function(...args) {
                post(level.toUpperCase(), args);
                return original.apply(this, args);
            };
        });
        window.addEventListener('error', (event) => {
            if (!event || !event.message) return;
            post('ERROR', [event.message + ' @ ' + (event.filename || '<unknown>') + ':' + (event.lineno || 0) + ':' + (event.colno || 0)]);
        }, true);
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event && event.reason;
            post('UNHANDLED_REJECTION', [reason instanceof Error ? (reason.stack || reason.message) : String(reason)]);
        });
    })();
    """
}

// MARK: - WKScriptMessageHandlerWithReply

extension LukerBridge: WKScriptMessageHandlerWithReply {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == Self.bridgeHandlerName,
              let body = message.body as? [String: Any] else {
            replyHandler(nil, "invalid message")
            return
        }
        handleBridge(body, reply: replyHandler)
    }
}

// MARK: - Console handler

extension LukerBridge: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.consoleHandlerName else { return }
        let body = message.body as? [String: Any] ?? [:]
        let level = body["level"] as? String ?? "LOG"
        let text = body["text"] as? String ?? ""
        let source = body["source"] as? String ?? ""
        LukerDebugTrail.shared.append(category: "webconsole", text: "\(level) \(source) \(text)")
    }
}
