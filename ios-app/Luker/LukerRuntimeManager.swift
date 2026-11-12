// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Darwin
import Foundation
import UIKit

/// Mirrors android-app/app/src/main/java/com/luker/app/LukerRuntimeManager.kt and
/// ServerPluginRuntime.kt: installs the bundled server runtime into app-private
/// storage, starts the embedded Node.js runtime, and probes the local server.
final class LukerRuntimeManager {
    static let shared = LukerRuntimeManager()

    private static let defaultServerPort = 8000
    private static let maxPortProbeAttempts = 50
    private static let runtimeLayoutVersion = "5"
    private static let runtimeMarkerName = ".runtime-version"
    private static let runtimeDirName = "luker-runtime"
    private static let persistentDataDirName = "luker-data"
    private static let diagnosticsDirName = "luker-diagnostics"
    private static let configFileName = "config.yaml"
    private static let runtimePersistDirName = "_runtime-persist"
    private static let serverPluginsDirName = "plugins"
    private static let globalExtensionsRelativePath = "extensions/third-party"
    private static let serverPluginsAliasName = "_server-plugins"
    private static let bundleProjectDirName = "nodejs-project"
    private static let prebuiltBundlesDirName = "_prebuilt-bundles"
    /// Must match PREBUILT_BUNDLE_FILES in src/middleware/webpack-serve.js. If any
    /// file is missing, the server-side resolver rejects the whole dir and falls
    /// back to compiling Webpack in-process.
    private static let requiredPrebuiltBundles: Set<String> = [
        "lib.core.bundle.js",
        "lib.optional.bundle.js",
        "codemirror.bundle.js",
    ]
    private static let bootstrapLogFileName = "bootstrap.log"
    private static let runtimeTreeVersionFileName = ".runtime-tree-version"
    private static let serverReadyProbeTimeout: TimeInterval = 0.4
    private static let runtimePersistRelativePaths = ["whitelist.txt"]
    /// Files that belong to the runtime root but not to the bundled tree, so the
    /// sync and prune passes leave them alone.
    private static let runtimeRootLocalFileNames: Set<String> = [
        ".runtime-version",
        "whitelist.txt",
        "bootstrap.log",
        "_server-plugins",
        "data",
    ]
    /// Reports copy progress in batches instead of once per file.
    private static let copyProgressBatch = 64

    private let lock = NSLock()
    private var started = false
    private(set) var serverPort: Int = LukerRuntimeManager.defaultServerPort

    var localServerURL: URL {
        URL(string: "http://127.0.0.1:\(serverPort)")!
    }

    var serverURL: URL {
        LukerEndpointConfig.shared.selection.customBaseURL ?? localServerURL
    }

    var dataRootURL: URL {
        dataRoot
    }

    var isNodeRunning: Bool {
        luker_node_is_running()
    }

    var usesLocalRuntime: Bool {
        LukerEndpointConfig.shared.selection.usesLocalRuntime
    }

    var diagnosticsRootURL: URL {
        applicationSupportRoot.appendingPathComponent(Self.diagnosticsDirName, isDirectory: true)
    }

    struct StartResult {
        let ok: Bool
        let error: String?
    }

    private struct RuntimePaths {
        let runtimeRoot: URL
        let dataRoot: URL
        let serverPluginsRoot: URL
        let globalExtensionsRoot: URL
    }

    private var applicationSupportRoot: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    private var runtimeRoot: URL {
        applicationSupportRoot.appendingPathComponent(Self.runtimeDirName, isDirectory: true)
    }

    private var dataRoot: URL {
        applicationSupportRoot.appendingPathComponent(Self.persistentDataDirName, isDirectory: true)
    }

    // MARK: - Start

    func startIfNeeded(progress: ((Int, Int) -> Void)? = nil) -> StartResult {
        lock.lock()
        defer { lock.unlock() }

        if started && !luker_node_is_running() {
            NSLog("[LukerRuntime] Node process was marked started but is not running. Resetting start state.")
            started = false
        }
        if started {
            return StartResult(ok: true, error: nil)
        }

        do {
            let paths = try prepareRuntime(progress: progress)
            let selectedPort = try selectServerPort()
            serverPort = selectedPort

            let script = paths.runtimeRoot.appendingPathComponent("bootstrap.js")
            let arguments: [String] = [
                "node",
                "--preserve-symlinks",
                "--preserve-symlinks-main",
                "--report-on-fatalerror",
                "--report-directory", paths.runtimeRoot.path,
                script.path,
                "--port", String(selectedPort),
                "--dataRoot", paths.dataRoot.path,
                "--serverPluginsPath", paths.serverPluginsRoot.path,
                "--globalExtensionsPath", paths.globalExtensionsRoot.path,
                "--configPath", paths.dataRoot.appendingPathComponent(Self.configFileName).path,
                "--backupsPath", paths.dataRoot.appendingPathComponent("backups", isDirectory: true).path,
            ]
            let rawArguments = arguments.map { strdup($0) }
            defer { rawArguments.forEach { free($0) } }
            let cArguments: [UnsafePointer<CChar>?] = rawArguments.map { $0.map { UnsafePointer($0) } }
            LukerDebugTrail.shared.append(
                category: "native",
                text: "node start requested port=\(selectedPort)"
            )
            let exitCode = cArguments.withUnsafeBufferPointer { buffer in
                luker_node_start(buffer.baseAddress, Int32(arguments.count))
            }
            LukerDebugTrail.shared.append(
                category: "native",
                text: "node start returned code=\(exitCode) running=\(luker_node_is_running() ? 1 : 0)"
            )
            if exitCode != 0 {
                NSLog("[LukerRuntime] luker_node_start returned non-zero: %d", exitCode)
                return StartResult(
                    ok: false,
                    error: String(
                        format: NSLocalizedString("runtime_start_error_node_exit_code", comment: ""),
                        Int(exitCode)
                    )
                )
            }
            started = true
            NSLog("[LukerRuntime] Node runtime launch requested on port=%d running=%d", selectedPort, luker_node_is_running() ? 1 : 0)
            return StartResult(ok: true, error: nil)
        } catch {
            NSLog("[LukerRuntime] Failed to start runtime: %@", String(describing: error))
            LukerDebugTrail.shared.append(category: "native", text: "runtime start failed: \(error)")
            return StartResult(ok: false, error: String(describing: error))
        }
    }

    func stopIfNeeded() {
        lock.lock()
        defer { lock.unlock() }
        guard started || luker_node_is_running() else { return }
        luker_node_stop()
        started = false
    }

    // MARK: - Runtime installation

    /// Mirrors ServerPluginRuntime.prepare: the runtime root carries a
    /// `_server-plugins` symlink to the persistent plugins root so ST plugins
    /// resolve at the host-relative depth they expect.
    private func prepareServerPluginsAlias(runtimeRoot: URL, pluginsRoot: URL) throws {
        try detachServerPluginsAlias(at: runtimeRoot)
        try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: pluginsRoot, withIntermediateDirectories: true)
        let packageFile = pluginsRoot.appendingPathComponent("package.json")
        if !FileManager.default.fileExists(atPath: packageFile.path) {
            let stub = #"{"name":"sillytavern-plugins","type":"commonjs"}"#
            try stub.write(to: packageFile, atomically: true, encoding: .utf8)
        }
        let alias = runtimeRoot.appendingPathComponent(Self.serverPluginsAliasName)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: pluginsRoot)
    }

    /// Mirrors ServerPluginRuntime.detach: only ever delete the symlink itself,
    /// never its target, which holds persistent user files.
    private func detachServerPluginsAlias(at runtimeRoot: URL) throws {
        let alias = runtimeRoot.appendingPathComponent(Self.serverPluginsAliasName)
        let manager = FileManager.default
        let isSymlink: Bool
        do {
            _ = try manager.destinationOfSymbolicLink(atPath: alias.path)
            isSymlink = true
        } catch {
            isSymlink = false
        }
        if isSymlink {
            try manager.removeItem(at: alias)
        } else if manager.fileExists(atPath: alias.path) {
            throw NSError(
                domain: "LukerRuntimeManager",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Server plugin runtime alias is occupied: \(alias.path)"]
            )
        }
    }

    private func prepareRuntime(progress: ((Int, Int) -> Void)? = nil) throws -> RuntimePaths {
        let runtimeRoot = self.runtimeRoot
        try detachServerPluginsAlias(at: runtimeRoot)

        let dataRoot = self.dataRoot
        let persistRoot = dataRoot.appendingPathComponent(Self.runtimePersistDirName, isDirectory: true)
        let serverPluginsRoot = dataRoot.appendingPathComponent(Self.serverPluginsDirName, isDirectory: true)
        let globalExtensionsRoot = dataRoot.appendingPathComponent(
            Self.globalExtensionsRelativePath,
            isDirectory: true
        )
        let markerFile = runtimeRoot.appendingPathComponent(Self.runtimeMarkerName)

        try migrateLegacyDataRoot(
            legacy: runtimeRoot.appendingPathComponent("data", isDirectory: true),
            target: dataRoot
        )
        try migrateRuntimeConfigToDataRoot(runtimeRoot: runtimeRoot, persistRoot: persistRoot, dataRoot: dataRoot)
        try migrateLegacyRuntimePaths(
            runtimeRoot: runtimeRoot,
            persistRoot: persistRoot,
            serverPluginsRoot: serverPluginsRoot,
            globalExtensionsRoot: globalExtensionsRoot
        )
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: serverPluginsRoot, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: globalExtensionsRoot, withIntermediateDirectories: true)

        let markerValue = buildRuntimeMarker()
        let markerExists = FileManager.default.fileExists(atPath: markerFile.path)
        let currentMarker = markerExists ? try? String(contentsOf: markerFile, encoding: .utf8) : nil
        let needsRefresh = !markerExists || currentMarker != markerValue
        LukerDebugTrail.shared.append(
            category: "native",
            text: "runtime prepare start refresh=\(needsRefresh) marker=\(markerValue)"
        )

        if needsRefresh {
            if FileManager.default.fileExists(atPath: runtimeRoot.path) {
                try persistRuntimeArtifacts(from: runtimeRoot, to: persistRoot)
            }
            try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
            do {
                try linkBundledNodeProject(to: runtimeRoot, progress: progress)
            } catch {
                LukerDebugTrail.shared.append(
                    category: "native",
                    text: "runtime refresh failed: \(error)"
                )
                throw error
            }
            try restoreRuntimeArtifacts(from: persistRoot, to: runtimeRoot)
            try markerValue.write(to: markerFile, atomically: true, encoding: .utf8)
            LukerDebugTrail.shared.append(category: "native", text: "runtime refresh done")
            NSLog("[LukerRuntime] Runtime assets prepared at %@", runtimeRoot.path)
        } else {
            // Verify/heal top-level symlinks in < 1 ms in case the app bundle
            // container path changed across a reinstall or debugger re-deploy.
            try linkBundledNodeProject(to: runtimeRoot, progress: nil)
        }

        try prepareServerPluginsAlias(runtimeRoot: runtimeRoot, pluginsRoot: serverPluginsRoot)
        LukerDebugTrail.shared.append(category: "native", text: "runtime prepare done")

        return RuntimePaths(
            runtimeRoot: runtimeRoot,
            dataRoot: dataRoot,
            serverPluginsRoot: serverPluginsRoot,
            globalExtensionsRoot: globalExtensionsRoot
        )
    }

    private func buildRuntimeMarker() -> String {
        let bundlePath = Bundle.main.resourceURL?
            .appendingPathComponent(Self.bundleProjectDirName, isDirectory: true).path ?? ""
        if let treeVersion = bundledRuntimeTreeVersion() {
            return "layout=\(Self.runtimeLayoutVersion);tree=\(treeVersion);bundlePath=\(bundlePath)"
        }
        let appBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "layout=\(Self.runtimeLayoutVersion);appBuild=\(appBuild);bundlePath=\(bundlePath)"
    }

    private func bundledRuntimeTreeVersion() -> String? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let file = resourceURL
            .appendingPathComponent(Self.bundleProjectDirName, isDirectory: true)
            .appendingPathComponent(Self.runtimeTreeVersionFileName)
        guard let raw = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private func isSymbolicLink(_ url: URL) -> Bool {
        (try? FileManager.default.destinationOfSymbolicLink(atPath: url.path)) != nil
    }

    /// Links the top-level entries of the bundled `nodejs-project` directory
    /// into the writable `luker-runtime` directory. Because Node runs with
    /// `--preserve-symlinks` and `--preserve-symlinks-main`, module resolution
    /// stays anchored inside `luker-runtime` (so `_server-plugins` and
    /// `whitelist.txt` resolve at the expected relative depth) while reading
    /// the ~580 MB server + `node_modules` tree directly from the app bundle
    /// without duplicating 32,000 files on disk.
    private func linkBundledNodeProject(
        to runtimeRoot: URL,
        progress: ((Int, Int) -> Void)?
    ) throws {
        guard let resourceURL = Bundle.main.resourceURL else {
            throw NSError(
                domain: "LukerRuntimeManager",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Bundle resource directory is unavailable"]
            )
        }
        let sourceRoot = resourceURL.appendingPathComponent(Self.bundleProjectDirName, isDirectory: true)
        let manager = FileManager.default
        var isDir: ObjCBool = false
        guard manager.fileExists(atPath: sourceRoot.path, isDirectory: &isDir), isDir.boolValue else {
            throw NSError(
                domain: "LukerRuntimeManager",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Bundled nodejs-project directory is missing"]
            )
        }
        let prebuiltRoot = sourceRoot.appendingPathComponent(Self.prebuiltBundlesDirName, isDirectory: true)
        let missingBundles = Self.requiredPrebuiltBundles.filter {
            !manager.fileExists(atPath: prebuiltRoot.appendingPathComponent($0).path)
        }
        if !missingBundles.isEmpty {
            throw NSError(
                domain: "LukerRuntimeManager",
                code: 5,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Missing prebuilt frontend bundles in nodejs-project/\(Self.prebuiltBundlesDirName): "
                        + missingBundles.sorted().joined(separator: ", "),
                ]
            )
        }

        let entries = try manager.contentsOfDirectory(
            at: sourceRoot,
            includingPropertiesForKeys: nil,
            options: []
        ).filter { $0.lastPathComponent != Self.runtimeTreeVersionFileName }

        let total = entries.count
        var linked = 0
        var skipped = 0
        progress?(0, total)

        var sourceNames = Set<String>()
        for (index, entry) in entries.enumerated() {
            let name = entry.lastPathComponent
            sourceNames.insert(name)
            let destination = runtimeRoot.appendingPathComponent(name)
            if let existingTarget = try? manager.destinationOfSymbolicLink(atPath: destination.path),
               existingTarget == entry.path,
               manager.fileExists(atPath: destination.path) {
                skipped += 1
            } else {
                if isSymbolicLink(destination) || manager.fileExists(atPath: destination.path) {
                    try manager.removeItem(at: destination)
                }
                try manager.createSymbolicLink(atPath: destination.path, withDestinationPath: entry.path)
                linked += 1
            }
            progress?(index + 1, total)
        }

        let existingRuntimeEntries = try manager.contentsOfDirectory(
            at: runtimeRoot,
            includingPropertiesForKeys: nil,
            options: []
        )
        for existing in existingRuntimeEntries {
            let name = existing.lastPathComponent
            if Self.runtimeRootLocalFileNames.contains(name) || sourceNames.contains(name) {
                continue
            }
            try manager.removeItem(at: existing)
        }

        if linked > 0 {
            LukerDebugTrail.shared.append(
                category: "native",
                text: "runtime link done entries=\(total) linked=\(linked) skipped=\(skipped)"
            )
        }
    }

    // MARK: - Migrations (mirrors the Android manager)

    private func migrateLegacyDataRoot(legacy: URL, target: URL) throws {
        let manager = FileManager.default
        guard !isSymbolicLink(legacy), manager.fileExists(atPath: legacy.path) else { return }
        guard !manager.fileExists(atPath: target.path) else { return }
        try? manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        do {
            try manager.moveItem(at: legacy, to: target)
            NSLog("[LukerRuntime] Migrated legacy data root to %@", target.path)
        } catch {
            try manager.copyItem(at: legacy, to: target)
            try manager.removeItem(at: legacy)
            NSLog("[LukerRuntime] Copied legacy data root to %@", target.path)
        }
    }

    private func migrateRuntimeConfigToDataRoot(runtimeRoot: URL, persistRoot: URL, dataRoot: URL) throws {
        let targetConfig = dataRoot.appendingPathComponent(Self.configFileName)
        guard !FileManager.default.fileExists(atPath: targetConfig.path) else { return }

        let runtimeConfig = runtimeRoot.appendingPathComponent(Self.configFileName)
        let persistedConfig = persistRoot.appendingPathComponent(Self.configFileName)
        let sourceConfig: URL
        if !isSymbolicLink(runtimeConfig), FileManager.default.fileExists(atPath: runtimeConfig.path) {
            sourceConfig = runtimeConfig
        } else if FileManager.default.fileExists(atPath: persistedConfig.path) {
            sourceConfig = persistedConfig
        } else {
            return
        }

        do {
            try? FileManager.default.createDirectory(
                at: targetConfig.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try FileManager.default.copyItem(at: sourceConfig, to: targetConfig)
            NSLog("[LukerRuntime] Migrated runtime config to data root: %@", targetConfig.path)
        } catch {
            NSLog("[LukerRuntime] Failed to migrate runtime config to data root: %@", String(describing: error))
        }
    }

    private func migrateLegacyRuntimePaths(
        runtimeRoot: URL,
        persistRoot: URL,
        serverPluginsRoot: URL,
        globalExtensionsRoot: URL
    ) throws {
        let legacyPluginsDir = runtimeRoot.appendingPathComponent(Self.serverPluginsDirName, isDirectory: true)
        if !isSymbolicLink(legacyPluginsDir) {
            try migrateDirectoryIfNeeded(
                from: legacyPluginsDir,
                to: serverPluginsRoot,
                label: "runtime server plugins"
            )
        }
        let legacyPublicDir = runtimeRoot.appendingPathComponent("public", isDirectory: true)
        if !isSymbolicLink(legacyPublicDir) {
            try migrateDirectoryIfNeeded(
                from: runtimeRoot.appendingPathComponent("public/scripts/extensions/third-party", isDirectory: true),
                to: globalExtensionsRoot,
                label: "runtime global extensions"
            )
        }
        try migrateDirectoryIfNeeded(
            from: persistRoot.appendingPathComponent(Self.serverPluginsDirName, isDirectory: true),
            to: serverPluginsRoot,
            label: "persisted server plugins"
        )
        try migrateDirectoryIfNeeded(
            from: persistRoot.appendingPathComponent("public/scripts/extensions/third-party", isDirectory: true),
            to: globalExtensionsRoot,
            label: "persisted global extensions"
        )
    }

    private func migrateDirectoryIfNeeded(from source: URL, to target: URL, label: String) throws {
        let manager = FileManager.default
        guard manager.fileExists(atPath: source.path) else { return }
        if manager.fileExists(atPath: target.path),
           let entries = try? manager.contentsOfDirectory(atPath: target.path), !entries.isEmpty {
            return
        }

        do {
            try? manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if manager.fileExists(atPath: target.path) {
                try manager.removeItem(at: target)
            }
            do {
                try manager.moveItem(at: source, to: target)
                NSLog("[LukerRuntime] Migrated %@ to %@", label, target.path)
            } catch {
                try manager.copyItem(at: source, to: target)
                try manager.removeItem(at: source)
                NSLog("[LukerRuntime] Copied %@ to %@", label, target.path)
            }
        } catch {
            NSLog("[LukerRuntime] Failed to migrate %@: %@", label, String(describing: error))
        }
    }

    private func persistRuntimeArtifacts(from runtimeRoot: URL, to persistRoot: URL) throws {
        let manager = FileManager.default
        for relativePath in Self.runtimePersistRelativePaths {
            let source = runtimeRoot.appendingPathComponent(relativePath)
            let target = persistRoot.appendingPathComponent(relativePath)
            do {
                guard manager.fileExists(atPath: source.path) else {
                    if manager.fileExists(atPath: target.path) {
                        try manager.removeItem(at: target)
                    }
                    continue
                }
                try? manager.createDirectory(
                    at: target.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                if manager.fileExists(atPath: target.path) {
                    try manager.removeItem(at: target)
                }
                try manager.copyItem(at: source, to: target)
            } catch {
                NSLog("[LukerRuntime] Failed to persist runtime artifact %@: %@", relativePath, String(describing: error))
            }
        }
    }

    private func restoreRuntimeArtifacts(from persistRoot: URL, to runtimeRoot: URL) throws {
        let manager = FileManager.default
        guard manager.fileExists(atPath: persistRoot.path) else { return }
        for relativePath in Self.runtimePersistRelativePaths {
            let source = persistRoot.appendingPathComponent(relativePath)
            let target = runtimeRoot.appendingPathComponent(relativePath)
            do {
                guard manager.fileExists(atPath: source.path) else { continue }
                try? manager.createDirectory(
                    at: target.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                if manager.fileExists(atPath: target.path) {
                    try manager.removeItem(at: target)
                }
                try manager.copyItem(at: source, to: target)
            } catch {
                NSLog("[LukerRuntime] Failed to restore runtime artifact %@: %@", relativePath, String(describing: error))
            }
        }
    }

    // MARK: - Port selection

    private func selectServerPort() throws -> Int {
        for offset in 0..<Self.maxPortProbeAttempts {
            let candidate = Self.defaultServerPort + offset
            if isPortAvailable(candidate) {
                return candidate
            }
        }
        throw NSError(
            domain: "LukerRuntimeManager",
            code: 4,
            userInfo: [
                NSLocalizedDescriptionKey: String(
                    format: NSLocalizedString("runtime_start_error_no_available_port", comment: ""),
                    Self.defaultServerPort,
                    Self.defaultServerPort + Self.maxPortProbeAttempts - 1
                ),
            ]
        )
    }

    private func isPortAvailable(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bindResult == 0
    }

    // MARK: - Readiness probe

    /// Mirrors isServerReady(): a POST /api/ping with an empty body; any HTTP
    /// status in 200...499 means the server is accepting connections.
    func isServerReady() -> Bool {
        var request = URLRequest(
            url: serverURL.appendingPathComponent("api/ping"),
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: Self.serverReadyProbeTimeout
        )
        request.httpMethod = "POST"
        request.httpBody = Data()

        let semaphore = DispatchSemaphore(value: 0)
        var statusCode: Int?
        var probeError: Error?
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let http = response as? HTTPURLResponse {
                statusCode = http.statusCode
            }
            probeError = error
            semaphore.signal()
        }.resume()
        let _ = semaphore.wait(timeout: .now() + Self.serverReadyProbeTimeout + 0.2)

        if let statusCode, (200...499).contains(statusCode) {
            return true
        }
        lock.lock()
        if started && !luker_node_is_running() {
            NSLog("[LukerRuntime] Node process is not running while server is unreachable. Resetting start state.")
            started = false
        }
        lock.unlock()
        let detail = probeError.map { String(describing: $0) } ?? (statusCode.map { "HTTP \($0)" } ?? "unknown")
        NSLog("[LukerRuntime] Server not ready: %@", detail)
        return false
    }

    // MARK: - Diagnostics

    func bootstrapLogFile() -> URL {
        runtimeRoot.appendingPathComponent(Self.bootstrapLogFileName)
    }

    /// Node-side diagnostic artifacts in the runtime root: `report.*.json`
    /// from --report-on-fatalerror and `*.heapsnapshot`, newest first.
    func listNodeDiagnosticArtifacts() -> [URL] {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(
            at: runtimeRoot,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return [] }
        return entries
            .filter { entry in
                guard entry.hasDirectoryPath == false else { return false }
                let name = entry.lastPathComponent
                return (name.hasPrefix("report.") && name.hasSuffix(".json")) || name.hasSuffix(".heapsnapshot")
            }
            .sorted { lhs, rhs in
                let lhsDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                let rhsDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                return lhsDate > rhsDate
            }
    }

    func collectDiagnostics(maxTailChars: Int = 6000) -> String {
        let manager = FileManager.default
        let logFile = bootstrapLogFile()
        var lines: [String] = []
        lines.append("started=\(started), nodeRunning=\(luker_node_is_running())")
        lines.append("runtimeDir=\(runtimeRoot.path)")
        lines.append("dataRoot=\(dataRoot.path)")
        lines.append("serverURL=\(serverURL.absoluteString)")
        lines.append("endpointMode=\(LukerEndpointConfig.shared.selection.usesLocalRuntime ? "local" : "custom")")
        lines.append(
            "exists(runtimeDir)=\(manager.fileExists(atPath: runtimeRoot.path))"
                + ", exists(dataRoot)=\(manager.fileExists(atPath: dataRoot.path))"
                + ", exists(bootstrap.js)=\(manager.fileExists(atPath: runtimeRoot.appendingPathComponent("bootstrap.js").path))"
                + ", exists(bootstrap.log)=\(manager.fileExists(atPath: logFile.path))"
        )
        let markerFile = runtimeRoot.appendingPathComponent(Self.runtimeMarkerName)
        let markerValue = (try? String(contentsOf: markerFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "<missing>"
        lines.append("runtimeMarker=\(markerValue)")
        lines.append("expectedMarker=\(buildRuntimeMarker())")
        if let capacity = try? runtimeRoot.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        ).volumeAvailableCapacityForImportantUsage {
            lines.append("freeDiskBytes=\(capacity)")
        }
        let artifacts = listNodeDiagnosticArtifacts()
        if !artifacts.isEmpty {
            lines.append("node diagnostic artifacts (newest first):")
            for artifact in artifacts {
                let size = (try? artifact.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                lines.append("  \(artifact.lastPathComponent) (\(size) bytes) @ \(artifact.path)")
            }
        }
        if let text = try? String(contentsOf: logFile, encoding: .utf8) {
            lines.append("bootstrap.log tail:")
            lines.append(text.count <= maxTailChars ? text : String(text.suffix(maxTailChars)))
        } else {
            lines.append("bootstrap.log tail: <missing>")
        }
        return lines.joined(separator: "\n")
    }
}
