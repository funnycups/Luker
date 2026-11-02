import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as settingsRouter } from '../../../src/endpoints/settings.js';
import { router as worldInfoRouter } from '../../../src/endpoints/worldinfo.js';
import { acquireWriter, getGateState, setDirtyListener, syncWriteGateMiddleware, _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const FS_HARNESSES = ENDPOINT_HARNESSES.filter(h => h.mode === 'fs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    while (!predicate()) await tick();
}

describe.each(FS_HARNESSES)('sync write gate with real routers on $name', ({ mode }) => {
    let h;
    beforeEach(async () => {
        _resetGateForTests();
        h = await makeEndpointHarness({
            mode,
            mount: (app) => {
                app.use(syncWriteGateMiddleware());
                app.use('/api/settings', settingsRouter);
                app.use('/api/worldinfo', worldInfoRouter);
            },
        });
    });
    afterEach(async () => {
        _resetGateForTests();
        if (h) await h.cleanup();
    });

    test('a settings save during a writer hold waits then lands and marks dirty', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        const settingsPath = path.join(h.dirs.root, 'settings.json');
        const release = await acquireWriter(h.dirs.root);
        let settled = false;
        const pending = request(h.server).post('/api/settings/save').send({ user_name: 'during' }).then((r) => { settled = true; return r; });
        await until(() => getGateState(h.dirs.root).waitingReaders === 1);
        expect(settled).toBe(false);
        expect(fs.existsSync(settingsPath)).toBe(false);
        release();
        const res = await pending;
        expect(res.status).toBe(200);
        expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).user_name).toBe('during');
        await until(() => probe.mock.calls.length === 1);
        expect(probe).toHaveBeenCalledWith({ handle: h.handle, userRoot: h.dirs.root });
    });

    test('a rejected world edit does not mark dirty and an accepted one does', async () => {
        const probe = jest.fn();
        setDirtyListener(probe);
        await request(h.server).post('/api/worldinfo/edit').send({}).expect(400);
        await until(() => getGateState(h.dirs.root).readers === 0);
        await tick();
        expect(probe).not.toHaveBeenCalled();
        await request(h.server).post('/api/worldinfo/edit').send({ name: 'Lore', data: { entries: {} } }).expect(200);
        await until(() => probe.mock.calls.length === 1);
        expect(probe).toHaveBeenCalledWith({ handle: h.handle, userRoot: h.dirs.root });
    });
});
