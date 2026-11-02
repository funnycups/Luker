import { createSyncActivityState } from '../../public/scripts/sync-activity-state.js';

const backend = (overrides = {}) => ({ kind: 's3', label: 'Cloud', running: false, lastSync: null, pendingError: null, ...overrides });
const status = (backends = {}, overrides = {}) => ({ ok: true, backends, conflicts: [], notices: [], errors: {}, ...overrides });
const success = at => ({ at, head: 'head', mergeCase: 'equal', stalled: [], error: null });

describe('Sync activity evidence', () => {
    test('a valid empty status is hidden and does not invent progress', () => {
        const state = createSyncActivityState();
        state.acceptStatus(status());
        expect(state.getView()).toEqual({ visible: false, runningBackendIds: [], attentionBackendIds: [], failedBackendIds: [], labels: {}, unknown: false });
    });

    test('background running work names its backend and authoritative completion hides it', () => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend({ running: true }) }));
        expect(state.getView()).toMatchObject({ visible: true, runningBackendIds: ['a'], labels: { a: 'Cloud' } });
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }) }));
        expect(state.getView()).toMatchObject({ visible: false, runningBackendIds: [] });
    });

    test.each([
        ['conflict owner', { conflicts: [{ backendId: 'a', path: 'worlds/Grove.json' }] }, ['a']],
        ['grouped conflict', { conflicts: [{ backendId: 'a', backends: ['a', 'b'], recordVersions: { b: 'v' } }] }, ['a', 'b']],
        ['notice reporters', { notices: [{ backends: ['b'], recordVersions: { a: 'v' } }] }, ['a', 'b']],
    ])('%s preserves the actual reporting backends', (_name, pending, expected) => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend(), b: backend({ label: 'Mirror' }) }, pending));
        expect(state.getView()).toMatchObject({ visible: true, attentionBackendIds: expected });
        state.acceptStatus(status({ a: backend(), b: backend() }));
        expect(state.getView().visible).toBe(false);
    });

    test.each([
        ['last sync error', backend({ lastSync: { ...success(10), error: { code: 'UNREACHABLE', message: 'private detail', at: 10 } } }), {}, ['a'], false],
        ['stalled paths', backend({ lastSync: { ...success(10), stalled: ['worlds/Grove.json'] } }), {}, [], false],
        ['pendingError', backend({ pendingError: { code: 'PENDING_READ_FAILED' } }), {}, ['a'], true],
        ['status errors', backend(), { a: { code: 'PENDING_READ_FAILED' } }, ['a'], true],
    ])('%s retains an actionable entry without retaining payloads', (_name, a, errors, failed, unknown) => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a }, { errors }));
        const view = state.getView();
        expect(view).toMatchObject({ visible: true, failedBackendIds: failed, unknown });
        expect(JSON.stringify(view)).not.toMatch(/private detail|Grove|UNREACHABLE|PENDING_READ_FAILED/);
    });

    test('a failed read retains populated evidence and identical recovery clears only uncertainty', () => {
        const state = createSyncActivityState();
        const pending = status({ a: backend() }, { conflicts: [{ backendId: 'a' }] });
        state.acceptStatus(pending);
        state.failStatusRead();
        expect(state.getView()).toMatchObject({ visible: true, attentionBackendIds: ['a'], labels: { a: 'Cloud' }, unknown: true });
        state.acceptStatus(pending);
        expect(state.getView()).toMatchObject({ attentionBackendIds: ['a'], unknown: false });
    });

    test('an initial failed read is unknown, not an empty successful configuration', () => {
        const state = createSyncActivityState();
        state.failStatusRead();
        expect(state.getView()).toMatchObject({ visible: true, unknown: true });
        state.acceptStatus(status());
        expect(state.getView().visible).toBe(false);
    });

    test.each(['conflicts', 'notices'])('partial %s reads preserve prior reporters through unrelated success', field => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend(), b: backend() }, { [field]: [{ backends: ['a', 'b'] }] }));
        state.acceptStatus(status({ a: backend({ pendingError: { code: 'PENDING_READ_FAILED' } }), b: backend({ lastSync: success(20) }) }, { errors: { a: { code: 'PENDING_READ_FAILED' } } }));
        expect(state.getView()).toMatchObject({ visible: true, attentionBackendIds: ['a'], failedBackendIds: ['a'], unknown: true });
        state.acceptStatus(status({ a: backend(), b: backend() }));
        expect(state.getView().visible).toBe(false);
    });

    test('removed backends clear only authoritative evidence, not live request ownership', () => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend({ running: true }), b: backend({ running: true }) }));
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.acceptStatus(status());
        expect(state.getView()).toMatchObject({ visible: true, runningBackendIds: ['a'], labels: { a: 'Desk' } });
        state.finishRequest(token, { ok: true, needsAttention: false });
        expect(state.getView().visible).toBe(false);
    });

    test('overlapping tokens survive status updates and settle independently', () => {
        const state = createSyncActivityState();
        const first = state.beginRequest({ backendId: 'a', label: 'Desk' });
        const second = state.beginRequest({ backendId: 'a', label: 'Desk' });
        const other = state.beginRequest({ backendId: 'b', label: 'Tablet' });
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }) }));
        state.finishRequest(first, { ok: true, needsAttention: false });
        state.finishRequest(other, { ok: true, needsAttention: false });
        expect(state.getView().runningBackendIds).toEqual(['a']);
        state.finishRequest(second, { ok: true, needsAttention: false });
        expect(state.getView().visible).toBe(false);
    });

    test('local failure survives stale and unrelated successes until its matching successful retry', () => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }), b: backend() }));
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(token, { ok: false, needsAttention: false });
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }), b: backend({ lastSync: success(30) }) }));
        expect(state.getView().failedBackendIds).toEqual(['a']);
        const retry = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(retry, { ok: true, needsAttention: false });
        expect(state.getView().visible).toBe(false);
    });

    test('authoritative newer success clears local failure but null history does not', () => {
        const state = createSyncActivityState();
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }) }));
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(token, { ok: false, needsAttention: false });
        state.acceptStatus(status({ a: backend() }));
        expect(state.getView().failedBackendIds).toEqual(['a']);
        state.acceptStatus(status({ a: backend({ lastSync: success(11) }) }));
        expect(state.getView().visible).toBe(false);
    });

    test('request failure fences success already observed while that request was active', () => {
        const state = createSyncActivityState();
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.acceptStatus(status({ a: backend({ lastSync: success(20) }) }));
        state.finishRequest(token, { ok: false, needsAttention: false });
        state.acceptStatus(status({ a: backend({ lastSync: success(20) }) }));
        expect(state.getView().failedBackendIds).toEqual(['a']);
    });

    test('unknown initial history cannot treat an old successful run as recovery from a local failure', () => {
        const state = createSyncActivityState();
        state.failStatusRead();
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(token, { ok: false, needsAttention: false });
        state.acceptStatus(status({ a: backend({ lastSync: success(10) }) }));
        expect(state.getView().failedBackendIds).toEqual(['a']);
        state.acceptStatus(status({ a: backend({ lastSync: success(11) }) }));
        expect(state.getView().visible).toBe(false);
    });

    test('partial manual completion remains an entry until readable pending state settles', () => {
        const state = createSyncActivityState();
        const token = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(token, { ok: true, needsAttention: true });
        expect(state.getView()).toMatchObject({ visible: true, runningBackendIds: [], attentionBackendIds: ['a'] });
        state.failStatusRead();
        expect(state.getView().attentionBackendIds).toEqual(['a']);
        state.acceptStatus(status({ a: backend() }));
        expect(state.getView().visible).toBe(false);
    });

    test('an older overlapping completion cannot erase a newer local failure', () => {
        const state = createSyncActivityState();
        const older = state.beginRequest({ backendId: 'a', label: 'Desk' });
        const newer = state.beginRequest({ backendId: 'a', label: 'Desk' });
        state.finishRequest(newer, { ok: false, needsAttention: true });
        state.finishRequest(older, { ok: true, needsAttention: false });
        expect(state.getView()).toMatchObject({ failedBackendIds: ['a'], attentionBackendIds: ['a'] });
    });

    test('view mutations cannot alter retained evidence', () => {
        const state = createSyncActivityState();
        state.beginRequest({ backendId: 'a', label: '<img src=x>' });
        const view = state.getView();
        view.labels.a = 'changed';
        view.runningBackendIds.length = 0;
        expect(state.getView()).toMatchObject({ runningBackendIds: ['a'], labels: { a: '<img src=x>' } });
    });
});
