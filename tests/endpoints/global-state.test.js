import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../storage/harness/endpoint-harness.js';
import { router as stateRouter } from '../../src/endpoints/state.js';
import { router as settingsRouter } from '../../src/endpoints/settings.js';
import { storageErrorHandler } from '../../src/middleware/storage-errors.js';
import { setReadOnly, getNamedDocRepo } from '../../src/storage/index.js';

describe.each(ENDPOINT_HARNESSES)('/api/state endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        setReadOnly(false);
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use('/api/state', stateRouter);
                app.use('/api/settings', settingsRouter);
                app.use(storageErrorHandler);
            },
        });
    });

    afterEach(async () => {
        setReadOnly(false);
        if (harness) await harness.cleanup();
    });

    test('GET /get and POST /get return null for absent namespace and reject invalid namespaces with 400', async () => {
        const getRes = await request(harness.server)
            .get('/api/state/get')
            .query({ account: harness.handle, namespace: 'missing_ns' })
            .expect(200);
        expect(getRes.body).toEqual({ ok: true, data: null });
        expect(getRes.headers.etag).toMatch(/^W\//);
        expect(getRes.headers['cache-control']).toContain('no-cache');

        const postRes = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'missing_ns' })
            .expect(200);
        expect(postRes.body).toEqual({ ok: true, data: null });

        // Account mismatch / missing account on GET /get -> 403
        await request(harness.server)
            .get('/api/state/get')
            .query({ account: 'wrong-user', namespace: 'missing_ns' })
            .expect(403);
        await request(harness.server)
            .get('/api/state/get')
            .query({ namespace: 'missing_ns' })
            .expect(403);

        for (const badNs of ['../x', '', '   ', '.hidden', 'a/b', 'a\\b', 'foo..bar', 'a\0b', 'ns.json']) {
            await request(harness.server)
                .get('/api/state/get')
                .query({ account: harness.handle, namespace: badNs })
                .expect(400);

            await request(harness.server)
                .post('/api/state/get')
                .send({ namespace: badNs })
                .expect(400);
        }

        await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 123 })
            .expect(400);
    });

    test('GET /get supports ETag conditional revalidation and invalidates on write', async () => {
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'workbench', data: { activeTab: 'studio', count: 1 } })
            .expect(200);

        const first = await request(harness.server)
            .get('/api/state/get')
            .query({ account: harness.handle, namespace: 'workbench' })
            .expect(200);
        expect(first.body).toEqual({ ok: true, data: { activeTab: 'studio', count: 1 } });
        expect(first.headers.etag).toMatch(/^W\//);

        await request(harness.server)
            .get('/api/state/get')
            .query({ account: harness.handle, namespace: 'workbench' })
            .set('If-None-Match', first.headers.etag)
            .expect(304);

        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'workbench', data: { activeTab: 'studio', count: 2 } })
            .expect(200);

        const second = await request(harness.server)
            .get('/api/state/get')
            .query({ account: harness.handle, namespace: 'workbench' })
            .set('If-None-Match', first.headers.etag)
            .expect(200);
        expect(second.body).toEqual({ ok: true, data: { activeTab: 'studio', count: 2 } });
        expect(second.headers.etag).not.toBe(first.headers.etag);
    });

    test('/set writes plain object and rejects array, primitive, null, and invalid namespace with 400', async () => {
        const setRes = await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: '  my_state  ', data: { enabled: true, nested: { a: [1, 2] } } })
            .expect(200);
        expect(setRes.body).toEqual({ ok: true });

        const postGet = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'my_state' })
            .expect(200);
        expect(postGet.body).toEqual({ ok: true, data: { enabled: true, nested: { a: [1, 2] } } });

        for (const badData of [[1, 2, 3], 'hello', 42, true, false, null, undefined]) {
            await request(harness.server)
                .post('/api/state/set')
                .send({ namespace: 'my_state', data: badData })
                .expect(400);
        }

        for (const badNs of ['../escape', '', '.dot', 'sub/dir', 'file.json']) {
            await request(harness.server)
                .post('/api/state/set')
                .send({ namespace: badNs, data: { ok: true } })
                .expect(400);
        }
    });

    test('/get-batch deduplicates namespaces, maps missing ones to null, and validates input', async () => {
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'alpha', data: { x: 1 } })
            .expect(200);
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'beta', data: { y: 2 } })
            .expect(200);

        const batchRes = await request(harness.server)
            .post('/api/state/get-batch')
            .send({ namespaces: ['alpha', 'missing', 'alpha', '  beta  '] })
            .expect(200);
        expect(batchRes.body).toEqual({
            ok: true,
            data: {
                alpha: { x: 1 },
                missing: null,
                beta: { y: 2 },
            },
        });

        await request(harness.server)
            .post('/api/state/get-batch')
            .send({ namespaces: [] })
            .expect(400);

        await request(harness.server)
            .post('/api/state/get-batch')
            .send({ namespaces: 'alpha' })
            .expect(400);

        await request(harness.server)
            .post('/api/state/get-batch')
            .send({ namespaces: ['alpha', '../evil'] })
            .expect(400);
    });

    test('/patch creates on first patch, updates existing, returns 409 on conflict, and 400 on malformed ops', async () => {
        const firstPatch = await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'sessions',
                operations: [
                    { op: 'add', path: '/activeId', value: 's1' },
                    { op: 'add', path: '/items/s1', value: { title: 'One' } },
                ],
            })
            .expect(200);
        expect(firstPatch.body).toEqual({ ok: true, applied: 2, created: true });

        const secondPatch = await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'sessions',
                operation: { op: 'replace', path: '/activeId', value: 's2' },
            })
            .expect(200);
        expect(secondPatch.body).toEqual({ ok: true, applied: 1, created: false });

        const afterUpdate = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'sessions' })
            .expect(200);
        expect(afterUpdate.body).toEqual({
            ok: true,
            data: {
                activeId: 's2',
                items: { s1: { title: 'One' } },
            },
        });

        // Failing test op -> 409 without mutating
        await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'sessions',
                operations: [
                    { op: 'test', path: '/activeId', value: 'stale' },
                    { op: 'replace', path: '/activeId', value: 's3' },
                ],
            })
            .expect(409);

        // Missing parent on replace -> 409
        await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'sessions',
                operations: [
                    { op: 'replace', path: '/nonexistent/child', value: 'x' },
                ],
            })
            .expect(409);

        const afterConflict = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'sessions' })
            .expect(200);
        expect(afterConflict.body.data.activeId).toBe('s2');

        // Empty / malformed ops -> 400
        for (const badPayload of [
            { namespace: 'sessions', operations: [] },
            { namespace: 'sessions', operations: 'not-an-array' },
            { namespace: 'sessions' },
            { namespace: 'sessions', operation: 'bad' },
            { namespace: 'sessions', operations: [{ op: 'move', from: '/activeId', path: '/other' }] },
            { namespace: 'sessions', operations: [{ op: 'add', path: 'no-leading-slash', value: 1 }] },
            { namespace: 'sessions', operations: [{ op: 'add', path: '/__proto__/polluted', value: true }] },
            { namespace: '../evil', operations: [{ op: 'add', path: '/a', value: 1 }] },
        ]) {
            await request(harness.server)
                .post('/api/state/patch')
                .send(badPayload)
                .expect(400);
        }
    });

    test('/patch supports root pointer replace/add/test and rejects root remove or non-object values without corrupting doc', async () => {
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'root_patch', data: { initial: true, keep: 'yes' } })
            .expect(200);

        // Root test mismatch -> 409 without mutating
        await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'root_patch',
                operations: [
                    { op: 'test', path: '', value: { initial: false } },
                    { op: 'replace', path: '', value: { whole: 'doc' } },
                ],
            })
            .expect(409);

        // Root remove -> 400 without mutating
        await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'root_patch',
                operations: [{ op: 'remove', path: '' }],
            })
            .expect(400);

        // Root replace with non-object -> 400 without mutating
        for (const badValue of [[1, 2, 3], null, 'scalar', 42]) {
            await request(harness.server)
                .post('/api/state/patch')
                .send({
                    namespace: 'root_patch',
                    operations: [{ op: 'replace', path: '', value: badValue }],
                })
                .expect(400);
        }

        const intact = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'root_patch' })
            .expect(200);
        expect(intact.body.data).toEqual({ initial: true, keep: 'yes' });

        // Root test match + replace -> 200 and whole-doc overwrite
        const replaceRes = await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'root_patch',
                operations: [
                    { op: 'test', path: '', value: { initial: true, keep: 'yes' } },
                    { op: 'replace', path: '', value: { whole: 'doc' } },
                ],
            })
            .expect(200);
        expect(replaceRes.body).toEqual({ ok: true, applied: 2, created: false });

        const afterReplace = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'root_patch' })
            .expect(200);
        expect(afterReplace.body.data).toEqual({ whole: 'doc' });

        // Root add -> 200 and whole-doc overwrite
        const addRes = await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'root_patch',
                operations: [{ op: 'add', path: '', value: { added: 'whole' } }],
            })
            .expect(200);
        expect(addRes.body).toEqual({ ok: true, applied: 1, created: false });

        const afterAdd = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'root_patch' })
            .expect(200);
        expect(afterAdd.body.data).toEqual({ added: 'whole' });
    });

    test('write routes enforce 128-byte UTF-8 namespace limit with 400 while read/delete allow longer existing names', async () => {
        const exactAscii = 'a'.repeat(128);
        const exactUtf8 = '汉'.repeat(42); // 42 * 3 = 126 bytes
        const overAscii = 'a'.repeat(129);
        const overUtf8 = '汉'.repeat(43); // 43 chars, 129 UTF-8 bytes

        // Within 128 bytes -> allowed on /set and /patch
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: exactAscii, data: { ok: 1 } })
            .expect(200);
        await request(harness.server)
            .post('/api/state/patch')
            .send({ namespace: exactUtf8, operations: [{ op: 'add', path: '/ok', value: 2 }] })
            .expect(200);

        // Over 128 UTF-8 bytes -> 400 on /set and /patch
        for (const longNs of [overAscii, overUtf8]) {
            await request(harness.server)
                .post('/api/state/set')
                .send({ namespace: longNs, data: { ok: 1 } })
                .expect(400);

            await request(harness.server)
                .post('/api/state/patch')
                .send({ namespace: longNs, operations: [{ op: 'add', path: '/ok', value: 1 }] })
                .expect(400);
        }

        // Pre-existing >128-byte namespace remains readable and deletable via /get, /get-batch, /delete
        await getNamedDocRepo().save(harness.handle, 'globalStates', overUtf8, { legacy: true });

        const getRes = await request(harness.server)
            .get('/api/state/get')
            .query({ account: harness.handle, namespace: overUtf8 })
            .expect(200);
        expect(getRes.body).toEqual({ ok: true, data: { legacy: true } });

        const postGetRes = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: overUtf8 })
            .expect(200);
        expect(postGetRes.body).toEqual({ ok: true, data: { legacy: true } });

        const batchRes = await request(harness.server)
            .post('/api/state/get-batch')
            .send({ namespaces: [overUtf8, overAscii] })
            .expect(200);
        expect(batchRes.body).toEqual({
            ok: true,
            data: {
                [overUtf8]: { legacy: true },
                [overAscii]: null,
            },
        });

        const delRes = await request(harness.server)
            .post('/api/state/delete')
            .send({ namespace: overUtf8 })
            .expect(200);
        expect(delRes.body).toEqual({ ok: true, deleted: true });
    });

    test('/delete removes namespace and reports deleted true then false', async () => {
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'ephemeral', data: { temp: 1 } })
            .expect(200);

        const del1 = await request(harness.server)
            .post('/api/state/delete')
            .send({ namespace: 'ephemeral' })
            .expect(200);
        expect(del1.body).toEqual({ ok: true, deleted: true });

        const getAfter = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'ephemeral' })
            .expect(200);
        expect(getAfter.body).toEqual({ ok: true, data: null });

        const del2 = await request(harness.server)
            .post('/api/state/delete')
            .send({ namespace: 'ephemeral' })
            .expect(200);
        expect(del2.body).toEqual({ ok: true, deleted: false });

        await request(harness.server)
            .post('/api/state/delete')
            .send({ namespace: '../bad' })
            .expect(400);
    });

    test('/api/settings/get does not leak globalStates entries', async () => {
        await getNamedDocRepo().save(harness.handle, 'themes', 'RealTheme', { name: 'RealTheme', color: 'blue' });
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'secret_global_state', data: { token: 'should_not_appear_in_settings' } })
            .expect(200);
        await request(harness.server)
            .post('/api/state/patch')
            .send({
                namespace: 'workbench_cache',
                operations: [{ op: 'add', path: '/marker', value: 'global_state_marker_xyz' }],
            })
            .expect(200);

        const settingsRes = await request(harness.server)
            .post('/api/settings/get')
            .send({})
            .expect(200);

        expect(settingsRes.body.themes).toEqual([{ name: 'RealTheme', color: 'blue' }]);
        const serialized = JSON.stringify(settingsRes.body);
        expect(serialized).not.toContain('secret_global_state');
        expect(serialized).not.toContain('should_not_appear_in_settings');
        expect(serialized).not.toContain('workbench_cache');
        expect(serialized).not.toContain('global_state_marker_xyz');
    });

    test('persists across engine reopen and returns 503 during read-only mode for writes', async () => {
        await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'durable', data: { step: 1 } })
            .expect(200);
        await request(harness.server)
            .post('/api/state/patch')
            .send({ namespace: 'durable', operations: [{ op: 'replace', path: '/step', value: 2 }] })
            .expect(200);

        await harness.reopenEngine();

        const afterReopen = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'durable' })
            .expect(200);
        expect(afterReopen.body).toEqual({ ok: true, data: { step: 2 } });

        setReadOnly(true);

        const setRo = await request(harness.server)
            .post('/api/state/set')
            .send({ namespace: 'durable', data: { step: 3 } })
            .expect(503);
        expect(setRo.body.error).toBe('storage_read_only');

        const patchRo = await request(harness.server)
            .post('/api/state/patch')
            .send({ namespace: 'durable', operations: [{ op: 'replace', path: '/step', value: 3 }] })
            .expect(503);
        expect(patchRo.body.error).toBe('storage_read_only');

        const delRo = await request(harness.server)
            .post('/api/state/delete')
            .send({ namespace: 'durable' })
            .expect(503);
        expect(delRo.body.error).toBe('storage_read_only');

        // Reads still succeed in read-only mode
        const readRo = await request(harness.server)
            .post('/api/state/get')
            .send({ namespace: 'durable' })
            .expect(200);
        expect(readRo.body).toEqual({ ok: true, data: { step: 2 } });
    });
});
