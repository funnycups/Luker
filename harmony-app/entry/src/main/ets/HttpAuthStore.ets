// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { HttpAuthCredentials, httpAuthKey } from './HttpAuth';

const TAG: string = 'luker.httpauth';
const DOMAIN: number = 0xE1EC;
const STORE_NAME: string = 'luker_http_auth';

/**
 * Persists HTTP authentication credentials per endpoint and realm. A rejected
 * credential is removed before the dialog reappears, so the stored pair is
 * only reused while the server accepts it.
 */
export class HttpAuthStore {
  private static store: preferences.Preferences | null = null;

  static attach(context: common.Context): void {
    if (HttpAuthStore.store !== null) {
      return;
    }
    try {
      HttpAuthStore.store = preferences.getPreferencesSync(context, { name: STORE_NAME });
    } catch (e) {
      HttpAuthStore.store = null;
      hilog.error(DOMAIN, TAG, 'getPreferencesSync failed: %{public}s', JSON.stringify(e));
    }
  }

  static load(host: string, realm: string): HttpAuthCredentials | null {
    const store: preferences.Preferences | null = HttpAuthStore.store;
    if (store === null) {
      return null;
    }
    const key: string = httpAuthKey(host, realm);
    try {
      const username: string = String(store.getSync(key + '.username', ''));
      const password: string = String(store.getSync(key + '.password', ''));
      if (username.length === 0) {
        return null;
      }
      return { username: username, password: password };
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'read credentials failed: %{public}s', JSON.stringify(e));
      return null;
    }
  }

  static save(host: string, realm: string, credentials: HttpAuthCredentials): void {
    const store: preferences.Preferences | null = HttpAuthStore.store;
    if (store === null) {
      return;
    }
    const key: string = httpAuthKey(host, realm);
    try {
      store.putSync(key + '.username', credentials.username);
      store.putSync(key + '.password', credentials.password);
      store.flushSync();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'save credentials failed: %{public}s', JSON.stringify(e));
    }
  }

  static clear(host: string, realm: string): void {
    const store: preferences.Preferences | null = HttpAuthStore.store;
    if (store === null) {
      return;
    }
    const key: string = httpAuthKey(host, realm);
    try {
      if (store.hasSync(key + '.username')) {
        store.deleteSync(key + '.username');
      }
      if (store.hasSync(key + '.password')) {
        store.deleteSync(key + '.password');
      }
      store.flushSync();
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'clear credentials failed: %{public}s', JSON.stringify(e));
    }
  }
}
