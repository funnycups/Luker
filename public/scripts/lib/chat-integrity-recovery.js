// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure, import-free chat snapshot, payload-validation, and 409 conflict-recovery
 * primitives shared by `public/script.js` and `public/scripts/group-chats.js`.
 */

export function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function cloneJsonWire(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

export function getChatStateTargetKey(target) {
    if (!target || typeof target !== 'object') {
        return '';
    }
    if (target.is_group) {
        return `group:${String(target.id || '').trim()}`;
    }
    return `chat:${String(target.avatar_url || '').trim()}:${String(target.file_name || '').trim()}`;
}

export function getChatMetadataSnapshotKey(target) {
    if (!target || typeof target !== 'object') {
        return '';
    }
    if (target.is_group) {
        return `group:${String(target.id || '').trim()}`;
    }
    const avatar = String(target.avatar_url || '').trim();
    const file = String(target.file_name || '').trim();
    if (!avatar || !file) {
        return '';
    }
    return `char:${avatar}:${file}`;
}

/**
 * Validates and parses the JSON body returned by `/api/chats/get` or `/api/chats/group/get`.
 * Never treats truncated/malformed/corrupted payloads as an empty chat.
 *
 * @param {any} payload Parsed JSON body from the server.
 * @param {{ isGroup?: boolean, allowEmptyLegacySolo?: boolean, clone?: (v: any) => any }} [options]
 * @returns {{ ok: true, existsOnServer: boolean, metadata: object, messages: object[] } | { ok: false, corrupted: boolean, error: string }}
 */
export function parseServerChatPayload(payload, { isGroup = false, allowEmptyLegacySolo = false, clone = cloneJsonWire } = {}) {
    if (payload?.corrupted) {
        return { ok: false, corrupted: true, error: 'Server reported corrupted chat' };
    }

    if (isGroup) {
        if (!Array.isArray(payload)) {
            return { ok: false, corrupted: false, error: 'Expected a chat message array' };
        }
        if (payload.length === 0) {
            return { ok: true, existsOnServer: false, metadata: {}, messages: [] };
        }
        if (!isPlainObject(payload[0])) {
            return { ok: false, corrupted: false, error: 'Expected a chat message array' };
        }
        const hasHeader = Object.hasOwn(payload[0], 'chat_metadata');
        return {
            ok: true,
            existsOnServer: true,
            metadata: isPlainObject(payload[0]?.chat_metadata) ? clone(payload[0].chat_metadata) : {},
            messages: hasHeader ? payload.slice(1) : payload,
        };
    }

    if (isPlainObject(payload) && payload.new_chat === true) {
        return { ok: true, existsOnServer: false, metadata: {}, messages: [] };
    }

    if (allowEmptyLegacySolo && Array.isArray(payload) && payload.length === 0) {
        return { ok: true, existsOnServer: false, metadata: {}, messages: [] };
    }

    if (!Array.isArray(payload) || payload.length === 0 || !isPlainObject(payload[0])) {
        return { ok: false, corrupted: false, error: 'Unexpected server chat snapshot payload' };
    }

    const [header, ...rawMessages] = payload;
    const metadata = isPlainObject(header?.chat_metadata) ? clone(header.chat_metadata) : {};
    const messages = rawMessages
        .map((message) => clone(message))
        .filter((message) => message && typeof message === 'object');

    return {
        ok: true,
        existsOnServer: true,
        metadata,
        messages,
    };
}

/**
 * Validates a 200 OK chat-write response payload.
 *
 * @param {any} payload Parsed JSON body (or null if JSON parsing failed).
 * @param {{ requireAppended?: boolean }} [options]
 * @returns {{ valid: boolean, integrity: string, appended?: number }}
 */
export function validateChatWriteAckPayload(payload, { requireAppended = false } = {}) {
    if (payload?.ok !== true) {
        return { valid: false, integrity: '' };
    }
    if (requireAppended) {
        if (typeof payload.appended !== 'number' || !Number.isFinite(payload.appended)) {
            return { valid: false, integrity: '' };
        }
        const integrity = typeof payload.integrity === 'string' ? payload.integrity.trim() : '';
        return { valid: true, integrity, appended: payload.appended };
    }
    const integrity = typeof payload.integrity === 'string' ? payload.integrity.trim() : '';
    if (!integrity) {
        return { valid: false, integrity: '' };
    }
    return { valid: true, integrity };
}

function serverEqJsonString(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return undefined;
    }
}

function isServerEqJsonShape(a, b) {
    const sa = serverEqJsonString(a);
    const sb = serverEqJsonString(b);
    return sa !== undefined && sa === sb;
}

export function describeNestedDivergence(c, s, depth = 0) {
    if (depth >= 3) return null;
    if (!isPlainObject(c) || !isPlainObject(s)) return null;

    const cKeys = Object.keys(c);
    const sKeys = Object.keys(s);

    for (const k of cKeys) {
        if (!(k in s)) return `${k}(client-only)`;
    }
    for (const k of sKeys) {
        if (!(k in c)) return `${k}(server-only)`;
    }
    for (const k of cKeys) {
        if (!isServerEqJsonShape(c[k], s[k])) {
            const deeper = describeNestedDivergence(c[k], s[k], depth + 1);
            return deeper ? `${k}.${deeper}` : k;
        }
    }
    return null;
}

export function summarizeChatStateDivergence(clientMessages, serverMessages, maxDivergences = 2) {
    if (!Array.isArray(clientMessages) || !Array.isArray(serverMessages)) {
        return null;
    }
    const length = Math.max(clientMessages.length, serverMessages.length);
    const lines = [];
    const details = [];
    let extraCount = 0;
    for (let i = 0; i < length; i++) {
        const c = clientMessages[i];
        const s = serverMessages[i];
        if (isServerEqJsonShape(c, s)) continue;

        if (lines.length >= maxDivergences) {
            extraCount++;
            continue;
        }

        if (c === undefined || s === undefined) {
            lines.push(`/${i} ${c === undefined ? 'missing-on-client' : 'missing-on-server'}`);
            details.push({ index: i, client: c, server: s, kind: c === undefined ? 'missing-on-client' : 'missing-on-server' });
            continue;
        }
        if (!isPlainObject(c) || !isPlainObject(s)) {
            lines.push(`/${i} type-mismatch`);
            details.push({ index: i, client: c, server: s, kind: 'type-mismatch' });
            continue;
        }

        const cKeys = Object.keys(c);
        const sKeys = Object.keys(s);
        const onlyInClient = cKeys.filter((k) => !(k in s));
        const onlyInServer = sKeys.filter((k) => !(k in c));
        const sharedDiffered = cKeys.filter((k) => (k in s) && !isServerEqJsonShape(c[k], s[k]));
        const sameFields = onlyInClient.length === 0 && onlyInServer.length === 0 && sharedDiffered.length === 0;

        const mutatedDetailed = sharedDiffered.map((k) => {
            const nested = describeNestedDivergence(c[k], s[k]);
            return nested ? `${k}.${nested}` : k;
        });

        const parts = [];
        if (onlyInClient.length) parts.push(`client+[${onlyInClient.join(',')}]`);
        if (onlyInServer.length) parts.push(`server+[${onlyInServer.join(',')}]`);
        if (mutatedDetailed.length) parts.push(`mutated:[${mutatedDetailed.join(',')}]`);
        if (sameFields) parts.push('key-order-only');
        lines.push(`/${i} ${parts.join(' ')}`);
        details.push({ index: i, client: c, server: s, kind: parts.join(' ') });
    }

    if (lines.length === 0) {
        return null;
    }
    if (extraCount > 0) {
        lines.push(`+${extraCount} more position(s)`);
    }
    return { summary: lines.join('; '), details };
}

export function summarizeJsonPatchOperations(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return null;
    }
    const previewed = operations.slice(0, 3).map((op) => {
        if (!op || typeof op !== 'object') return '?';
        const opName = String(op.op || '?');
        const path = String(op.path || '');
        return `${opName} ${path}`.trim();
    });
    if (operations.length > 3) {
        previewed.push(`+${operations.length - 3} more`);
    }
    return previewed.join(', ');
}

export function summarizeAppendedMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }
    const first = messages[0];
    const role = first?.is_user ? 'user' : first?.is_system ? 'system' : 'assistant';
    return `append ${messages.length}× (first: ${role})`;
}

/**
 * Decides whether a 409 conflict should rotate integrity, arm force-overwrite,
 * or abort without force-overwriting a corrupted file.
 */
export function decideChatConflictRecovery({
    status,
    retryCount = 0,
    errorType = '',
    currentIntegrity = '',
    serverSnapshotCorrupted = false,
}) {
    if (status !== 409 || retryCount > 0) {
        return { resolution: 'none', shouldArmForceOverwrite: false, forceReason: null, nextIntegrity: '' };
    }
    const normalizedType = String(errorType || '').trim().toLowerCase();
    const trimmedIntegrity = typeof currentIntegrity === 'string' ? currentIntegrity.trim() : '';

    if (normalizedType === 'integrity') {
        if (trimmedIntegrity) {
            return {
                resolution: 'integrity',
                shouldArmForceOverwrite: false,
                forceReason: null,
                nextIntegrity: trimmedIntegrity,
            };
        }
        return {
            resolution: 'integrity',
            shouldArmForceOverwrite: !serverSnapshotCorrupted,
            forceReason: serverSnapshotCorrupted ? null : 'integrity-409-empty-current',
            nextIntegrity: '',
        };
    }

    return {
        resolution: 'snapshot',
        shouldArmForceOverwrite: !serverSnapshotCorrupted,
        forceReason: serverSnapshotCorrupted ? null : 'snapshot-409-recovery',
        nextIntegrity: '',
    };
}

/**
 * Pure per-target snapshot + integrity + force-overwrite state manager.
 *
 * @param {{
 *   getActiveTarget: () => object | null,
 *   getLiveChatMetadata: () => object | null,
 *   clone?: (value: any) => any,
 * }} deps
 */
export function createChatIntegrityStore({ getActiveTarget, getLiveChatMetadata, clone = cloneJsonWire }) {
    const metadataSnapshots = new Map();
    const messageSnapshots = new Map();
    const pendingForceOverwriteTargets = new Map();

    function isActiveTarget(target) {
        const active = getActiveTarget();
        if (!target || !active) return false;
        return getChatStateTargetKey(target) === getChatStateTargetKey(active);
    }

    function markTargetForForceOverwriteOnNextSave(target, reason) {
        const key = getChatStateTargetKey(target);
        if (!key) return;
        pendingForceOverwriteTargets.set(key, String(reason || 'unknown'));
    }

    function consumePendingForceOverwrite(target) {
        const key = getChatStateTargetKey(target);
        if (!key) return null;
        const reason = pendingForceOverwriteTargets.get(key);
        if (reason !== undefined) {
            pendingForceOverwriteTargets.delete(key);
            return reason;
        }
        return null;
    }

    function hasPendingForceOverwrite(target) {
        const key = getChatStateTargetKey(target);
        return Boolean(key && pendingForceOverwriteTargets.has(key));
    }

    function rememberMetadataSnapshot(target, metadata) {
        const key = getChatMetadataSnapshotKey(target);
        if (!key) return;
        metadataSnapshots.set(key, clone(isPlainObject(metadata) ? metadata : {}));
    }

    function getMetadataSnapshot(target) {
        const key = getChatMetadataSnapshotKey(target);
        if (!key) return null;
        const snapshot = metadataSnapshots.get(key);
        return isPlainObject(snapshot) ? clone(snapshot) : null;
    }

    function getRawMetadataSnapshot(target) {
        const key = getChatMetadataSnapshotKey(target);
        return key ? (metadataSnapshots.get(key) ?? null) : null;
    }

    function rememberMessageSnapshot(target, messages) {
        const key = getChatMetadataSnapshotKey(target);
        if (!key) return;
        if (!Array.isArray(messages)) {
            messageSnapshots.delete(key);
            return;
        }
        messageSnapshots.set(key, clone(messages));
    }

    function getMessageSnapshot(target) {
        const key = getChatMetadataSnapshotKey(target);
        if (!key) return null;
        const snapshot = messageSnapshots.get(key);
        return Array.isArray(snapshot) ? clone(snapshot) : null;
    }

    function getRawMessageSnapshot(target) {
        const key = getChatMetadataSnapshotKey(target);
        return key ? (messageSnapshots.get(key) ?? null) : null;
    }

    function invalidateWriteSnapshot(target) {
        const key = getChatMetadataSnapshotKey(target);
        if (!key) return;
        messageSnapshots.delete(key);
        metadataSnapshots.delete(key);
    }

    function syncCurrentChatIntegrityFromMetadata(metadata = null) {
        const liveMetadata = getLiveChatMetadata();
        if (!liveMetadata || typeof liveMetadata !== 'object') {
            return;
        }
        const currentIntegrity = typeof liveMetadata.integrity === 'string'
            ? liveMetadata.integrity.trim()
            : '';
        if (!currentIntegrity) {
            return;
        }
        const nextIntegrity = typeof metadata?.integrity === 'string'
            ? metadata.integrity.trim()
            : '';
        if (nextIntegrity) {
            liveMetadata.integrity = nextIntegrity;
        }
    }

    function applyIntegrityFromWritePayloadToTarget(payload, target = null, metadata = null) {
        const nextIntegrity = typeof payload?.integrity === 'string' ? payload.integrity.trim() : '';
        if (!nextIntegrity) {
            return;
        }
        if (metadata && typeof metadata === 'object') {
            metadata.integrity = nextIntegrity;
        }
        if (target?.is_group) {
            const snapshot = getMetadataSnapshot(target);
            if (snapshot) {
                rememberMetadataSnapshot(target, { ...snapshot, integrity: nextIntegrity });
            }
        }
        if (isActiveTarget(target)) {
            syncCurrentChatIntegrityFromMetadata({ integrity: nextIntegrity });
        }
    }

    function refreshSnapshotIntegrityFromActiveLive(target, metadata) {
        if (!isPlainObject(metadata)) {
            return;
        }
        if (target?.is_group) {
            const acknowledgedIntegrity = getMetadataSnapshot(target)?.integrity;
            if (acknowledgedIntegrity) {
                metadata.integrity = acknowledgedIntegrity;
                return;
            }
        }
        if (!isActiveTarget(target)) {
            return;
        }
        const liveMetadata = getLiveChatMetadata();
        if (!liveMetadata || typeof liveMetadata !== 'object') {
            return;
        }
        const liveIntegrity = typeof liveMetadata.integrity === 'string'
            ? liveMetadata.integrity.trim()
            : '';
        if (!liveIntegrity) {
            return;
        }
        metadata.integrity = liveIntegrity;
    }

    function applyServerChatSnapshot(snapshot, metadataToSync = null) {
        if (!snapshot) {
            return null;
        }
        if (snapshot.existsOnServer === false) {
            invalidateWriteSnapshot(snapshot.target);
            return snapshot;
        }
        rememberMetadataSnapshot(snapshot.target, snapshot.metadata);
        rememberMessageSnapshot(snapshot.target, snapshot.messages);

        if (metadataToSync && typeof metadataToSync === 'object') {
            const nextIntegrity = typeof snapshot.metadata?.integrity === 'string'
                ? snapshot.metadata.integrity.trim()
                : '';
            if (nextIntegrity) {
                metadataToSync.integrity = nextIntegrity;
            }
        }

        if (isActiveTarget(snapshot.target)) {
            syncCurrentChatIntegrityFromMetadata(snapshot.metadata);
        }
        return snapshot;
    }

    /**
     * Evaluates a conflict-diagnostic snapshot read result without issuing duplicate
     * server reads, returning the next action for the caller.
     */
    function evaluateConflictSnapshotReuse(target, conflictSnapshot, { allowNonForcedReadFailure = false } = {}) {
        if (!conflictSnapshot?.attempted) {
            return { action: 'fetch' };
        }
        if (conflictSnapshot.error) {
            if (!allowNonForcedReadFailure || conflictSnapshot.corrupted || hasPendingForceOverwrite(target)) {
                return { action: 'rethrow', error: conflictSnapshot.error };
            }
            return { action: 'skip' };
        }
        return { action: 'apply', snapshot: conflictSnapshot.snapshot };
    }

    return {
        isActiveTarget,
        markTargetForForceOverwriteOnNextSave,
        consumePendingForceOverwrite,
        hasPendingForceOverwrite,
        rememberMetadataSnapshot,
        getMetadataSnapshot,
        getRawMetadataSnapshot,
        rememberMessageSnapshot,
        getMessageSnapshot,
        getRawMessageSnapshot,
        invalidateWriteSnapshot,
        syncCurrentChatIntegrityFromMetadata,
        applyIntegrityFromWritePayloadToTarget,
        refreshSnapshotIntegrityFromActiveLive,
        applyServerChatSnapshot,
        evaluateConflictSnapshotReuse,
    };
}
