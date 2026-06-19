import crypto from 'node:crypto';

/**
 * Stable SHA-256 hex digest over (targetMode, db urls). Used to decide whether
 * a subsequent POST /storage/migrate is a resume of a prior failed attempt or a
 * fresh start against a different target.
 *
 * urls contain credentials; the hash is one-way so we never expose them back in
 * /storage/status responses.
 */
export function computeFingerprint({ targetMode, mysqlConfig, postgresConfig } = {}) {
    const payload = JSON.stringify({
        targetMode: targetMode ?? null,
        mysqlUrl: mysqlConfig?.url ?? null,
        postgresUrl: postgresConfig?.url ?? null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

export function createState({ targetMode, fingerprint, handles, now }) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    const perUser = {};
    for (const h of handles) {
        perUser[h] = { status: 'pending' };
    }
    return {
        targetMode,
        fingerprint,
        startedAt: isoNow,
        lastProgressAt: isoNow,
        perUser,
    };
}

export function shouldResume(state, requestFingerprint) {
    if (state == null) return { kind: 'fresh' };
    if (state.fingerprint === requestFingerprint) return { kind: 'resume' };
    return { kind: 'conflict' };
}

export function pendingHandles(state) {
    return Object.entries(state.perUser)
        .filter(([, entry]) => entry.status !== 'done')
        .map(([handle]) => handle);
}

function touchProgress(state, now) {
    state.lastProgressAt = typeof now === 'string' ? now : new Date(now).toISOString();
}

export function markStart(state, handle, now) {
    if (!state.perUser[handle]) state.perUser[handle] = { status: 'pending' };
    touchProgress(state, now);
}

export function markDone(state, handle, now) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    state.perUser[handle] = { status: 'done', completedAt: isoNow };
    state.lastProgressAt = isoNow;
}

export function markFailed(state, handle, errMsg, now) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    state.perUser[handle] = { status: 'failed', error: String(errMsg ?? 'unknown error') };
    state.lastProgressAt = isoNow;
}

export function isAllDone(state) {
    return Object.values(state.perUser).every(entry => entry.status === 'done');
}

export function serializeStatus(state, now) {
    if (state == null) return null;
    const nowMs = typeof now === 'number' ? now : Date.parse(typeof now === 'string' ? now : new Date(now).toISOString());
    const lastMs = Date.parse(state.lastProgressAt);
    const staleSeconds = Math.max(0, Math.floor((nowMs - lastMs) / 1000));
    return {
        targetMode: state.targetMode,
        startedAt: state.startedAt,
        lastProgressAt: state.lastProgressAt,
        staleSeconds,
        perUser: state.perUser,
    };
}
