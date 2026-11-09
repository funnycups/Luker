// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation

struct LukerBootWatchdogResult {
    let tripped: Bool
    let sentinelPath: String?
    let failedStreak: Int
}

/// A previous launch that never reached server-ready. The next launch turns
/// this into a report even when the crash left no signal or exception file
/// (for example, a system kill or a fault before the handlers installed).
struct LukerPendingBootFailure {
    let startedAt: Date
    let failedStreak: Int
    let lastFailedAt: Date?
}

/// Detects "the previous launch never reached server-ready", typically because
/// Node died before the WebView could connect. On detection it drops the same
/// `.luker-safe-mode.json` sentinel Android writes; `src/safe-mode.js` consumes
/// it before the server finishes starting and disables third-party extensions.
final class LukerBootWatchdog {
    static let shared = LukerBootWatchdog()

    private static let inProgressKey = "luker_boot_watchdog_in_progress_at"
    private static let failedAtKey = "luker_boot_watchdog_last_failed_at"
    private static let streakKey = "luker_boot_watchdog_failed_streak"
    private static let sentinelName = ".luker-safe-mode.json"

    /// A cold boot slower than this window is treated as a real failure rather
    /// than a user swipe from the app switcher. Covers asset extraction plus
    /// Node warmup on a low-end device.
    private static let probableUserDismissWindow: TimeInterval = 90

    private let defaults = UserDefaults.standard

    private init() {}

    func detectAndArm(dataRoot: URL) -> LukerBootWatchdogResult {
        let now = Date()
        let previousMillis = defaults.double(forKey: Self.inProgressKey)
        let previous = previousMillis > 0 ? Date(timeIntervalSince1970: previousMillis) : nil
        let previousStreak = defaults.integer(forKey: Self.streakKey)
        let sinceLastBoot = previous.map { now.timeIntervalSince($0) } ?? .greatestFiniteMagnitude

        let tripped = previous != nil && sinceLastBoot >= 0 && sinceLastBoot <= Self.probableUserDismissWindow
        var sentinelPath: String?
        var nextStreak = previousStreak

        if tripped, let previous {
            nextStreak = previousStreak + 1
            sentinelPath = writeSentinel(
                dataRoot: dataRoot,
                failedStreak: nextStreak,
                sinceLastBootMilliseconds: Int(sinceLastBoot * 1000)
            )
            defaults.set(previous.timeIntervalSince1970, forKey: Self.failedAtKey)
            defaults.set(nextStreak, forKey: Self.streakKey)
            LukerDebugTrail.shared.append(
                category: "native",
                text: "boot watchdog tripped streak=\(nextStreak) sinceLastBoot=\(Int(sinceLastBoot))s"
            )
        } else if previous != nil {
            nextStreak = 0
            defaults.set(0, forKey: Self.streakKey)
        }

        defaults.set(now.timeIntervalSince1970, forKey: Self.inProgressKey)
        return LukerBootWatchdogResult(tripped: tripped, sentinelPath: sentinelPath, failedStreak: nextStreak)
    }

    /// The previous run's boot marker. `markBootSucceeded` removes it once the
    /// server answers, so a surviving marker means the previous run ended
    /// before the interface was usable.
    func pendingBootFailure() -> LukerPendingBootFailure? {
        let millis = defaults.double(forKey: Self.inProgressKey)
        guard millis > 0 else { return nil }
        let failedMillis = defaults.double(forKey: Self.failedAtKey)
        return LukerPendingBootFailure(
            startedAt: Date(timeIntervalSince1970: millis),
            failedStreak: defaults.integer(forKey: Self.streakKey),
            lastFailedAt: failedMillis > 0 ? Date(timeIntervalSince1970: failedMillis) : nil
        )
    }

    func markBootSucceeded() {
        defaults.removeObject(forKey: Self.inProgressKey)
        defaults.set(0, forKey: Self.streakKey)
    }

    private func writeSentinel(dataRoot: URL, failedStreak: Int, sinceLastBootMilliseconds: Int) -> String? {
        let manager = FileManager.default
        do {
            try manager.createDirectory(at: dataRoot, withIntermediateDirectories: true)
            let sentinel = dataRoot.appendingPathComponent(Self.sentinelName)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let body = """
            {"reason":"boot-watchdog","writtenAt":"\(formatter.string(from: Date()))","sinceLastBootMs":\(sinceLastBootMilliseconds),"failedStreak":\(failedStreak)}
            """
            try body.write(to: sentinel, atomically: true, encoding: .utf8)
            return sentinel.path
        } catch {
            NSLog("[LukerBootWatchdog] Failed to write the safe-mode sentinel: %@", String(describing: error))
            LukerDebugTrail.shared.append(category: "native", text: "safe-mode sentinel write failed: \(error)")
            return nil
        }
    }
}
