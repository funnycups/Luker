// Endpoint parity for stats.recreateStats: it must drive aggregates from
// ChatRepo so a db-mode user's stats survive boot-time refresh + /recreate.

import fs from 'node:fs';
import path from 'node:path';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { recreateStats } from '../../../src/endpoints/stats.js';
import { getChatRepo, getStatsRepo } from '../../../src/storage/index.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };

describe.each(ENDPOINT_HARNESSES)('stats.recreateStats on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: () => {},
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: recreateStats walks Repo chats and produces non-empty per-character stats', async () => {
        // Plant a fake character PNG (recreateStats walks character dir for
        // .png names and uses each name as a key).
        fs.mkdirSync(harness.dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(harness.dirs.characters, 'Alice.png'), 'stub');

        // Save two chats via the Repo so they're visible in every storage mode.
        await getChatRepo().save(harness.handle, 'Alice', 'c1', HEADER, [
            { name: 'User', is_user: true, mes: 'hi there' },
            { name: 'Alice', is_user: false, mes: 'hello again' },
        ], null);
        await getChatRepo().save(harness.handle, 'Alice', 'c2', HEADER, [
            { name: 'User', is_user: true, mes: 'another one' },
        ], null);

        await recreateStats(harness.handle, harness.dirs.chats, harness.dirs.characters);

        const stats = await getStatsRepo().get(harness.handle);
        expect(stats).toBeTruthy();
        // The per-character key is sanitize('Alice') === 'Alice'.
        const ent = stats['Alice'];
        expect(ent).toBeDefined();
        expect(ent.user_msg_count).toBe(2); // c1 has 1 user msg + c2 has 1
        expect(ent.non_user_msg_count).toBe(1);
        expect(ent.user_word_count).toBeGreaterThan(0);
        expect(ent.date_last_chat).toBeGreaterThan(0);
    });

    test('REGRESSION: recreateStats survives engine restart (data fully in Repo, not on disk)', async () => {
        fs.mkdirSync(harness.dirs.characters, { recursive: true });
        fs.writeFileSync(path.join(harness.dirs.characters, 'Alice.png'), 'stub');
        await getChatRepo().save(harness.handle, 'Alice', 'm', HEADER, [
            { name: 'User', is_user: true, mes: 'hi' },
        ], null);

        await harness.reopenEngine();

        await recreateStats(harness.handle, harness.dirs.chats, harness.dirs.characters);
        const stats = await getStatsRepo().get(harness.handle);
        expect(stats['Alice'].user_msg_count).toBe(1);
    });
});
