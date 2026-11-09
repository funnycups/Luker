// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation
import OSLog
import UIKit
import UserNotifications

/// Bundles every diagnostic artifact the iOS shell knows how to find into a
/// single zip, mirroring android-app/.../LukerDiagnosticsExporter.kt.
///
/// Native-only material that a page-side export cannot reach:
/// - the debug trail written by the WebView console hook and native layers
/// - uncaught-exception and signal crash reports from the previous run
/// - OSLog entries emitted by this process
/// - Node `report.*.json` and heap snapshots
final class LukerDiagnosticsExporter {
    static let shared = LukerDiagnosticsExporter()

    private static let bootstrapLogTailBytes = 512 * 1024
    private static let osLogTailBytes = 512 * 1024
    private static let osLogWindow: TimeInterval = 30 * 60

    private init() {}

    func export(runtime: LukerRuntimeManager) throws -> URL {
        let root = runtime.diagnosticsRootURL
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
        let stamp = Self.fileStamp.string(from: Date())
        let zipURL = exports.appendingPathComponent("luker-diagnostics-\(stamp).zip")

        var entries: [(String, Data)] = []
        let summary = buildSummary(runtime: runtime)
        entries.append(("summary.txt", Data(summary.utf8)))

        let bootstrap = runtime.bootstrapLogFile()
        if let data = Self.tail(of: bootstrap, maxBytes: Self.bootstrapLogTailBytes) {
            entries.append(("bootstrap.log", data))
        }

        for file in crashFiles(in: root) {
            if let data = try? Data(contentsOf: file) {
                entries.append(("crashes/\(file.lastPathComponent)", data))
            }
        }

        let trail = LukerDebugTrail.shared
        let persistedTrail = trail.readPersisted()
        entries.append(("debug-trail.txt", Data(persistedTrail.utf8)))
        if let rotated = trail.rotatedFileURL(), let data = try? Data(contentsOf: rotated) {
            entries.append(("debug-trail.old.log", data))
        }

        for artifact in runtime.listNodeDiagnosticArtifacts() {
            if let data = try? Data(contentsOf: artifact) {
                entries.append(("node/\(artifact.lastPathComponent)", data))
            }
        }

        let oslog = buildOSLogText()
        entries.append(("oslog.txt", Data(oslog.utf8)))

        try LukerZipWriter.write(entries: entries, to: zipURL)
        return zipURL
    }

    private func buildSummary(runtime: LukerRuntimeManager) -> String {
        let bundle = Bundle.main
        let version = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "<unknown>"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "<unknown>"
        let ui = uiSnapshot()
        let process = ProcessInfo.processInfo
        var lines: [String] = []

        lines.append("Luker iOS diagnostics bundle")
        lines.append("generatedAt=\(Self.readableStamp.string(from: Date()))")
        lines.append("app=\(version) (\(build))")
        lines.append("bundle=\(bundle.bundleIdentifier ?? "<unknown>")")
        lines.append("ios=\(ui.systemName) \(ui.systemVersion)")
        lines.append("device=\(ui.deviceModel) (\(ui.vendorIdentifier))")
        lines.append("locale=\(ui.locale), timeZone=\(TimeZone.current.identifier)")
        lines.append("screen=\(ui.screenWidth)x\(ui.screenHeight) @\(ui.screenScale)x")
        lines.append("physicalMemory=\(process.physicalMemory) bytes, processors=\(process.processorCount)")
        lines.append("thermalState=\(Self.thermalStateName(process.thermalState)), lowPowerMode=\(process.isLowPowerModeEnabled)")
        lines.append("appState=\(ui.applicationState)")
        lines.append("backgroundRefresh=\(ui.backgroundRefresh)")
        lines.append("notificationAuthorization=\(LukerNotificationManager.shared.cachedAuthorizationStatus)")
        lines.append("")
        lines.append("--- endpoint ---")
        let endpoint = LukerEndpointConfig.shared.selection
        lines.append("mode=\(endpoint.usesLocalRuntime ? "local" : "custom")")
        lines.append("baseURL=\(endpoint.baseURL.absoluteString)")
        lines.append("")
        lines.append("--- safe mode ---")
        let sentinel = runtime.dataRootURL.appendingPathComponent(".luker-safe-mode.json")
        if let body = try? String(contentsOf: sentinel, encoding: .utf8) {
            lines.append("sentinel=\(sentinel.path)")
            lines.append(body)
        } else {
            lines.append("sentinel=<absent>")
        }
        lines.append("")
        lines.append("--- crash files ---")
        let crashes = crashFiles(in: runtime.diagnosticsRootURL)
        if crashes.isEmpty {
            lines.append("<none>")
        } else {
            for file in crashes {
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                lines.append("  \(file.path) (\(size) bytes)")
            }
        }
        lines.append("")
        lines.append("--- runtime diagnostics ---")
        lines.append(runtime.collectDiagnostics())
        return lines.joined(separator: "\n")
    }

    private struct UISnapshot {
        let systemName: String
        let systemVersion: String
        let deviceModel: String
        let vendorIdentifier: String
        let locale: String
        let screenWidth: Int
        let screenHeight: Int
        let screenScale: CGFloat
        let applicationState: String
        let backgroundRefresh: String
    }

    /// UIKit state is main-thread-only; the exporter itself runs off the main
    /// thread so the zip and OSLog reads do not block the interface.
    private func uiSnapshot() -> UISnapshot {
        let build: () -> UISnapshot = {
            let device = UIDevice.current
            let screen = UIScreen.main
            return UISnapshot(
                systemName: device.systemName,
                systemVersion: device.systemVersion,
                deviceModel: device.model,
                vendorIdentifier: device.identifierForVendor?.uuidString ?? "<no-vendor-id>",
                locale: Locale.current.identifier,
                screenWidth: Int(screen.bounds.width),
                screenHeight: Int(screen.bounds.height),
                screenScale: screen.scale,
                applicationState: Self.applicationStateName(UIApplication.shared.applicationState),
                backgroundRefresh: Self.backgroundRefreshName(UIApplication.shared.backgroundRefreshStatus)
            )
        }
        if Thread.isMainThread {
            return build()
        }
        return DispatchQueue.main.sync(execute: build)
    }

    private func crashFiles(in root: URL) -> [URL] {
        var files: [URL] = []
        let manager = FileManager.default
        for name in [
            LukerCrashReporter.exceptionFileName,
            LukerCrashReporter.signalFileName,
            LukerCrashReporter.webViewFileName,
            LukerCrashReporter.bootFailureFileName,
        ] {
            let file = root.appendingPathComponent(name)
            guard manager.fileExists(atPath: file.path) else { continue }
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            guard size > 0 else { continue }
            files.append(file)
        }
        files.append(contentsOf: LukerCrashReporter.shared.archivedReports(in: root).filter { file in
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            return size > 0
        })
        return files
    }

    private func buildOSLogText() -> String {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let position = store.position(date: Date().addingTimeInterval(-Self.osLogWindow))
            let entries = try store.getEntries(at: position)
            var lines: [String] = []
            var bytes = 0
            for entry in entries {
                let line = "\(Self.readableStamp.string(from: entry.date)) \(entry.composedMessage)"
                // Keeps the diagnostics zip shareable; the trail and bootstrap
                // log carry the same window for everything Luker logs itself.
                if bytes + line.utf8.count > Self.osLogTailBytes {
                    lines.append("…[truncated at \(Self.osLogTailBytes) bytes]")
                    break
                }
                lines.append(line)
                bytes += line.utf8.count + 1
            }
            return lines.isEmpty ? "oslog: <no entries in the last 30 minutes>" : lines.joined(separator: "\n") + "\n"
        } catch {
            return "oslog: <unavailable: \(String(describing: error))>\n"
        }
    }

    static func tail(of file: URL, maxBytes: Int) -> Data? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else { return nil }
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        do {
            try handle.seek(toOffset: start)
            return try handle.readToEnd()
        } catch {
            return nil
        }
    }

    private static let fileStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter
    }()

    private static let readableStamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return formatter
    }()

    private static func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown(\(state.rawValue))"
        }
    }

    private static func applicationStateName(_ state: UIApplication.State) -> String {
        switch state {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown(\(state.rawValue))"
        }
    }

    private static func backgroundRefreshName(_ status: UIBackgroundRefreshStatus) -> String {
        switch status {
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .available: return "available"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }
}

// MARK: - Minimal ZIP writer

/// Writes a store-only (no compression) zip. Diagnostics content is mostly
/// text and already small; store mode keeps the writer dependency-free.
private enum LukerZipWriter {
    static func write(entries: [(String, Data)], to url: URL) throws {
        var output = Data()
        var centralDirectory = Data()
        var offset: UInt32 = 0

        for (name, data) in entries {
            let nameBytes = Array(name.utf8)
            let crc = crc32(data)
            let size = UInt32(data.count)

            var local = Data()
            local.appendLE(UInt32(0x04034b50))
            local.appendLE(UInt16(20))
            local.appendLE(UInt16(0x0800)) // UTF-8 names
            local.appendLE(UInt16(0))      // store
            local.appendLE(UInt16(0))      // mod time
            local.appendLE(UInt16(0))      // mod date
            local.appendLE(crc)
            local.appendLE(size)
            local.appendLE(size)
            local.appendLE(UInt16(nameBytes.count))
            local.appendLE(UInt16(0))
            local.append(contentsOf: nameBytes)
            local.append(data)
            output.append(local)

            var central = Data()
            central.appendLE(UInt32(0x02014b50))
            central.appendLE(UInt16(20)) // version made by
            central.appendLE(UInt16(20)) // version needed
            central.appendLE(UInt16(0x0800))
            central.appendLE(UInt16(0))
            central.appendLE(UInt16(0))
            central.appendLE(UInt16(0))
            central.appendLE(crc)
            central.appendLE(size)
            central.appendLE(size)
            central.appendLE(UInt16(nameBytes.count))
            central.appendLE(UInt16(0)) // extra
            central.appendLE(UInt16(0)) // comment
            central.appendLE(UInt16(0)) // disk
            central.appendLE(UInt16(0)) // internal attrs
            central.appendLE(UInt32(0)) // external attrs
            central.appendLE(offset)
            central.append(contentsOf: nameBytes)
            centralDirectory.append(central)

            offset += UInt32(local.count)
        }

        var end = Data()
        end.appendLE(UInt32(0x06054b50))
        end.appendLE(UInt16(0))
        end.appendLE(UInt16(0))
        end.appendLE(UInt16(entries.count))
        end.appendLE(UInt16(entries.count))
        end.appendLE(UInt32(centralDirectory.count))
        end.appendLE(offset)
        end.appendLE(UInt16(0))

        output.append(centralDirectory)
        output.append(end)
        try output.write(to: url, options: .atomic)
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data {
            let index = Int((crc ^ UInt32(byte)) & 0xff)
            crc = (crc >> 8) ^ table[index]
        }
        return crc ^ 0xffffffff
    }

    private static let table: [UInt32] = {
        (0..<256).map { value in
            var crc = UInt32(value)
            for _ in 0..<8 {
                crc = (crc & 1) != 0 ? (0xedb88320 ^ (crc >> 1)) : (crc >> 1)
            }
            return crc
        }
    }()
}

private extension Data {
    mutating func appendLE(_ value: UInt16) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
    }

    mutating func appendLE(_ value: UInt32) {
        append(UInt8(value & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 24) & 0xff))
    }
}
