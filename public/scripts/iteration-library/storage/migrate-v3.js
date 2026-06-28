import { encodeInverse } from './patch-codec.js';
import { STATE_ERROR_REASONS } from '../../state-errors.js';

export class MigrationFailedError extends Error {
    constructor({ sessionId, turnId, reason: legacyReason, reasonCode = STATE_ERROR_REASONS.REPLAY_BROKEN, hint = null }) {
        const computedHint = hint != null ? String(hint) : String(legacyReason || 'migration failed');
        super(`migration failed for session=${sessionId} turn=${turnId}: ${computedHint}`);
        this.name = 'MigrationFailedError';
        this.sessionId = sessionId;
        this.turnId = turnId;
        this.reason = reasonCode;
        this.hint = String(computedHint).slice(0, 120);
        this.legacyReason = legacyReason;
    }
}

function parseLegacyTarget(legacy) {
    if (!legacy) return null;
    if (typeof legacy === 'object') return legacy;
    if (typeof legacy !== 'string') return null;
    if (legacy === 'character') return { type: 'character' };
    if (legacy === 'preset') return { type: 'preset' };
    if (legacy === 'schema') return { type: 'schema' };
    const colon = legacy.indexOf(':');
    if (colon < 0) return { type: legacy };
    const type = legacy.slice(0, colon);
    const name = legacy.slice(colon + 1);
    if (type === 'lorebook') return { type, name };
    if (type === 'profile') return { type, mode: name };
    return { type, name };
}

function migrateEdit(edit, sessionId, turnId, defaultTargetForKind, kind = null) {
    if (!edit || typeof edit !== 'object') {
        throw new MigrationFailedError({ sessionId, turnId, reason: 'edit is not an object' });
    }
    // Idempotent: an edit already in v3 shape ({target: {...}, inverse: [...]}) is returned as-is.
    if (edit.target && typeof edit.target === 'object' && Array.isArray(edit.inverse)) {
        return edit;
    }
    if (!('newValue' in edit)) {
        throw new MigrationFailedError({ sessionId, turnId, reason: 'edit missing newValue' });
    }
    if (!('oldValue' in edit)) {
        throw new MigrationFailedError({ sessionId, turnId, reason: 'edit missing oldValue' });
    }
    const target = parseLegacyTarget(edit.target) || defaultTargetForKind(kind);
    if (!target || !target.type) {
        throw new MigrationFailedError({ sessionId, turnId, reason: 'cannot determine target' });
    }
    return {
        target,
        inverse: encodeInverse(edit.oldValue, edit.newValue),
    };
}

function migrateBusEntry(entry, sessionId, defaultTargetForKind) {
    if (!entry || typeof entry !== 'object') {
        throw new MigrationFailedError({ sessionId, turnId: entry?.id, reason: 'bus entry is not an object' });
    }
    const op = entry.op;
    const snapshot = entry.snapshot;
    if (!op || !('newValue' in op) || snapshot === undefined) {
        throw new MigrationFailedError({ sessionId, turnId: entry.id, reason: 'bus entry missing op.newValue or snapshot' });
    }
    let target;
    if (entry.kind === 'lorebook-write' || entry.kind === 'cea-lorebook-edits') {
        const name = op.args?.book || op.bookName;
        if (!name) throw new MigrationFailedError({ sessionId, turnId: entry.id, reason: 'lorebook entry missing book name' });
        target = { type: 'lorebook', name };
    } else if (entry.kind === 'skill-author') {
        // skill-author proposes carry the skill name+path in `meta` (the
        // durable mirror — `target._op` is runtime-only and stripped at
        // serialize time). Falling back to defaultTargetForKind would
        // mis-route to `preset` (CPA) or `profile` (orch) and lose the
        // skill-registry handler entirely. Recover from meta first, then
        // the legacy serialized target as a secondary source.
        const name = entry.meta?.skillName || entry.target?.name;
        const path = entry.meta?.path ?? entry.target?.path ?? null;
        if (!name) {
            throw new MigrationFailedError({ sessionId, turnId: entry.id, reason: 'skill-author entry missing skill name' });
        }
        target = { type: 'skill-registry', name, path };
    } else {
        target = defaultTargetForKind(entry.kind);
    }
    if (!target) throw new MigrationFailedError({ sessionId, turnId: entry.id, reason: 'cannot determine bus target' });
    return {
        id: entry.id,
        kind: entry.kind,
        target,
        inverse: encodeInverse(snapshot, op.newValue),
        sourceCallId: entry.sourceCallId ?? null,
        status: entry.status,
        meta: entry.meta ?? null,
        createdAt: entry.createdAt ?? 0,
        decidedAt: entry.decidedAt ?? null,
        committedAt: entry.committedAt ?? null,
        rolledBackAt: entry.rolledBackAt ?? null,
        conflictError: null,
    };
}

export function migrateToV3(oldSession, { defaultTargetForKind }) {
    if (!oldSession || typeof oldSession !== 'object') {
        throw new MigrationFailedError({ sessionId: null, turnId: null, reason: 'session is not an object' });
    }
    if (oldSession.version === 3) return oldSession;
    const sessionId = oldSession.id || null;
    const messages = Array.isArray(oldSession.messages) ? oldSession.messages : [];
    const newMessages = messages.map((m) => {
        if (!Array.isArray(m.edits) || m.edits.length === 0) return m;
        return {
            ...m,
            edits: m.edits.map((e) => migrateEdit(e, sessionId, m.id, defaultTargetForKind)),
        };
    });
    // Production adapters serialize the bus into `proposalBus`; the brief's
    // earlier draft called it `busState`. Migrate whichever key the legacy
    // session carries and emit back under the same key.
    const out = { ...oldSession, version: 3, messages: newMessages };
    for (const key of ['busState', 'proposalBus']) {
        const current = oldSession[key];
        if (current && Array.isArray(current.entries)) {
            out[key] = {
                version: 3,
                entries: current.entries.map((e) => migrateBusEntry(e, sessionId, defaultTargetForKind)),
                outcomeQueue: Array.isArray(current.outcomeQueue) ? [...current.outcomeQueue] : [],
            };
        }
    }
    return out;
}
