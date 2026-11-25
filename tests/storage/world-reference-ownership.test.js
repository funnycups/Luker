import fs from 'node:fs';
import { CONTRACT_HARNESSES } from './harness/contract-harness.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { assertWorldNotBound } from '../../src/character-world-ownership.js';
import { holdWorldRow } from './harness/world-row-lock.js';

const sqlOnly = CONTRACT_HARNESSES.filter(harness => ['MysqlEngine', 'PgEngine'].includes(harness.name));
const describeSql = sqlOnly.length ? describe.each(sqlOnly) : () => {};

describe.each(CONTRACT_HARNESSES)('persisted world adoption on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); fs.mkdirSync(h.dirs.characters, { recursive: true }); });
    afterEach(async () => { await h.cleanup(); });

    test('acknowledged auxiliary adoption refuses conditional deletion without changing settings or the book', async () => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const settings = new SettingsRepo({ engine: h.engine });
        const book = { entries: { '7': { content: 'Retained external reference' } }, extensions: { sibling: ['unchanged'] } };
        const doc = { world_info_settings: { world_info: { globalSelect: [], charLore: [{ name: 'adopter', extraBooks: ['Owned'] }], retained: { sibling: ['settings'] } } }, unrelated: { value: 'untouched' } };
        const version = await worlds.save(h.handle, 'Owned', book);
        await settings.save(h.handle, doc);
        await expect(worlds.delete(h.handle, 'Owned', {
            expectedVersion: version,
            beforeDelete: async resolveName => assertWorldNotBound(h.dirs.characters, 'Owned', undefined, await settings.get(h.handle), resolveName),
        })).rejects.toMatchObject({ code: 'world_in_use' });
        expect(await worlds.get(h.handle, 'Owned')).toEqual(book);
        expect(await worlds.getVersion(h.handle, 'Owned')).toBe(version);
        expect(await settings.get(h.handle)).toEqual(doc);
    });

    test('a failed conditional deletion releases a waiting valid reference write', async () => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const settings = new SettingsRepo({ engine: h.engine });
        const book = { entries: {}, extensions: { retained: ['world sibling'] } };
        const stale = await worlds.save(h.handle, 'Owned', book);
        const current = await worlds.save(h.handle, 'Owned', book);
        const deletion = worlds.delete(h.handle, 'Owned', { expectedVersion: stale });
        const expected = { world_info_settings: { world_info: { charLore: [{ name: 'adopter', extraBooks: ['Owned'] }] } }, sibling: ['settings'] };
        const writing = settings.save(h.handle, expected);
        await expect(deletion).rejects.toMatchObject({ code: 'world_changed' });
        await writing;
        expect(await settings.get(h.handle)).toEqual(expected);
        expect(await worlds.get(h.handle, 'Owned')).toEqual(book);
        expect(await worlds.getVersion(h.handle, 'Owned')).toBe(current);
    });

    test('ordinary settings writes preserve supported legacy references and unresolved names', async () => {
        const settings = new SettingsRepo({ engine: h.engine });
        const doc = { world_info: { charLore: [{ name: 'imported-card', extraBooks: ['Unresolved'] }] }, sibling: { enabled: false } };
        await settings.save(h.handle, doc);
        expect(await settings.get(h.handle)).toEqual(doc);
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const book = { entries: {} };
        const version = await worlds.save(h.handle, 'Unresolved', book);
        await expect(worlds.delete(h.handle, 'Unresolved', { expectedVersion: version, beforeDelete: async resolveName => assertWorldNotBound(h.dirs.characters, 'Unresolved', undefined, await settings.get(h.handle), resolveName) })).rejects.toMatchObject({ code: 'world_in_use' });
        expect(await worlds.get(h.handle, 'Unresolved')).toEqual(book);
        expect(await settings.get(h.handle)).toEqual(doc);
    });
});

describeSql('asynchronous reference ownership on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); fs.mkdirSync(h.dirs.characters, { recursive: true }); });
    afterEach(async () => { await h.cleanup(); });

    test.each(['save', 'patch'])('a settings %s overtaken by committed deletion cannot persist a dangling auxiliary reference', async method => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const settings = new SettingsRepo({ engine: h.engine });
        const doc = { world_info_settings: { world_info: { charLore: [], retained: { sibling: ['settings'] } } }, unrelated: { value: 'untouched' } };
        const book = { entries: { '7': { content: 'Original' } }, extensions: { retained: ['world sibling'] } };
        const version = await worlds.save(h.handle, 'Owned', book);
        await settings.save(h.handle, doc);
        const lock = await holdWorldRow(h, h.handle, 'Owned');
        try {
            const deletion = worlds.delete(h.handle, 'Owned', { expectedVersion: version, beforeDelete: async resolveName => assertWorldNotBound(h.dirs.characters, 'Owned', undefined, await settings.get(h.handle), resolveName) });
            let waits;
            do { waits = await lock.waits(); } while (waits.length === 0);
            expect(waits).toHaveLength(1);
            const adopted = { ...doc, world_info_settings: { world_info: { ...doc.world_info_settings.world_info, charLore: [{ name: 'adopter', extraBooks: ['Owned'] }] } } };
            const writing = method === 'save' ? settings.save(h.handle, adopted) : settings.patch(h.handle, [{ op: 'add', path: '/world_info_settings/world_info/charLore/-', value: { name: 'adopter', extraBooks: ['Owned'] } }]);
            const outcome = writing.then(value => ({ acknowledged: true, value }), error => ({ acknowledged: false, code: error.code, details: error.details }));
            await lock.release();
            expect(await deletion).toBe(true);
            expect(await outcome).toMatchObject({ acknowledged: false, code: 'world_deleted', details: { name: 'Owned' } });
            expect(await worlds.get(h.handle, 'Owned')).toBeNull();
            expect(await settings.get(h.handle)).toEqual(doc);
            // A rejected overlapping write does not poison later ordinary writes.
            await settings.patch(h.handle, [{ op: 'replace', path: '/unrelated/value', value: 'later' }]);
            expect(await settings.get(h.handle)).toEqual({ ...doc, unrelated: { value: 'later' } });
        } finally { await lock.close(); }
    });

    test('a pending deletion does not block another user or engine', async () => {
        const independent = await make();
        try {
            const worlds = new WorldInfoRepo({ engine: h.engine });
            const settings = new SettingsRepo({ engine: h.engine });
            const otherSettings = new SettingsRepo({ engine: independent.engine });
            const version = await worlds.save(h.handle, 'Owned', { entries: {} });
            const lock = await holdWorldRow(h, h.handle, 'Owned');
            try {
                const deletion = worlds.delete(h.handle, 'Owned', { expectedVersion: version });
                let waits;
                do { waits = await lock.waits(); } while (waits.length === 0);
                const doc = { world_info_settings: { world_info: { charLore: [{ name: 'other', extraBooks: ['Owned'] }] } }, retained: ['settings'] };
                await settings.save('other-user', doc);
                await otherSettings.save(independent.handle, doc);
                expect(await settings.get('other-user')).toEqual(doc);
                expect(await otherSettings.get(independent.handle)).toEqual(doc);
                expect(await lock.waits()).toHaveLength(1);
                await lock.release();
                expect(await deletion).toBe(true);
                expect(await worlds.get(h.handle, 'Owned')).toBeNull();
                expect(await settings.get('other-user')).toEqual(doc);
                expect(await otherSettings.get(independent.handle)).toEqual(doc);
            } finally { await lock.close(); }
        } finally { await independent.cleanup(); }
    });
});
