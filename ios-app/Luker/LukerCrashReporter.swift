// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Darwin
import Foundation
import UIKit

struct LukerCapturedCrash {
    let report: String
    let reportFile: URL?
    let timestamp: Date
}

/// Captures the two crash classes iOS lets an app observe in-process:
/// uncaught Objective-C/Swift exceptions, and fatal signals.
///
/// The signal path writes a pre-rendered header plus `backtrace_symbols_fd`
/// output to a file opened at signal time. That keeps the handler to
/// async-signal-safe calls; symbolication still needs the dSYM, but the raw
/// frames and the signal name are enough to locate the fault.
///
/// Signal handlers are best effort: the embedded JavaScript runtime installs
/// its own fatal-signal handlers once it starts, so the in-process signal
/// report covers the boot window. Later crashes are covered by MetricKit
/// payloads and the WebView process-termination report.
final class LukerCrashReporter {
    static let shared = LukerCrashReporter()

    static let exceptionFileName = "luker-last-crash-report.txt"
    static let signalFileName = "luker-last-signal-crash.txt"
    static let webViewFileName = "luker-last-webview-crash-report.txt"
    static let bootFailureFileName = "luker-last-boot-failure.txt"

    private static let archiveDirName = "crash-archive"
    private static let maxArchivedReports = 10

    private var directory: URL?
    private var installed = false

    private init() {}

    // MARK: - Install

    func install(in directory: URL) {
        guard !installed else { return }
        installed = true
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        NSSetUncaughtExceptionHandler(lukerExceptionHandler)
        installSignalHandlers(directory: directory)
        LukerDebugTrail.shared.append(category: "native", text: "crash handlers installed")
    }

    // MARK: - Pending reports

    /// Reads crash files left by the previous run, moves them into the export
    /// archive, and returns the combined report. Returns nil when the previous
    /// run ended normally.
    func collectPendingReport(in directory: URL) -> LukerCapturedCrash? {
        self.directory = directory
        let candidates = [Self.exceptionFileName, Self.signalFileName, Self.bootFailureFileName]
        var sections: [String] = []
        var newestFile: URL?
        var newestDate = Date.distantPast

        for name in candidates {
            let file = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? UInt64) ?? 0
            guard size > 0 else {
                // A zero-length report is an interrupted write, not a crash.
                try? FileManager.default.removeItem(at: file)
                continue
            }
            let body = (try? String(contentsOf: file, encoding: .utf8)) ?? "<unreadable: \(name)>"
            let date = (try? FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date) ?? Date()
            sections.append(body.trimmingCharacters(in: .whitespacesAndNewlines))
            if date > newestDate {
                newestDate = date
                newestFile = file
            }
            archive(file, in: directory, timestamp: date)
        }

        guard !sections.isEmpty else { return nil }
        return LukerCapturedCrash(
            report: sections.joined(separator: "\n\n---\n\n"),
            reportFile: newestFile,
            timestamp: newestDate
        )
    }

    // MARK: - WebView crash

    func recordWebViewCrash(url: String?, didCrash: Bool) -> LukerCapturedCrash {
        let now = Date()
        let report = """
        source=webview-content-process
        when=\(Self.formatter.string(from: now))
        didCrash=\(didCrash)
        url=\(url ?? "<unknown>")
        \(Self.deviceHeader())
        """
        let file = writeReport(report, name: Self.webViewFileName)
        LukerDebugTrail.shared.append(
            category: "native",
            text: "webViewContentProcessTerminated didCrash=\(didCrash) url=\(url ?? "<unknown>")"
        )
        if let directory, let file {
            archive(file, in: directory, timestamp: now, removeOriginal: false)
        }
        return LukerCapturedCrash(report: report, reportFile: file, timestamp: now)
    }

    // MARK: - Helpers

    static func deviceHeader() -> String {
        let bundle = Bundle.main
        let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "<unknown>"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "<unknown>"
        let device = UIDevice.current
        return """
        app=\(version) (\(build))
        ios=\(device.systemName) \(device.systemVersion)
        device=\(device.model) (\(device.identifierForVendor?.uuidString ?? "<no-vendor-id>"))
        locale=\(Locale.current.identifier)
        """
    }

    static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return formatter
    }()

    func archiveDirectory(in directory: URL) -> URL {
        directory.appendingPathComponent(Self.archiveDirName, isDirectory: true)
    }

    func archivedReports(in directory: URL) -> [URL] {
        let dir = archiveDirectory(in: directory)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        return entries.sorted { lhs, rhs in
            let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return left > right
        }
    }

    private func writeReport(_ body: String, name: String) -> URL? {
        guard let directory else { return nil }
        let file = directory.appendingPathComponent(name)
        do {
            try body.write(to: file, atomically: true, encoding: .utf8)
            return file
        } catch {
            NSLog("[LukerCrashReporter] Failed to write %@: %@", name, String(describing: error))
            return nil
        }
    }

    private func archive(_ file: URL, in directory: URL, timestamp: Date, removeOriginal: Bool = true) {
        let manager = FileManager.default
        let archiveDir = archiveDirectory(in: directory)
        do {
            try manager.createDirectory(at: archiveDir, withIntermediateDirectories: true)
            let stamp = Self.archiveStamp.string(from: timestamp)
            let base = file.deletingPathExtension().lastPathComponent
            let target = archiveDir.appendingPathComponent("\(base)-\(stamp).txt")
            if manager.fileExists(atPath: target.path) {
                try manager.removeItem(at: target)
            }
            if removeOriginal {
                try manager.moveItem(at: file, to: target)
            } else {
                try manager.copyItem(at: file, to: target)
            }
        } catch {
            NSLog("[LukerCrashReporter] Failed to archive %@: %@", file.lastPathComponent, String(describing: error))
        }
        pruneArchive(in: directory)
    }

    private func pruneArchive(in directory: URL) {
        let manager = FileManager.default
        let reports = archivedReports(in: directory)
        guard reports.count > Self.maxArchivedReports else { return }
        for file in reports.dropFirst(Self.maxArchivedReports) {
            try? manager.removeItem(at: file)
        }
    }

    private static let archiveStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()
}

// MARK: - Uncaught exceptions

private func lukerExceptionHandler(_ exception: NSException) {
    let body = """
    source=uncaught-exception
    when=\(LukerCrashReporter.formatter.string(from: Date()))
    \(LukerCrashReporter.deviceHeader())
    name=\(exception.name.rawValue)
    reason=\(exception.reason ?? "<none>")
    stack:
    \(exception.callStackSymbols.joined(separator: "\n"))
    """
    if let directory = lukerCrashDirectory() {
        let file = directory.appendingPathComponent(LukerCrashReporter.exceptionFileName)
        try? body.write(to: file, atomically: true, encoding: .utf8)
    }
    LukerDebugTrail.shared.append(category: "crash", text: "uncaught exception \(exception.name.rawValue): \(exception.reason ?? "<none>")")
}

// MARK: - Signals

private var lukerSignalPath: [CChar] = []
private var lukerSignalHeader: [UInt8] = []
private var lukerSignalSignalPrefix: [UInt8] = Array("signal=".utf8)
private var lukerSignalNewline: [UInt8] = Array("\n".utf8)
private var lukerSignalDigits: [UInt8] = [UInt8](repeating: 0, count: 4)
private var lukerSignalFrames: [UnsafeMutableRawPointer?] = [UnsafeMutableRawPointer?](repeating: nil, count: 64)
private var lukerSignalInHandler: Int32 = 0
private var lukerSignalDirectory: String?

private func lukerCrashDirectory() -> URL? {
    guard let path = lukerSignalDirectory else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true)
}

private func installSignalHandlers(directory: URL) {
    lukerSignalDirectory = directory.path
    let file = directory.appendingPathComponent(LukerCrashReporter.signalFileName)
    lukerSignalPath = Array(file.path.utf8CString)
    lukerSignalHeader = Array("""
    source=signal
    \(LukerCrashReporter.deviceHeader())
    pid=\(getpid())
    stack:
    """.utf8)
    for signalNumber in [SIGABRT, SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGTRAP] {
        signal(signalNumber, lukerSignalHandler)
    }
}

private func lukerSignalHandler(_ signalNumber: Int32) {
    if lukerSignalInHandler != 0 {
        _exit(128 + signalNumber)
    }
    lukerSignalInHandler = 1

    // Open at signal time instead of keeping a descriptor alive: WebKit closes
    // inherited descriptors while it starts its helper processes, and a stale
    // fd made every post-load crash report empty. `open` is async-signal-safe.
    let fd = lukerSignalPath.withUnsafeBufferPointer { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return -1 }
        return open(base, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    }
    if fd >= 0 {
        lukerSignalHeader.withUnsafeBytes { raw in
            _ = write(fd, raw.baseAddress, raw.count)
        }
        var number = signalNumber
        var count = 0
        if number == 0 {
            lukerSignalDigits[0] = 48
            count = 1
        } else {
            if number < 0 { number = -number }
            while number > 0 && count < lukerSignalDigits.count {
                lukerSignalDigits[count] = UInt8(48 + (number % 10))
                number /= 10
                count += 1
            }
        }
        lukerSignalSignalPrefix.withUnsafeBytes { raw in
            _ = write(fd, raw.baseAddress, raw.count)
        }
        var index = count - 1
        while index >= 0 {
            _ = write(fd, &lukerSignalDigits[index], 1)
            index -= 1
        }
        lukerSignalNewline.withUnsafeBytes { raw in
            _ = write(fd, raw.baseAddress, raw.count)
        }
        let frameCount = lukerSignalFrames.withUnsafeMutableBufferPointer { buffer in
            backtrace(buffer.baseAddress, Int32(buffer.count))
        }
        lukerSignalFrames.withUnsafeMutableBufferPointer { buffer in
            backtrace_symbols_fd(buffer.baseAddress, frameCount, fd)
        }
        fsync(fd)
        close(fd)
    }

    signal(signalNumber, SIG_DFL)
    raise(signalNumber)
    _exit(128 + signalNumber)
}
