// Parity test for content-manager.seedContentForUser.
//
// Bug: today seedContent copies content files (presets, worlds, themes, ...)
// directly to disk with fs.cpSync / fs.writeFileSync. In db modes (sqlite,
// mysql, postgres) the engine never sees these → first-run users have no
// themes, no default presets, no default world, etc.
//
// Fix: dispatch by content type — Repo-backed types go through their Repo;
// binary / multi-file types (character PNG, backgrounds, avatars, sprites,
// workflows) stay on disk.
//
// This test seeds one item of each Repo-backed family (world / theme /
// openai_preset) into a fresh per-engine harness, then queries the appropriate
// Repo. Before the fix the Repo list is empty under sqlite/mysql/postgres
// because the content landed on disk only. After the fix the Repo list
// contains the seeded item under every engine.

import fs from 'node:fs';
import path from 'node:path';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { seedContentForUser } from '../../../src/endpoints/content-manager.js';
import { getWorldInfoRepo, getNamedDocRepo, getPresetRepo } from '../../../src/storage/index.js';

// Tiny content index — three items spanning World / Theme / Preset.
function makeContentIndex(srcDir) {
    return [
        { type: 'world', filename: 'seed-world.json', folder: srcDir },
        { type: 'theme', filename: 'seed-theme.json', folder: srcDir },
        { type: 'openai_preset', filename: 'seed-openai.json', folder: srcDir },
    ];
}

describe.each(ENDPOINT_HARNESSES)('content-manager seedContentForUser on $name', ({ mode }) => {
    let harness;
    let srcDir;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: () => {},
        });
        srcDir = path.join(harness.dataRoot, 'content-src');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(
            path.join(srcDir, 'seed-world.json'),
            JSON.stringify({ entries: { '0': { uid: 0, key: ['hello'], content: 'world' } } }),
        );
        fs.writeFileSync(
            path.join(srcDir, 'seed-theme.json'),
            JSON.stringify({ name: 'seed-theme', accent: '#abc' }),
        );
        fs.writeFileSync(
            path.join(srcDir, 'seed-openai.json'),
            JSON.stringify({ temperature: 0.5, top_p: 0.9, marker: 'seeded-by-test' }),
        );
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: seedContentForUser writes world via WorldInfoRepo', async () => {
        await seedContentForUser(makeContentIndex(srcDir), harness.dirs, ['world']);
        const list = await getWorldInfoRepo().list(harness.handle);
        const names = list.map((entry) => entry?.key?.name).filter(Boolean);
        expect(names).toContain('seed-world');
    });

    test('REGRESSION: seedContentForUser writes theme via NamedDocRepo', async () => {
        await seedContentForUser(makeContentIndex(srcDir), harness.dirs, ['theme']);
        const list = await getNamedDocRepo().list(harness.handle, 'themes');
        const names = list.map((entry) => entry?.key?.name).filter(Boolean);
        expect(names).toContain('seed-theme');
    });

    test('REGRESSION: seedContentForUser writes openai preset via PresetRepo', async () => {
        await seedContentForUser(makeContentIndex(srcDir), harness.dirs, ['openai_preset']);
        const list = await getPresetRepo().list(harness.handle, 'openai');
        const names = list.map((entry) => entry?.key?.name).filter(Boolean);
        expect(names).toContain('seed-openai');
    });

    test('REGRESSION: force-reseed does not clobber a user-edited Repo doc', async () => {
        // The bug guarded here: contentLog gates the common case, but
        // forceCategories (e.g. /api/users/reset-step2) bypasses contentLog
        // and would overwrite user-edited data on every server restart.
        // After the fix, each repo sink probes `exists()` before writing.

        // Step 1: pre-populate the Repo as if the user had edited the theme.
        await getNamedDocRepo().save(harness.handle, 'themes', 'seed-theme', {
            name: 'seed-theme',
            accent: '#userized',
        });

        // Step 2: force-seed the same content (this is what /api/users/reset-step2
        // does, bypassing the contentLog gate).
        await seedContentForUser(makeContentIndex(srcDir), harness.dirs, ['theme']);

        // Step 3: the user's edits must still be there. Before the fix, the
        // default content (#abc) would have stomped the user's #userized.
        const persisted = await getNamedDocRepo().get(harness.handle, 'themes', 'seed-theme');
        expect(persisted).not.toBeNull();
        expect(persisted.accent).toBe('#userized');
    });
});
