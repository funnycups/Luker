// Chaos: the migration runner's failure semantics are load-bearing — if it
// crashes mid-copy or finds dest tampering, the source must be untouched, the
// backup must still exist, and the dest is allowed to be partial because the
// operator's restore path is "rm new dir, mv backup back". These tests prove
// those invariants by injecting a per-method Proxy failure into the dest
// repos and walking the on-disk artifacts after the throw.
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { MigrationRunner } from '../../../src/storage/migration/runner.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { PresetRepo } from '../../../src/storage/repositories/preset-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';
import { NamedDocRepo } from '../../../src/storage/repositories/named-doc-repo.js';
import { GroupRepo } from '../../../src/storage/repositories/group-repo.js';
import { StatsRepo } from '../../../src/storage/repositories/stats-repo.js';
import { setReadOnly } from '../../../src/storage/read-only-mode.js';

const [{ make: makeFs }, { make: makeSqlite }] = CONTRACT_HARNESSES;

function buildRepos(engine) {
    return {
        chat: new ChatRepo({ engine }),
        settings: new SettingsRepo({ engine }),
        preset: new PresetRepo({ engine }),
        worldInfo: new WorldInfoRepo({ engine }),
        namedDoc: new NamedDocRepo({ engine }),
        group: new GroupRepo({ engine }),
        stats: new StatsRepo({ engine }),
    };
}

// Wrap one method on a repo so the Nth invocation throws. All other accesses
// pass through. Used to simulate a destination engine giving up mid-copy.
function failOnNthCall(target, methodName, n) {
    let count = 0;
    return new Proxy(target, {
        get(t, prop, receiver) {
            const value = Reflect.get(t, prop, receiver);
            if (prop !== methodName) return value;
            return (...args) => {
                count += 1;
                if (count === n) throw new Error('chaos: injected failure');
                return value.apply(t, args);
            };
        },
    });
}

describe('Migration partial-failure', () => {
    let fsh, sqh;
    beforeEach(async () => {
        fsh = await makeFs();
        sqh = await makeSqlite();
    });
    afterEach(() => {
        setReadOnly(false);
        fsh.cleanup();
        sqh.cleanup();
    });

    test('dest write failure mid-copy: source intact, backup preserved, dest partial', async () => {
        // Populate source with one of each kind that the runner touches before
        // worldInfo (settings) and at/after the worldInfo step (world, chat).
        const srcRepos = buildRepos(fsh.engine);
        await srcRepos.settings.save(fsh.handle, { x: 1 });
        await srcRepos.worldInfo.save(fsh.handle, 'W1', { entries: { 0: { content: 'a' } } });
        await srcRepos.chat.save(
            fsh.handle, 'TestChar', 'chat1',
            { chat_metadata: {}, user_name: 'U' },
            [{ mes: 'hi' }],
            null,
        );

        // Sabotage dest worldInfo.save so the first call throws. Other dest
        // repos behave normally — settings was already copied before world.
        const destRepos = buildRepos(sqh.engine);
        destRepos.worldInfo = failOnNthCall(destRepos.worldInfo, 'save', 1);

        const tmpRoot = fsh.dataRoot;
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: srcRepos,
            destRepos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: (h) => path.join(tmpRoot, h),
            },
        });

        await expect(runner.migrateUser(fsh.handle)).rejects.toThrow(/chaos|world/i);

        // Source survives the abort.
        expect(await srcRepos.settings.get(fsh.handle)).toEqual({ x: 1 });
        expect(await srcRepos.worldInfo.get(fsh.handle, 'W1')).toBeTruthy();
        expect(await srcRepos.chat.get(fsh.handle, 'TestChar', 'chat1')).toBeTruthy();

        // Snapshot ran before any dest writes and is still on disk.
        expect(fs.existsSync(backupRoot)).toBe(true);
        const backups = fs.readdirSync(backupRoot);
        expect(backups.length).toBe(1);
        expect(backups[0]).toMatch(new RegExp(`-${fsh.handle}$`));
        // Backup is a verbatim copy of the source — settings.json is there.
        expect(fs.existsSync(path.join(backupRoot, backups[0], 'settings.json'))).toBe(true);

        // Dest is partial: settings landed (step before the failure), worldInfo
        // didn't. Read directly via a non-proxied repo so we observe raw state.
        const cleanDestWorld = new WorldInfoRepo({ engine: sqh.engine });
        expect(await cleanDestWorld.get(sqh.handle, 'W1')).toBeNull();
        const cleanDestSettings = new SettingsRepo({ engine: sqh.engine });
        expect(await cleanDestSettings.get(sqh.handle)).toEqual({ x: 1 });
    });

    test('verification step catches a tampered destination', async () => {
        const srcRepos = buildRepos(fsh.engine);
        await srcRepos.settings.save(fsh.handle, { x: 1 });

        // Sabotage: dest.settings.save writes something different. Copy
        // completes silently, but verify reads the dest back and notices.
        const destRepos = buildRepos(sqh.engine);
        const realSettings = destRepos.settings;
        destRepos.settings = new Proxy(realSettings, {
            get(t, prop, receiver) {
                const value = Reflect.get(t, prop, receiver);
                if (prop !== 'save') return value;
                return async (_handle) => realSettings.save(_handle, { x: 999 });
            },
        });

        const tmpRoot = fsh.dataRoot;
        const backupRoot = path.join(tmpRoot, '_storage-migrations');
        const runner = new MigrationRunner({
            sourceRepos: srcRepos,
            destRepos,
            snapshotPaths: {
                dataRoot: tmpRoot,
                backupRoot,
                getUserRoot: (h) => path.join(tmpRoot, h),
            },
        });

        await expect(runner.migrateUser(fsh.handle)).rejects.toThrow(/verif|mismatch/i);

        // Source still has the truth, dest has the sabotaged value — verify
        // is the thing standing between the operator and silent data loss.
        expect(await srcRepos.settings.get(fsh.handle)).toEqual({ x: 1 });
        const cleanDestSettings = new SettingsRepo({ engine: sqh.engine });
        expect(await cleanDestSettings.get(sqh.handle)).toEqual({ x: 999 });
    });
});
