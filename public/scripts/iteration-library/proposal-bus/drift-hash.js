// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Fingerprint helpers for the ProposalBus drift-detection contract.
 *
 * Each KindHandler.fingerprint(snapshot) returns a string that must match
 * exactly when a proposal's recorded before-state still represents what's
 * on disk at commit time. Mismatch -> bus parks the entry in status='conflict'
 * and the user sees a git-style "external edit detected" card.
 *
 * sha256OfString / sha256OfJson run through SubtleCrypto (browser-native;
 * jest jsdom env provides it via Node 20+ globalThis.crypto). They are
 * async — KindHandler.fingerprint is therefore async, and bus.propose
 * awaits it at call time.
 *
 * canonicalJson is a deterministic JSON stringifier — keys sorted deeply,
 * undefined values dropped, arrays preserved. Bus uses it for
 * sha256OfJson so two semantically equal objects compare equal regardless
 * of their key iteration order at proposal vs read-current time.
 */

export function canonicalJson(value) {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        const parts = value.map((v) => {
            const s = canonicalJson(v);
            return s === undefined ? 'null' : s;
        });
        return `[${parts.join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const k of keys) {
        const s = canonicalJson(value[k]);
        if (s === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
}

export async function sha256OfString(s) {
    const enc = new TextEncoder().encode(String(s ?? ''));
    const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

export async function sha256OfJson(value) {
    const json = canonicalJson(value);
    return sha256OfString(json === undefined ? 'null' : json);
}
