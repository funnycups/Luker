// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import UIKit
import WebKit

final class ViewController: UIViewController {
    private enum BootState {
        case startingRuntime
        case waitingForServer
        case failed(reason: String)
        case ready
    }

    private static let serverReadyTimeout: TimeInterval = 90
    private static let serverReadyPollInterval: TimeInterval = 0.5

    private let runtime = LukerRuntimeManager.shared
    private let bridge = LukerBridge()
    private var webView: WKWebView?
    private var downloadShareViewController: UIViewController?
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var safeModeTripped = false
    private var safeModeBanner: UIView?
    private var pendingCrashShown = false
    private var isExportingDiagnostics = false
    #if DEBUG
    private var didHandleLaunchEndpointArgument = false
    #endif

    private let statusStack: UIStackView = {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }()

    private let spinner = UIActivityIndicatorView(style: .large)

    private let statusLabel: UILabel = {
        let label = UILabel()
        label.textAlignment = .center
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .body)
        return label
    }()

    private let diagnosticsTextView: UITextView = {
        let textView = UITextView()
        textView.isEditable = false
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.layer.borderColor = UIColor.separator.cgColor
        textView.layer.borderWidth = 1
        textView.layer.cornerRadius = 8
        return textView
    }()

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        bridge.presenter = self
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenEndpointSettingsNotification),
            name: LukerDeepLinkRouter.openEndpointSettings,
            object: nil
        )
        configureConstraints()
        setBootState(.startingRuntime)
        startRuntime()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        #if DEBUG
        if !didHandleLaunchEndpointArgument,
           ProcessInfo.processInfo.arguments.contains("-LukerOpenEndpoint") {
            didHandleLaunchEndpointArgument = true
            presentEndpointSettings()
        }
        #endif
        if LukerDeepLinkRouter.shared.consumePendingEndpointSettings() {
            presentEndpointSettings()
        }
    }

    private func configureConstraints() {
        statusStack.addArrangedSubview(spinner)
        statusStack.addArrangedSubview(statusLabel)
        statusStack.addArrangedSubview(diagnosticsTextView)
        diagnosticsTextView.isHidden = true
        view.addSubview(statusStack)
        NSLayoutConstraint.activate([
            statusStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            statusStack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            statusStack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            view.trailingAnchor.constraint(greaterThanOrEqualTo: statusStack.trailingAnchor, constant: 24),
            diagnosticsTextView.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            diagnosticsTextView.heightAnchor.constraint(lessThanOrEqualToConstant: 320),
        ])
    }

    // MARK: - Boot flow

    private func startRuntime() {
        if !runtime.usesLocalRuntime {
            LukerDebugTrail.shared.append(
                category: "native",
                text: "custom endpoint mode url=\(runtime.serverURL.absoluteString)"
            )
            setBootState(.waitingForServer)
            waitForServer()
            return
        }

        let watchdog = LukerBootWatchdog.shared.detectAndArm(dataRoot: runtime.dataRootURL)
        safeModeTripped = watchdog.tripped

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = self?.runtime.startIfNeeded()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                guard let result else { return }
                if result.ok {
                    self.setBootState(.waitingForServer)
                    self.waitForServer()
                } else {
                    self.setBootState(.failed(reason: result.error ?? NSLocalizedString("runtime_failure_reason_unknown_error", comment: "")))
                }
            }
        }
    }

    private func waitForServer() {
        let deadline = Date().addingTimeInterval(Self.serverReadyTimeout)
        let startedAt = Date()
        let localRuntime = runtime.usesLocalRuntime
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while Date() < deadline {
                guard let self else { return }
                if self.runtime.isServerReady() {
                    if localRuntime {
                        LukerBootWatchdog.shared.markBootSucceeded()
                    }
                    DispatchQueue.main.async { [weak self] in
                        self?.setBootState(.ready)
                        if self?.safeModeTripped == true {
                            self?.showSafeModeBanner()
                        }
                    }
                    return
                }
                // A local Node process that has already exited will never make
                // the port ready; report it instead of waiting out the deadline.
                if localRuntime, Date().timeIntervalSince(startedAt) > 2, !self.runtime.isNodeRunning {
                    let detail = self.runtime.collectDiagnostics()
                    LukerDebugTrail.shared.append(
                        category: "native",
                        text: "node exited before the server was ready\n\(detail)"
                    )
                    DispatchQueue.main.async { [weak self] in
                        self?.setBootState(.failed(
                            reason: NSLocalizedString("runtime_failure_reason_node_exited", comment: "")
                        ))
                    }
                    return
                }
                Thread.sleep(forTimeInterval: Self.serverReadyPollInterval)
            }
            DispatchQueue.main.async { [weak self] in
                self?.setBootState(.failed(reason: NSLocalizedString("loading_failed_timeout", comment: "")))
            }
        }
    }

    private func setBootState(_ state: BootState) {
        switch state {
        case .startingRuntime:
            spinner.startAnimating()
            statusLabel.text = NSLocalizedString("loading_runtime", comment: "")
            diagnosticsTextView.isHidden = true
            navigationItem.rightBarButtonItems = nil
        case .waitingForServer:
            spinner.startAnimating()
            statusLabel.text = NSLocalizedString("loading_webview", comment: "")
            diagnosticsTextView.isHidden = true
        case .failed(let reason):
            spinner.stopAnimating()
            statusLabel.text = String(
                format: NSLocalizedString("loading_failed_with_reason", comment: ""),
                reason
            )
            diagnosticsTextView.text = runtime.collectDiagnostics()
            diagnosticsTextView.isHidden = false
            navigationItem.rightBarButtonItems = [
                UIBarButtonItem(
                    title: NSLocalizedString("diagnostics_export_bundle_short", comment: ""),
                    style: .plain,
                    target: self,
                    action: #selector(shareDiagnostics)
                ),
                UIBarButtonItem(
                    title: NSLocalizedString("retry", comment: ""),
                    style: .plain,
                    target: self,
                    action: #selector(retryBoot)
                ),
            ]
        case .ready:
            spinner.stopAnimating()
            statusStack.isHidden = true
            installWebView()
            showPendingCrashIfNeeded()
        }
    }

    @objc private func retryBoot() {
        setBootState(.startingRuntime)
        startRuntime()
    }

    @objc private func shareDiagnostics() {
        exportDiagnosticsBundle()
    }

    // MARK: - Web view

    private func installWebView() {
        guard webView == nil else { return }
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        bridge.presenter = self
        bridge.install(into: configuration.userContentController)
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // Keep the web layer inside the safe area: the page uses viewport-fit=cover
        // but never applies env(safe-area-inset-*), so a full-bleed web view puts the
        // top bar under the Dynamic Island and the input under the home indicator.
        view.backgroundColor = .systemBackground
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])
        self.webView = webView
        webView.load(URLRequest(url: runtime.serverURL))
    }

    // MARK: - Diagnostics UI

    func exportDiagnosticsBundle() {
        guard !isExportingDiagnostics else { return }
        isExportingDiagnostics = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let zip = try LukerDiagnosticsCenter.shared.export()
                DispatchQueue.main.async {
                    self.isExportingDiagnostics = false
                    self.presentShareSheet(for: zip)
                }
            } catch {
                LukerDebugTrail.shared.append(category: "native", text: "diagnostics export failed: \(error)")
                DispatchQueue.main.async {
                    self.isExportingDiagnostics = false
                    self.showAlert(
                        title: NSLocalizedString("diagnostics_export_failed_title", comment: ""),
                        message: String(
                            format: NSLocalizedString("diagnostics_export_failed", comment: ""),
                            error.localizedDescription
                        )
                    )
                }
            }
        }
    }

    private func presentShareSheet(for url: URL) {
        let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = activity.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(activity, animated: true)
    }

    private func showPendingCrashIfNeeded() {
        guard !pendingCrashShown else { return }
        guard let crash = LukerDiagnosticsCenter.shared.takePendingCrash() else { return }
        pendingCrashShown = true
        let summary = String(crash.report.prefix(4000))
        let message = """
        \(NSLocalizedString("crash_report_dialog_intro", comment: ""))

        \(summary)
        """
        presentReportAlert(
            title: NSLocalizedString("crash_report_dialog_title", comment: ""),
            message: message
        )
    }

    private func presentReportAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("diagnostics_export_bundle", comment: ""),
            style: .default
        ) { [weak self] _ in
            self?.exportDiagnosticsBundle()
        })
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("crash_dialog_close", comment: ""),
            style: .cancel
        ))
        alert.preferredAction = alert.actions.first
        present(alert, animated: true)
    }

    private func showAlert(title: String?, message: String?) {
        guard presentedViewController == nil else {
            LukerDebugTrail.shared.append(category: "native", text: "alert suppressed title=\(title ?? "") message=\(message ?? "")")
            return
        }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("close", comment: ""), style: .default))
        present(alert, animated: true)
    }

    private func showSafeModeBanner() {
        guard safeModeBanner == nil else { return }
        let label = UILabel()
        label.numberOfLines = 0
        label.font = .preferredFont(forTextStyle: .footnote)
        label.textColor = .label
        label.text = NSLocalizedString("safe_mode_tripped_toast", comment: "")
        label.backgroundColor = .secondarySystemBackground
        label.layer.cornerRadius = 10
        label.layer.masksToBounds = true
        label.textAlignment = .natural
        label.translatesAutoresizingMaskIntoConstraints = false

        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        view.addSubview(container)
        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            container.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            container.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
        ])
        container.isUserInteractionEnabled = false
        safeModeBanner = container
        container.alpha = 0
        UIView.animate(withDuration: 0.25) {
            container.alpha = 1
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, let banner = self.safeModeBanner else { return }
            UIView.animate(withDuration: 0.25, animations: {
                banner.alpha = 0
            }, completion: { _ in
                banner.removeFromSuperview()
                self.safeModeBanner = nil
            })
        }
    }

    // MARK: - Endpoint settings (reserved entry)

    @objc private func handleOpenEndpointSettingsNotification() {
        presentEndpointSettings()
    }

    func presentEndpointSettings() {
        guard presentedViewController == nil else { return }
        let selection = LukerEndpointConfig.shared.selection
        let alert = UIAlertController(
            title: NSLocalizedString("endpoint_dialog_title", comment: ""),
            message: NSLocalizedString("endpoint_dialog_message", comment: ""),
            preferredStyle: .alert
        )
        alert.addTextField { field in
            field.placeholder = NSLocalizedString("endpoint_dialog_hint", comment: "")
            field.text = selection.customBaseURL?.absoluteString
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("endpoint_dialog_save", comment: ""),
            style: .default
        ) { [weak self, weak alert] _ in
            let value = alert?.textFields?.first?.text ?? ""
            do {
                let saved = try LukerEndpointConfig.shared.save(value)
                if let saved {
                    self?.showAlert(
                        title: NSLocalizedString("endpoint_saved", comment: ""),
                        message: String(
                            format: NSLocalizedString("endpoint_restart_required", comment: ""),
                            saved.absoluteString
                        )
                    )
                } else {
                    self?.showAlert(
                        title: NSLocalizedString("endpoint_reset_default_done", comment: ""),
                        message: NSLocalizedString("endpoint_restart_required_plain", comment: "")
                    )
                }
            } catch {
                self?.showAlert(
                    title: NSLocalizedString("endpoint_invalid_url", comment: ""),
                    message: nil
                )
            }
        })
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("endpoint_dialog_reset", comment: ""),
            style: .destructive
        ) { [weak self] _ in
            LukerEndpointConfig.shared.reset()
            self?.showAlert(
                title: NSLocalizedString("endpoint_reset_default_done", comment: ""),
                message: NSLocalizedString("endpoint_restart_required_plain", comment: "")
            )
        })
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("cancel", comment: ""),
            style: .cancel
        ))
        present(alert, animated: true)
    }
}

// MARK: - WKNavigationDelegate

extension ViewController: WKNavigationDelegate {
    /// Mirrors the Android external link policy: same-origin navigations stay
    /// inside the app, everything else goes to the system browser.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }

        let url = navigationAction.request.url
        if runtime.isSameOriginURL(url) {
            if navigationAction.targetFrame == nil {
                // A popup (target=_blank) from the local UI: load it in the
                // same web view instead of dropping the navigation.
                if let request = navigationAction.request as URLRequest? {
                    webView.load(request)
                }
                decisionHandler(.cancel, preferences)
                return
            }
            decisionHandler(.allow, preferences)
            return
        }

        if let url, UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        } else if let url {
            let alert = UIAlertController(
                title: nil,
                message: NSLocalizedString("no_app_can_open_link", comment: ""),
                preferredStyle: .alert
            )
            alert.addAction(UIAlertAction(title: NSLocalizedString("close", comment: ""), style: .default))
            present(alert, animated: true)
        }
        decisionHandler(.cancel, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.canShowMIMEType {
            decisionHandler(.allow)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        let url = webView.url?.absoluteString
        let crash = LukerDiagnosticsCenter.shared.recordWebViewCrash(url: url, didCrash: false)
        let message = """
        \(NSLocalizedString("webview_crash_dialog_intro", comment: ""))

        \(String(crash.report.prefix(2000)))
        """
        let alert = UIAlertController(
            title: NSLocalizedString("webview_crash_dialog_title", comment: ""),
            message: message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("diagnostics_export_bundle", comment: ""),
            style: .default
        ) { [weak self] _ in
            self?.exportDiagnosticsBundle()
        })
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("crash_dialog_close", comment: ""),
            style: .cancel
        ) { _ in
            webView.load(URLRequest(url: self.runtime.serverURL))
        })
        alert.preferredAction = alert.actions.first
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        LukerDebugTrail.shared.append(category: "native", text: "navigation finished url=\(webView.url?.absoluteString ?? "<none>")")
        #if DEBUG
        LukerDebugSmoke.runCrashTestIfRequested()
        LukerDebugSmoke.runExceptionTestIfRequested()
        LukerDebugSmoke.runIfRequested(webView: webView)
        #endif
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        LukerDebugTrail.shared.append(category: "native", text: "navigation failed url=\(webView.url?.absoluteString ?? "<none>") error=\(error)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        LukerDebugTrail.shared.append(
            category: "native",
            text: "provisional navigation failed url=\(webView.url?.absoluteString ?? "<none>") error=\(error)"
        )
    }
}

// MARK: - LukerBridgePresenter

extension ViewController: LukerBridgePresenter {}

// MARK: - WKDownloadDelegate

extension ViewController: WKDownloadDelegate {
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let filename = suggestedFilename.isEmpty
            ? NSLocalizedString("download_saved_fallback_name", comment: "")
            : suggestedFilename
        let destination = FileManager.default.temporaryDirectory.appendingPathComponent(filename)
        try? FileManager.default.removeItem(at: destination)
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let fileURL = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let alert = UIAlertController(
            title: nil,
            message: String(format: NSLocalizedString("download_saved", comment: ""), fileURL.lastPathComponent),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(
            title: NSLocalizedString("download_share", comment: ""),
            style: .default
        ) { [weak self] _ in
            let share = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            self?.present(share, animated: true)
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("close", comment: ""), style: .cancel))
        present(alert, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        let alert = UIAlertController(
            title: nil,
            message: NSLocalizedString("download_failed", comment: ""),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: NSLocalizedString("close", comment: ""), style: .cancel))
        present(alert, animated: true)
    }
}

// MARK: - WKUIDelegate

extension ViewController: WKUIDelegate {
    /// JS alert()/confirm()/prompt() land here; show them natively so the web
    /// UI can use the same dialogs it uses on Android.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("close", comment: ""), style: .default) { _ in
            completionHandler()
        })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("ok", comment: ""), style: .default) { _ in
            completionHandler(true)
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("cancel", comment: ""), style: .cancel) { _ in
            completionHandler(false)
        })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { textField in
            textField.text = defaultText
        }
        alert.addAction(UIAlertAction(title: NSLocalizedString("ok", comment: ""), style: .default) { _ in
            completionHandler(alert.textFields?.first?.text)
        })
        alert.addAction(UIAlertAction(title: NSLocalizedString("cancel", comment: ""), style: .cancel) { _ in
            completionHandler(nil)
        })
        present(alert, animated: true)
    }
}
