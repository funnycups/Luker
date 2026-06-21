// Coverage for the settings snapshot endpoints. Pre-Phase 4 these read/wrote
// `<root>/settings.json` directly via fs.* — in db mode that file is empty
// (the data lives in SettingsRepo), so make-snapshot captured nothing and
// restore-snapshot was a silent no-op.
//
// After fix: snapshot operations route through SettingsRepo. Disk backups
// stay on fs (they're admin artifacts and deliberately fs-visible) but their
// contents reflect the live SettingsRepo state.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as settingsRouter } from '../../../src/endpoints/settings.js';
import { getSettingsRepo } from '../../../src/storage/index.js';

describe.each(ENDPOINT_HARNESSES)('settings.js snapshot endpoints on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/settings', settingsRouter); },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: /make-snapshot then /get-snapshots surfaces the snapshot of the live SettingsRepo doc', async () => {
        await getSettingsRepo().save(harness.handle, { user_name: 'pre-snapshot', custom: 'A' });

        await request(harness.app).post('/api/settings/make-snapshot').send({}).expect(204);

        const listRes = await request(harness.app).post('/api/settings/get-snapshots').send({}).expect(200);
        expect(Array.isArray(listRes.body)).toBe(true);
        expect(listRes.body.length).toBeGreaterThanOrEqual(1);

        const snap = listRes.body[0];
        expect(snap.name).toMatch(/^settings_u_/);

        const loadRes = await request(harness.app)
            .post('/api/settings/load-snapshot')
            .send({ name: snap.name })
            .expect(200);
        // The body comes back as a JSON-string (the raw on-disk snapshot file).
        const parsed = typeof loadRes.body === 'string'
            ? JSON.parse(loadRes.body)
            : (loadRes.text ? JSON.parse(loadRes.text) : loadRes.body);
        // The snapshot must reflect what was in the live SettingsRepo, not
        // the (empty) <root>/settings.json file.
        expect(parsed.user_name).toBe('pre-snapshot');
        expect(parsed.custom).toBe('A');
    });

    test('REGRESSION: /restore-snapshot writes back into SettingsRepo (not just a stale fs file)', async () => {
        // Seed state #1 + snapshot.
        await getSettingsRepo().save(harness.handle, { user_name: 'snapshot-state', preset: 'A' });
        await request(harness.app).post('/api/settings/make-snapshot').send({}).expect(204);

        // Mutate to state #2.
        await getSettingsRepo().save(harness.handle, { user_name: 'after-snapshot', preset: 'B' });

        // List snapshots to find the one we created.
        const listRes = await request(harness.app).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        // Restore — must roll the LIVE SettingsRepo (not a fs file) back to state #1.
        await request(harness.app)
            .post('/api/settings/restore-snapshot')
            .send({ name: snap.name })
            .expect(204);

        const after = await getSettingsRepo().get(harness.handle);
        expect(after.user_name).toBe('snapshot-state');
        expect(after.preset).toBe('A');
    });

    test('REGRESSION: snapshots persist across engine restart (the user-repro shape)', async () => {
        await getSettingsRepo().save(harness.handle, { user_name: 'persisted', x: 7 });
        await request(harness.app).post('/api/settings/make-snapshot').send({}).expect(204);

        await harness.reopenEngine();

        const listRes = await request(harness.app).post('/api/settings/get-snapshots').send({}).expect(200);
        const snap = listRes.body.find((s) => s.name.startsWith('settings_u_'));
        expect(snap).toBeDefined();

        const loadRes = await request(harness.app)
            .post('/api/settings/load-snapshot')
            .send({ name: snap.name })
            .expect(200);
        const parsed = typeof loadRes.body === 'string'
            ? JSON.parse(loadRes.body)
            : (loadRes.text ? JSON.parse(loadRes.text) : loadRes.body);
        expect(parsed.user_name).toBe('persisted');
        expect(parsed.x).toBe(7);
    });
});
