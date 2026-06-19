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

export function markStart(state, handle, now) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    if (!state.perUser[handle] || state.perUser[handle].status !== 'done') {
        state.perUser[handle] = { status: 'in_flight', startedAt: isoNow };
    }
    state.lastProgressAt = isoNow;
}

/**
 * Record an in-flight stage transition for `handle`. Carries the runner-emitted
 * stage name (`settings-copied`, `chats-copied`, …) plus the running counts
 * snapshot so `/storage/status` callers can render "so far: chats=12 presets=4"
 * without waiting for the user to finish.
 *
 * Ignored if the user is already `done` (a late onProgress firing after the
 * runner returned won't clobber the terminal state).
 */
export function markStage(state, handle, { stage, counts } = {}, now) {
    const entry = state.perUser[handle];
    if (!entry || entry.status === 'done' || entry.status === 'failed') return;
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    state.perUser[handle] = {
        ...entry,
        status: 'in_flight',
        stage: stage ?? entry.stage ?? null,
        counts: counts ?? entry.counts ?? null,
    };
    state.lastProgressAt = isoNow;
}

export function markDone(state, handle, now, counts = null) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    const prev = state.perUser[handle] ?? {};
    state.perUser[handle] = {
        status: 'done',
        completedAt: isoNow,
        stage: 'done',
        counts: counts ?? prev.counts ?? null,
    };
    state.lastProgressAt = isoNow;
}

export function markFailed(state, handle, errMsg, now) {
    const isoNow = typeof now === 'string' ? now : new Date(now).toISOString();
    const prev = state.perUser[handle] ?? {};
    state.perUser[handle] = {
        status: 'failed',
        error: String(errMsg ?? 'unknown error'),
        stage: prev.stage ?? null,
        counts: prev.counts ?? null,
    };
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
