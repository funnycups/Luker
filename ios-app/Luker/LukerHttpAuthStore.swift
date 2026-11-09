// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import Foundation

struct LukerHttpAuthCredentials: Equatable {
    let username: String
    let password: String
}

/// Persists HTTP authentication credentials per endpoint and realm, mirroring
/// `LukerHttpAuthStore` in the Android shell. The store is what lets a second
/// launch load the endpoint without asking again; a rejected credential is
/// removed by the caller before the dialog reappears.
final class LukerHttpAuthStore {
    static let shared = LukerHttpAuthStore()

    private static let keyPrefix = "luker_http_auth"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func storageKey(host: String, port: Int, realm: String) -> String {
        let raw = "\(host.trimmingCharacters(in: .whitespaces).lowercased())\n\(port)\n\(realm.trimmingCharacters(in: .whitespaces))"
        let encoded = Data(raw.utf8).base64EncodedString()
        return "\(keyPrefix).\(encoded)"
    }

    func load(host: String, port: Int, realm: String) -> LukerHttpAuthCredentials? {
        let key = Self.storageKey(host: host, port: port, realm: realm)
        guard let username = defaults.string(forKey: key + ".username"),
              let password = defaults.string(forKey: key + ".password") else {
            return nil
        }
        return LukerHttpAuthCredentials(username: username, password: password)
    }

    func save(host: String, port: Int, realm: String, credentials: LukerHttpAuthCredentials) {
        let key = Self.storageKey(host: host, port: port, realm: realm)
        defaults.set(credentials.username, forKey: key + ".username")
        defaults.set(credentials.password, forKey: key + ".password")
    }

    func clear(host: String, port: Int, realm: String) {
        let key = Self.storageKey(host: host, port: port, realm: realm)
        defaults.removeObject(forKey: key + ".username")
        defaults.removeObject(forKey: key + ".password")
    }
}
