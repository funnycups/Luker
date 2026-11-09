// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation

/// Owns the launch-time diagnostic setup so AppDelegate and the view
/// controller do not need to remember the ordering: read the previous run's
/// crash files before installing this run's handlers.
final class LukerDiagnosticsCenter {
    static let shared = LukerDiagnosticsCenter()

    private var pendingCrash: LukerCapturedCrash?

    private init() {}

    func start() {
        let runtime = LukerRuntimeManager.shared
        let root = runtime.diagnosticsRootURL
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            NSLog("[LukerDiagnostics] Failed to create the diagnostics directory: %@", String(describing: error))
        }
        LukerDebugTrail.shared.attach(directory: root)
        // Read the trail before appending this launch's first line so the
        // report below contains the run that died, not this run.
        let previousTrail = LukerDebugTrail.shared.readPersisted()
        LukerDebugTrail.shared.append(
            category: "native",
            text: "launch app=\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?")"
        )
        writePendingBootFailureReport(in: root, runtime: runtime, previousTrail: previousTrail)
        pendingCrash = LukerCrashReporter.shared.collectPendingReport(in: root)
        if let pendingCrash {
            LukerDebugTrail.shared.append(category: "native", text: "previous crash report detected at \(pendingCrash.timestamp)")
        }
        LukerCrashReporter.shared.install(in: root)
    }

    // MARK: - Boot failure

    private func writePendingBootFailureReport(
        in root: URL,
        runtime: LukerRuntimeManager,
        previousTrail: String
    ) {
        guard let failure = LukerBootWatchdog.shared.pendingBootFailure() else { return }
        let report = buildBootFailureReport(
            failure,
            previousTrail: previousTrail,
            bootstrapLog: runtime.bootstrapLogFile()
        )
        let file = root.appendingPathComponent(LukerCrashReporter.bootFailureFileName)
        do {
            try report.write(to: file, atomically: true, encoding: .utf8)
            LukerDebugTrail.shared.append(
                category: "native",
                text: "boot failure report written startedAt=\(failure.startedAt) streak=\(failure.failedStreak)"
            )
        } catch {
            NSLog("[LukerDiagnostics] Failed to write the boot failure report: %@", String(describing: error))
            LukerDebugTrail.shared.append(
                category: "native",
                text: "boot failure report write failed: \(error)"
            )
        }
    }

    private func buildBootFailureReport(
        _ failure: LukerPendingBootFailure,
        previousTrail: String,
        bootstrapLog: URL
    ) -> String {
        let elapsed = max(0, Date().timeIntervalSince(failure.startedAt))
        let previousRunTrail = Self.trailSince(previousTrail, start: failure.startedAt)
        let trailText = previousRunTrail.isEmpty ? previousTrail : previousRunTrail
        let trailTail = Self.tail(trailText, maxCharacters: 4000)
        let lastTrailLines = Self.lastLines(trailText, count: 8)
        let bootstrapTail = Self.tail(Self.readBootstrapTail(bootstrapLog), maxCharacters: 4000)
        var lines: [String] = []
        lines.append("source=boot-failure")
        lines.append("when=\(LukerCrashReporter.formatter.string(from: failure.startedAt))")
        lines.append("elapsedSinceBootStart=\(String(format: "%.1f", elapsed))s")
        lines.append("failedStreak=\(failure.failedStreak)")
        if let lastFailedAt = failure.lastFailedAt {
            lines.append("lastFailedAt=\(LukerCrashReporter.formatter.string(from: lastFailedAt))")
        }
        if let lastLine = lastTrailLines.split(separator: "\n").last {
            lines.append("lastTrailLine=\(lastLine)")
        }
        lines.append(LukerCrashReporter.deviceHeader())
        lines.append("")
        lines.append("The previous run ended before the local server became ready. This section records the tail of the persisted native trail and the embedded service log; any captured signal or exception report is included above.")
        lines.append("")
        lines.append("--- last trail lines ---")
        lines.append(lastTrailLines.isEmpty ? "<empty>" : lastTrailLines)
        lines.append("")
        lines.append("--- debug-trail tail ---")
        lines.append(trailTail.isEmpty ? "<empty>" : trailTail)
        lines.append("")
        lines.append("--- bootstrap.log tail ---")
        lines.append(bootstrapTail.isEmpty ? "<empty or not created>" : bootstrapTail)
        lines.append("")
        lines.append("Full files are included in the diagnostics bundle as debug-trail.txt and bootstrap.log.")
        return lines.joined(separator: "\n")
    }

    private static func readBootstrapTail(_ url: URL) -> String {
        guard let data = LukerDiagnosticsExporter.tail(of: url, maxBytes: 8192) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// Drops lines written by older launches. The trail file is append-only
    /// across launches, and a raw tail would otherwise lead with stale
    /// WebView console lines instead of the failed boot's stages.
    private static func trailSince(_ text: String, start: Date) -> String {
        let cutoff = Int(start.timeIntervalSince1970 * 1000) - 1000
        let lines = text.split(separator: "\n")
        let filtered = lines.filter { line in
            guard let token = line.split(separator: " ", maxSplits: 1).first,
                  let timestamp = Int(token) else { return false }
            return timestamp >= cutoff
        }
        return filtered.joined(separator: "\n")
    }

    private static func lastLines(_ text: String, count: Int) -> String {
        text.split(separator: "\n").suffix(count).joined(separator: "\n")
    }

    private static func tail(_ text: String, maxCharacters: Int) -> String {
        guard text.count > maxCharacters else { return text }
        let start = text.index(text.endIndex, offsetBy: -maxCharacters)
        var suffix = String(text[start...])
        if let newline = suffix.firstIndex(of: "\n") {
            suffix = String(suffix[suffix.index(after: newline)...])
        }
        return "…[truncated]\n" + suffix
    }

    func takePendingCrash() -> LukerCapturedCrash? {
        defer { pendingCrash = nil }
        return pendingCrash
    }

    func recordWebViewCrash(url: String?, didCrash: Bool) -> LukerCapturedCrash {
        LukerCrashReporter.shared.recordWebViewCrash(url: url, didCrash: didCrash)
    }

    func export() throws -> URL {
        try LukerDiagnosticsExporter.shared.export(runtime: LukerRuntimeManager.shared)
    }
}
