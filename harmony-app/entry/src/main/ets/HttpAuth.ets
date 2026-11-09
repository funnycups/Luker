// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

export interface HttpAuthCredentials {
  username: string;
  password: string;
}

export interface HttpAuthDecision {
  useStored: boolean;
  clearStored: boolean;
  stored: HttpAuthCredentials | null;
  prefill: HttpAuthCredentials | null;
}

export function sameHttpAuthCredentials(
  a: HttpAuthCredentials | null,
  b: HttpAuthCredentials | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.username === b.username && a.password === b.password;
}

export function httpAuthKey(host: string, realm: string): string {
  return host.trim().toLowerCase() + '|' + realm.trim();
}

/**
 * Decides how to answer an authentication challenge. Stored credentials are
 * reused until the server rejects them: a rejection clears the store and opens
 * the dialog prefilled with the rejected pair. Mirrors the Android and iOS
 * shells.
 */
export function decideHttpAuth(
  stored: HttpAuthCredentials | null,
  lastAttempted: HttpAuthCredentials | null,
): HttpAuthDecision {
  if (stored !== null && !sameHttpAuthCredentials(stored, lastAttempted)) {
    return {
      useStored: true,
      clearStored: false,
      stored: stored,
      prefill: null,
    };
  }
  return {
    useStored: false,
    clearStored: stored !== null && sameHttpAuthCredentials(stored, lastAttempted),
    stored: null,
    prefill: lastAttempted ?? stored,
  };
}
