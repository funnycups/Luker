// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';
import {
    createChatIntegrityStore,
    decideChatConflictRecovery,
    getChatMetadataSnapshotKey,
    getChatStateTargetKey,
    isPlainObject,
    parseServerChatPayload,
    summarizeAppendedMessages,
    summarizeChatStateDivergence,
    summarizeJsonPatchOperations,
    validateChatWriteAckPayload,
} from '../public/scripts/lib/chat-integrity-recovery.js';

describe('chat integrity snapshot & conflict recovery primitives', () => {
    const soloTarget = { is_group: false, avatar_url: 'Alice.png', file_name: 'chat-1', char_name: 'Alice' };
    const branchTarget = { is_group: false, avatar_url: 'Alice.png', file_name: 'branch-2', char_name: 'Alice' };
    const groupTarget = { is_group: true, id: 'gchat-1' };

    test('parseServerChatPayload distinguishes valid chats, explicit new chats, corrupted payloads, and malformed responses', () => {
        // Solo valid chat
        const solo = parseServerChatPayload([
            { user_name: 'U', character_name: 'Alice', chat_metadata: { integrity: 'tok-1', note: 'keep' } },
            { name: 'Alice', is_user: false, mes: 'hello' },
        ], { isGroup: false });
        expect(solo).toEqual({
            ok: true,
            existsOnServer: true,
            metadata: { integrity: 'tok-1', note: 'keep' },
            messages: [{ name: 'Alice', is_user: false, mes: 'hello' }],
        });

        // Solo explicit { new_chat: true } -> existsOnServer: false
        expect(parseServerChatPayload({ new_chat: true }, { isGroup: false })).toEqual({
            ok: true,
            existsOnServer: false,
            metadata: {},
            messages: [],
        });

        // Solo rejects empty array [] (unless allowEmptyLegacySolo), { error: true }, [null], null
        for (const bad of [[], { error: true }, [null], ['bad'], [[]], null, undefined]) {
            const parsed = parseServerChatPayload(bad, { isGroup: false });
            expect(parsed.ok).toBe(false);
            expect(parsed.corrupted).toBe(false);
        }

        // Corrupted marker on both solo and group
        for (const isGroup of [false, true]) {
            const corrupted = parseServerChatPayload({ corrupted: true }, { isGroup });
            expect(corrupted.ok).toBe(false);
            expect(corrupted.corrupted).toBe(true);
        }

        // Group [] means unpersisted new group chat; [null]/['bad']/[[]] rejected
        expect(parseServerChatPayload([], { isGroup: true })).toEqual({
            ok: true,
            existsOnServer: false,
            metadata: {},
            messages: [],
        });
        for (const badGroup of [[null], ['bad'], [[]], { error: true }]) {
            const parsed = parseServerChatPayload(badGroup, { isGroup: true });
            expect(parsed.ok).toBe(false);
        }
    });

    test('validateChatWriteAckPayload rejects truncated/null or missing-integrity 200 acknowledgements', () => {
        expect(validateChatWriteAckPayload(null)).toEqual({ valid: false, integrity: '' });
        expect(validateChatWriteAckPayload({ ok: true })).toEqual({ valid: false, integrity: '' });
        expect(validateChatWriteAckPayload({ ok: true, integrity: '   ' })).toEqual({ valid: false, integrity: '' });
        expect(validateChatWriteAckPayload({ ok: true, integrity: 'tok-2' })).toEqual({ valid: true, integrity: 'tok-2' });

        // Append ack requires finite numeric `appended`
        expect(validateChatWriteAckPayload({ ok: true, integrity: 'tok-2' }, { requireAppended: true })).toEqual({ valid: false, integrity: '' });
        expect(validateChatWriteAckPayload({ ok: true, appended: NaN, integrity: 'tok-2' }, { requireAppended: true })).toEqual({ valid: false, integrity: '' });
        expect(validateChatWriteAckPayload({ ok: true, appended: 0, integrity: 'tok-2' }, { requireAppended: true })).toEqual({
            valid: true,
            integrity: 'tok-2',
            appended: 0,
        });
    });

    test('half-open integrity protection: late writes cannot re-authorize empty live integrity and empty live integrity never strips queued token', () => {
        const liveMetadata = {};
        const store = createChatIntegrityStore({
            getActiveTarget: () => soloTarget,
            getLiveChatMetadata: () => liveMetadata,
        });

        // Late write acknowledgement must NOT re-authorize half-open chat
        store.applyIntegrityFromWritePayloadToTarget({ integrity: 'tok-late' }, soloTarget, null);
        expect(liveMetadata.integrity).toBeUndefined();

        // Queued write's captured token must NOT be stripped when live integrity is empty
        const queuedMeta = { integrity: 'tok-captured', note: 'queued' };
        store.refreshSnapshotIntegrityFromActiveLive(soloTarget, queuedMeta);
        expect(queuedMeta.integrity).toBe('tok-captured');
    });

    test('applyServerChatSnapshot preserves live integrity on existsOnServer:false and legacy no-integrity chats, and isolates branch targets', () => {
        const liveMetadata = { integrity: 'active-tok' };
        const store = createChatIntegrityStore({
            getActiveTarget: () => soloTarget,
            getLiveChatMetadata: () => liveMetadata,
        });

        const origMsgs = [{ name: 'Alice', is_user: false, mes: 'local' }];
        store.rememberMessageSnapshot(soloTarget, origMsgs);

        // existsOnServer === false drops stale cache without deleting live integrity
        store.applyServerChatSnapshot({
            target: soloTarget,
            existsOnServer: false,
            metadata: {},
            messages: [],
        });
        expect(liveMetadata.integrity).toBe('active-tok');
        expect(store.getMessageSnapshot(soloTarget)).toBeNull();

        // Legacy server snapshot without integrity keeps live integrity intact
        store.applyServerChatSnapshot({
            target: soloTarget,
            existsOnServer: true,
            metadata: {},
            messages: origMsgs,
        });
        expect(liveMetadata.integrity).toBe('active-tok');
        expect(store.getMessageSnapshot(soloTarget)).toEqual(origMsgs);

        // Branch target snapshot syncs branch metadata without clobbering active chat integrity
        const branchMeta = { integrity: 'branch-tok-1' };
        store.applyServerChatSnapshot({
            target: branchTarget,
            existsOnServer: true,
            metadata: { integrity: 'branch-tok-2' },
            messages: origMsgs,
        }, branchMeta);
        expect(branchMeta.integrity).toBe('branch-tok-2');
        expect(liveMetadata.integrity).toBe('active-tok');
    });

    test('group integrity tokens stay target-owned across cached snapshots and non-active switches', () => {
        let activeTarget = groupTarget;
        const liveMetadata = { integrity: 'gtok-1' };
        const store = createChatIntegrityStore({
            getActiveTarget: () => activeTarget,
            getLiveChatMetadata: () => liveMetadata,
        });

        store.rememberMetadataSnapshot(groupTarget, { integrity: 'gtok-1', note: 'v1' });
        const metaCopy = { integrity: 'gtok-1', note: 'v1' };
        store.applyIntegrityFromWritePayloadToTarget({ integrity: 'gtok-2' }, groupTarget, metaCopy);
        expect(metaCopy.integrity).toBe('gtok-2');
        expect(liveMetadata.integrity).toBe('gtok-2');
        expect(store.getMetadataSnapshot(groupTarget).integrity).toBe('gtok-2');

        // After switching away to soloTarget, queued group write still picks up group snapshot token
        activeTarget = soloTarget;
        liveMetadata.integrity = 'solo-tok';
        const queuedGroupMeta = { integrity: 'gtok-1' };
        store.refreshSnapshotIntegrityFromActiveLive(groupTarget, queuedGroupMeta);
        expect(queuedGroupMeta.integrity).toBe('gtok-2');
    });

    test('decideChatConflictRecovery and evaluateConflictSnapshotReuse enforce single-fetch reuse and block force overwrite on corrupted chats', () => {
        // Non-409 or exhausted retry -> none
        expect(decideChatConflictRecovery({ status: 500, retryCount: 0, errorType: 'integrity' }).resolution).toBe('none');
        expect(decideChatConflictRecovery({ status: 409, retryCount: 1, errorType: 'integrity', currentIntegrity: 'tok-2' }).resolution).toBe('none');

        // 409 integrity with current_integrity -> rotates without force overwrite
        expect(decideChatConflictRecovery({
            status: 409,
            retryCount: 0,
            errorType: 'integrity',
            currentIntegrity: 'tok-2',
            serverSnapshotCorrupted: false,
        })).toEqual({
            resolution: 'integrity',
            shouldArmForceOverwrite: false,
            forceReason: null,
            nextIntegrity: 'tok-2',
        });

        // 409 integrity with empty current_integrity -> arms force ONLY if not corrupted
        expect(decideChatConflictRecovery({
            status: 409,
            retryCount: 0,
            errorType: 'integrity',
            currentIntegrity: '',
            serverSnapshotCorrupted: false,
        })).toEqual({
            resolution: 'integrity',
            shouldArmForceOverwrite: true,
            forceReason: 'integrity-409-empty-current',
            nextIntegrity: '',
        });
        expect(decideChatConflictRecovery({
            status: 409,
            retryCount: 0,
            errorType: 'integrity',
            currentIntegrity: '',
            serverSnapshotCorrupted: true,
        }).shouldArmForceOverwrite).toBe(false);

        // 409 snapshot -> arms force ONLY if not corrupted
        expect(decideChatConflictRecovery({
            status: 409,
            retryCount: 0,
            errorType: 'Chat patch conflict.',
            serverSnapshotCorrupted: false,
        })).toEqual({
            resolution: 'snapshot',
            shouldArmForceOverwrite: true,
            forceReason: 'snapshot-409-recovery',
            nextIntegrity: '',
        });
        expect(decideChatConflictRecovery({
            status: 409,
            retryCount: 0,
            errorType: 'Chat patch conflict.',
            serverSnapshotCorrupted: true,
        }).shouldArmForceOverwrite).toBe(false);

        // evaluateConflictSnapshotReuse avoids duplicate fetch and guards forced/corrupted read failures
        const store = createChatIntegrityStore({
            getActiveTarget: () => soloTarget,
            getLiveChatMetadata: () => ({ integrity: 'tok-1' }),
        });
        expect(store.evaluateConflictSnapshotReuse(soloTarget, { attempted: false })).toEqual({ action: 'fetch' });

        const snap = { target: soloTarget, existsOnServer: true, metadata: { integrity: 'tok-2' }, messages: [] };
        expect(store.evaluateConflictSnapshotReuse(soloTarget, { attempted: true, snapshot: snap, error: null })).toEqual({
            action: 'apply',
            snapshot: snap,
        });

        const readErr = new SyntaxError('Unexpected end of JSON input');
        // Non-forced integrity 409 with allowNonForcedReadFailure skips safely so fallback non-forced save runs
        expect(store.evaluateConflictSnapshotReuse(soloTarget, { attempted: true, error: readErr, corrupted: false }, { allowNonForcedReadFailure: true })).toEqual({
            action: 'skip',
        });
        // Corrupted error ALWAYS rethrows even when allowNonForcedReadFailure is true
        expect(store.evaluateConflictSnapshotReuse(soloTarget, { attempted: true, error: readErr, corrupted: true }, { allowNonForcedReadFailure: true })).toEqual({
            action: 'rethrow',
            error: readErr,
        });
        // Armed pending force overwrite ALWAYS rethrows on read failure so recovery never blindly force-overwrites
        store.markTargetForForceOverwriteOnNextSave(soloTarget, 'integrity-409-empty-current');
        expect(store.evaluateConflictSnapshotReuse(soloTarget, { attempted: true, error: readErr, corrupted: false }, { allowNonForcedReadFailure: true })).toEqual({
            action: 'rethrow',
            error: readErr,
        });
        expect(store.consumePendingForceOverwrite(soloTarget)).toBe('integrity-409-empty-current');
        expect(store.consumePendingForceOverwrite(soloTarget)).toBeNull();
    });

    test('divergence and operation summaries capture nested diffs and target key helpers isolate solo/group targets', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject([])).toBe(false);
        expect(getChatStateTargetKey(soloTarget)).toBe('chat:Alice.png:chat-1');
        expect(getChatStateTargetKey(groupTarget)).toBe('group:gchat-1');
        expect(getChatMetadataSnapshotKey(soloTarget)).toBe('char:Alice.png:chat-1');
        expect(getChatMetadataSnapshotKey(groupTarget)).toBe('group:gchat-1');

        const div = summarizeChatStateDivergence(
            [{ mes: 'a', extra: { gen: '1' } }, { mes: 'b' }],
            [{ mes: 'a', extra: { gen: '2' } }],
        );
        expect(div.summary).toContain('/0 mutated:[extra.gen]');
        expect(div.summary).toContain('/1 missing-on-server');
        expect(summarizeJsonPatchOperations([
            { op: 'replace', path: '/0' },
            { op: 'add', path: '/1' },
            { op: 'remove', path: '/2' },
            { op: 'replace', path: '/3' },
        ])).toBe('replace /0, add /1, remove /2, +1 more');
        expect(summarizeAppendedMessages([{ is_user: true, mes: 'hi' }, { is_user: false, mes: 'yo' }])).toBe('append 2× (first: user)');
    });
});
