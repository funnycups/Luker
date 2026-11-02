/** Only retain backend identity and activity evidence, never response payloads. */
export function createSyncActivityState() {
    let backends = new Map();
    let readFailed = false;
    let sequence = 0;
    const requests = new Map();
    const outcomes = new Map();

    function acceptStatus(status) {
        const pending = new Set();
        for (const entry of [...status.conflicts, ...status.notices]) {
            for (const id of [entry.backendId, ...(entry.backends ?? []), ...Object.keys(entry.recordVersions ?? {})]) {
                if (id) pending.add(id);
            }
        }
        const next = new Map();
        for (const [id, backend] of Object.entries(status.backends)) {
            const unknown = Boolean(status.errors[id] || backend.pendingError);
            const prior = backends.get(id);
            next.set(id, {
                label: backend.label || id,
                running: Boolean(backend.running),
                at: backend.lastSync?.at ?? 0,
                failed: Boolean(backend.lastSync?.error || unknown),
                attention: pending.has(id) || Boolean(backend.lastSync?.stalled?.length) || (unknown && Boolean(prior?.attention)),
                unknown,
            });
        }
        for (const id of Object.keys(status.errors)) {
            if (!next.has(id)) next.set(id, { ...backends.get(id), label: backends.get(id)?.label || id, running: false, failed: true, unknown: true });
        }
        for (const [id, outcome] of outcomes) {
            const latest = next.get(id);
            const active = [...requests.values()].some(request => request.backendId === id);
            if (!latest && !active) outcomes.delete(id);
            else if (latest && !latest.unknown) {
                outcome.attention = false;
                if (outcome.barrierAt === null) outcome.barrierAt = latest.at;
                else if (!latest.failed && !latest.running && latest.at > outcome.barrierAt) outcome.failed = false;
            }
        }
        backends = next;
        readFailed = false;
    }

    function beginRequest({ backendId, label }) {
        const token = {};
        requests.set(token, { backendId, label: label || backendId, sequence: ++sequence });
        return token;
    }

    function finishRequest(token, { ok, needsAttention }) {
        const request = requests.get(token);
        if (!request) throw new Error('Sync activity request already settled or not owned');
        requests.delete(token);
        const prior = outcomes.get(request.backendId);
        if (!prior || request.sequence >= prior.sequence) {
            outcomes.set(request.backendId, {
                label: request.label,
                sequence: request.sequence,
                failed: !ok,
                attention: needsAttention,
                barrierAt: backends.get(request.backendId)?.at ?? null,
            });
        }
    }

    function getView() {
        const running = new Set(), attention = new Set(), failed = new Set();
        const labels = {};
        let unknown = readFailed;
        for (const [id, backend] of backends) {
            labels[id] = backend.label;
            if (backend.running) running.add(id);
            if (backend.attention) attention.add(id);
            if (backend.failed) failed.add(id);
            unknown ||= Boolean(backend.unknown);
        }
        for (const [id, outcome] of outcomes) {
            if (!labels[id]) labels[id] = outcome.label;
            if (outcome.failed) failed.add(id);
            if (outcome.attention) attention.add(id);
        }
        for (const request of requests.values()) {
            labels[request.backendId] = request.label;
            running.add(request.backendId);
        }
        return {
            visible: unknown || running.size > 0 || attention.size > 0 || failed.size > 0,
            runningBackendIds: [...running].sort(),
            attentionBackendIds: [...attention].sort(),
            failedBackendIds: [...failed].sort(),
            labels,
            unknown,
        };
    }
    return { acceptStatus, failStatusRead() { readFailed = true; }, beginRequest, finishRequest, getView };
}
