import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempSqliteEngineHarness } from '../storage/harness/contract-harness.js';
import { materializeUserDataIntoWorkdir } from '../../src/sync/materialize.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';

describe('SQL materializer legacy symlink boundaries', () => {
    test.each(['category', 'destination', 'empty-category', 'workdir', 'ancestor'])('does not touch targets through a %s symlink', async (scenario) => {
        const h = await makeTempSqliteEngineHarness();
        const outside = path.join(h.dataRoot, 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'keep.json'), 'recoverable');
        const workdir = path.join(h.dataRoot, 'shadow', 'workdir');
        fs.mkdirSync(workdir, { recursive: true });
        try {
            if (scenario === 'workdir') {
                fs.rmdirSync(workdir);
                fs.symlinkSync(outside, workdir);
            } else if (scenario === 'ancestor') {
                fs.rmdirSync(workdir);
                fs.rmdirSync(path.dirname(workdir));
                fs.symlinkSync(outside, path.dirname(workdir));
            } else if (scenario === 'destination') {
                fs.symlinkSync(path.join(outside, 'keep.json'), path.join(workdir, 'settings.json'));
            } else fs.symlinkSync(outside, path.join(workdir, 'worlds'));
            if (scenario !== 'empty-category') {
                await new WorldInfoRepo({ engine: h.engine }).save(h.handle, 'keep', { entries: {} });
                await new SettingsRepo({ engine: h.engine }).save(h.handle, { theme: 'dark' });
            }
            // Rejecting a migrated link is safe; following it is not.
            let failure;
            try {
                await materializeUserDataIntoWorkdir({ engine: h.engine, handle: h.handle, directories: h.dirs, workdir, categories: ['worlds', 'settings'] });
            } catch (error) {
                failure = error;
            }
            expect(failure?.code).toBe('UNSAFE_WORKDIR_PATH');
            expect(fs.readFileSync(path.join(outside, 'keep.json'), 'utf8')).toBe('recoverable');
            expect(fs.readdirSync(outside)).toEqual(['keep.json']);
        } finally {
            h.cleanup();
        }
    });
});
