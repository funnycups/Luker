import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { CONTRACT_HARNESSES } from './harness/contract-harness.js';
import { seedExactWorld, seedReferenceCard, exactWorldState, referenceCardState, holdSettingsRead } from './harness/world-identity.js';
import { initStorage, getWorldInfoRepo, getSettingsRepo, getStorageEngine } from '../../src/storage/index.js';
import { router } from '../../src/endpoints/worldinfo.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { assertWorldNotBound } from '../../src/character-world-ownership.js';

const sqlOnly = CONTRACT_HARNESSES.filter(h => ['MysqlEngine', 'PgEngine'].includes(h.name));
const describeSql = sqlOnly.length ? describe.each(sqlOnly) : () => {};

const FIRST = 'Archive Ledger', SECOND = 'Archive  Ledger';
const FIRST_DOC = { entries: { '1': { content: 'First archive', key: ['north'] } }, extensions: { retained: ['first'] } };
const SECOND_DOC = { entries: { '2': { content: 'Adopted separate archive', key: ['south'] } }, extensions: { retained: ['second'] } };
const KEEP_DOC = { entries: { '3': { content: 'Independent archive' } }, retained: ['book sibling'] };
const SOURCE = { world_info_settings: { world_info: { charLore: [], retained: { setting: ['world sibling'] } } }, retained: { settings: ['untouched'] } };

async function seed(h, settings, adoption) {
    await seedExactWorld(h, FIRST, FIRST_DOC);
    await seedExactWorld(h, SECOND, SECOND_DOC);
    await seedExactWorld(h, 'Unchanged', KEEP_DOC);
    const source = structuredClone(SOURCE);
    if (adoption === 'auxiliary') source.world_info_settings.world_info.charLore = [{ name: 'keeper', extraBooks: [SECOND] }];
    await settings.save(h.handle, source);
    seedReferenceCard(h, 'keeper.png', adoption === 'primary' ? SECOND : 'Unchanged');
    seedReferenceCard(h, 'other.png', 'Unchanged');
    return { books: await exactWorldState(h), settings: source, cards: referenceCardState(h) };
}

async function snapshot(h, settings) {
    return { books: await exactWorldState(h), settings: await settings.get(h.handle), cards: referenceCardState(h) };
}

// This is a real loopback Express server with the production world-info router
// and storage initialization. Only the authenticated fixture identity is supplied.
describeSql('conditional HTTP identity on $name', ({ make }) => {
    let h, server, worlds, settings;
    beforeEach(async () => {
        h = await make();
        fs.mkdirSync(h.dirs.characters, { recursive: true });
        const url = h.kind === 'mysql' ? h.url : h.engine._pool.options.connectionString;
        initStorage({ mode: h.kind, [h.kind]: { url } });
        worlds = getWorldInfoRepo(); settings = getSettingsRepo();
        const app = express();
        app.use(express.json());
        app.use((request, response, next) => { request.user = { profile: { handle: h.handle }, directories: h.dirs }; next(); });
        app.use('/api/worldinfo', router);
        server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    });
    afterEach(async () => {
        try { if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
        finally { try { await getStorageEngine().close(); } finally { await h.cleanup(); } }
    });

    async function deletion(body) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/worldinfo/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    }

    test.each(['auxiliary', 'primary'])('standalone onlyIfUnbound cannot delete an adopted exact sibling after disappearance with %s adoption', async adoption => {
        const before = await seed(h, settings, adoption);
        const lock = await holdSettingsRead(h);
        let conditional, writing, patching;
        try {
            conditional = deletion({ name: FIRST, onlyIfUnbound: true });
            let waits;
            do { waits = await lock.waits(); } while (waits.length === 0);
            const ordinary = await deletion({ name: FIRST });
            expect(ordinary.status).toBe(200);
            const afterOrdinary = await exactWorldState(h);
            const intended = { ...before.settings, world_info_settings: { world_info: { ...before.settings.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: [SECOND] }, { name: 'other', extraBooks: ['Unchanged'] }] } } };
            // Admission is synchronous at this actual repository call and overlaps
            // the conditional HTTP request while its real settings read is blocked.
            writing = settings.save(h.handle, intended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
            const composed = { ...intended, retained: { ...intended.retained, writer: ['exact sibling'] } };
            patching = settings.patch(h.handle, [{ op: 'add', path: '/retained/writer', value: ['exact sibling'] }]).then(doc => ({ saved: true, doc }), error => ({ saved: false, code: error.code, details: error.details }));
            await lock.release();
            const result = await conditional;
            const writer = await writing;
            const patchWriter = await patching;
            const actual = await snapshot(h, settings);
            expect(ordinary).toEqual({ status: 200, body: 'OK' });
            expect(afterOrdinary).toEqual({ [SECOND]: before.books[SECOND], Unchanged: before.books.Unchanged });
            expect(result).toEqual({ status: 404, body: { code: 'world_missing', resourceState: 'missing' } });
            expect(writer).toEqual({ saved: true });
            expect(patchWriter).toEqual({ saved: true, doc: composed });
            expect(actual).toEqual({ books: afterOrdinary, settings: composed, cards: before.cards });
            expect(await worlds.get(h.handle, SECOND)).toEqual(SECOND_DOC);
            await worlds.patch(h.handle, SECOND, [{ op: 'replace', path: '/entries/2/content', value: 'Later ordinary edit' }]);
            await settings.patch(h.handle, [{ op: 'replace', path: '/retained/settings/0', value: 'later' }]);
            const later = await snapshot(h, settings);
            expect(later.books[SECOND].doc).toEqual({ ...SECOND_DOC, entries: { '2': { ...SECOND_DOC.entries['2'], content: 'Later ordinary edit' } } });
            expect(later.books[SECOND].revision).not.toBe(before.books[SECOND].revision);
            expect(later.books.Unchanged).toEqual(before.books.Unchanged);
            expect(later.settings).toEqual({ ...composed, retained: { settings: ['later'], writer: ['exact sibling'] } });
            expect(later.cards).toEqual(before.cards);
        } finally {
            await lock.close();
            if (conditional) await conditional;
            if (writing) await writing;
            if (patching) await patching;
        }
    });

    test('version-predicated disappearance reports the inspected book missing rather than the retained sibling present', async () => {
        const before = await seed(h, settings, 'auxiliary');
        const lock = await holdSettingsRead(h);
        let conditional;
        try {
            conditional = deletion({ name: FIRST, onlyIfUnbound: true, expectedVersion: before.books[FIRST].revision });
            let waits;
            do { waits = await lock.waits(); } while (waits.length === 0);
            const ordinary = await deletion({ name: FIRST });
            expect(ordinary.status).toBe(200);
            await lock.release();
            const result = await conditional;
            const actual = await snapshot(h, settings);
            expect(result).toEqual({ status: 409, body: { code: 'world_changed', resourceState: 'missing' } });
            expect(actual).toEqual({ books: { [SECOND]: before.books[SECOND], Unchanged: before.books.Unchanged }, settings: before.settings, cards: before.cards });
        } finally { await lock.close(); if (conditional) await conditional; }
    });

    test.each(['Late Book', 'Late  Book'])('HTTP initial absence does not adopt the later %s as its deletion target', async created => {
        const before = await seed(h, settings, 'primary');
        const lock = await holdSettingsRead(h);
        let conditional;
        try {
            conditional = deletion({ name: 'Late Book', onlyIfUnbound: true });
            let waits;
            do { waits = await lock.waits(); } while (waits.length === 0);
            await worlds.save(h.handle, created, FIRST_DOC);
            const createdState = await exactWorldState(h);
            await lock.release();
            const result = await conditional;
            const actual = await snapshot(h, settings);
            expect(result).toEqual({ status: 404, body: { code: 'world_missing', resourceState: 'missing' } });
            expect(actual).toEqual({ books: createdState, settings: before.settings, cards: before.cards });
        } finally { await lock.close(); if (conditional) await conditional; }
    });

    test.each(['auxiliary', 'primary'])('stable HTTP conditional success preserves distinct %s adoption and ordinary alias behavior', async adoption => {
        const before = await seed(h, settings, adoption);
        const success = await deletion({ name: FIRST, onlyIfUnbound: true });
        const retained = await snapshot(h, settings);
        const refused = await deletion({ name: SECOND, onlyIfUnbound: true });
        const afterRefusal = await snapshot(h, settings);
        const ordinary = await deletion({ name: FIRST });
        const afterOrdinary = await snapshot(h, settings);
        expect(success).toEqual({ status: 200, body: 'OK' });
        expect(retained).toEqual({ books: { [SECOND]: before.books[SECOND], Unchanged: before.books.Unchanged }, settings: before.settings, cards: before.cards });
        expect(refused).toEqual({ status: 409, body: { code: 'world_in_use', details: adoption === 'auxiliary' ? { name: SECOND, reference: 'auxiliary' } : { name: SECOND, avatar: 'keeper.png' }, resourceState: 'present' } });
        expect(afterRefusal).toEqual(retained);
        expect(ordinary).toEqual({ status: 200, body: 'OK' });
        expect(afterOrdinary).toEqual({ books: { Unchanged: before.books.Unchanged }, settings: before.settings, cards: before.cards });
    });
});

describe.each(CONTRACT_HARNESSES)('captured conditional identity controls on $name', ({ make }) => {
    let h, worlds, settings;
    beforeEach(async () => { h = await make(); worlds = new WorldInfoRepo({ engine: h.engine }); settings = new SettingsRepo({ engine: h.engine }); });
    afterEach(async () => { await h.cleanup(); });

    test.each(['exact', 'alias'])('%s callback disappearance never substitutes the surviving adopted book', async request => {
        const before = await seed(h, settings, 'auxiliary');
        const name = request === 'exact' ? FIRST : 'Archive   Ledger';
        const target = await worlds.resolveName(h.handle, name);
        // Alias selection is engine-owned; only adopt the distinct exact survivor.
        const survivor = target === FIRST ? SECOND : FIRST;
        const source = { ...before.settings, world_info_settings: { world_info: { ...SOURCE.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: [survivor] }] } } };
        await settings.save(h.handle, source);
        const result = await worlds.delete(h.handle, name, { beforeDelete: async resolveName => {
            await worlds.delete(h.handle, target);
            await assertWorldNotBound(h.dirs.characters, name, undefined, await settings.get(h.handle), resolveName);
        } });
        const actual = await snapshot(h, settings);
        expect(result).toBe(false);
        expect(actual).toEqual({ books: { [survivor]: before.books[survivor], Unchanged: before.books.Unchanged }, settings: source, cards: before.cards });
    });

    test.each(['Late Book', 'Late  Book'])('an initially missing captured target cannot delete the later %s', async created => {
        const before = await seed(h, settings, 'primary');
        const result = await worlds.delete(h.handle, 'Late Book', { beforeDelete: async resolveName => {
            await worlds.save(h.handle, created, FIRST_DOC);
            expect(await resolveName('Late Book')).toBeNull();
        } });
        const actual = await snapshot(h, settings);
        expect(result).toBe(false);
        expect(actual.books[created].doc).toEqual(FIRST_DOC);
        expect(typeof actual.books[created].revision).toBe('string');
        expect(actual.books).toEqual({ ...before.books, [created]: actual.books[created] });
        expect(actual.settings).toEqual(before.settings); expect(actual.cards).toEqual(before.cards);
    });

    test('stable tolerant conditional deletion refuses only its overlapping target references', async () => {
        const before = await seed(h, settings, 'auxiliary');
        await worlds.save(h.handle, 'Alias Book', FIRST_DOC);
        const version = await worlds.getVersion(h.handle, 'Alias Book');
        let writing, siblingWriting;
        const intended = { ...before.settings, world_info_settings: { world_info: { ...SOURCE.world_info_settings.world_info, charLore: [{ name: 'keeper', extraBooks: ['Alias  Book'] }] } } };
        const siblingIntended = { ...before.settings, retained: { settings: ['sibling writer'] } };
        const result = await worlds.delete(h.handle, 'Alias  Book', { expectedVersion: version, beforeDelete: async resolveName => {
            await assertWorldNotBound(h.dirs.characters, 'Alias  Book', undefined, await settings.get(h.handle), resolveName);
            writing = settings.save(h.handle, intended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code, details: error.details }));
            siblingWriting = settings.save(h.handle, siblingIntended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code }));
        } });
        const writer = await writing, siblingWriter = await siblingWriting;
        const actual = await snapshot(h, settings);
        expect(result).toBe(true);
        expect(writer).toEqual({ saved: false, code: 'world_deleted', details: { name: 'Alias Book' } });
        expect(siblingWriter).toEqual({ saved: true });
        expect(actual).toEqual({ books: before.books, settings: siblingIntended, cards: before.cards });
    });

    test('a captured missing target retains version refusal without deleting its later replacement', async () => {
        const before = await seed(h, settings, 'primary');
        const result = await worlds.delete(h.handle, 'Late Book', { expectedVersion: 'original-version', beforeDelete: () => worlds.save(h.handle, 'Late Book', FIRST_DOC) }).then(deleted => ({ deleted }), error => ({ code: error.code }));
        const actual = await snapshot(h, settings);
        expect(result).toEqual({ code: 'world_changed' });
        expect(actual.books['Late Book'].doc).toEqual(FIRST_DOC);
        expect(typeof actual.books['Late Book'].revision).toBe('string');
        expect(actual.books).toEqual({ ...before.books, 'Late Book': actual.books['Late Book'] });
        expect(actual.settings).toEqual(before.settings); expect(actual.cards).toEqual(before.cards);
    });
});

describe.each(CONTRACT_HARNESSES.filter(h => h.name === 'FsEngine'))('captured filenames on $name', ({ make }) => {
    test('conditional deletion retains the actual legacy extension spelling', async () => {
        const h = await make();
        try {
            const worlds = new WorldInfoRepo({ engine: h.engine }), settings = new SettingsRepo({ engine: h.engine });
            await seed(h, settings, 'auxiliary');
            fs.renameSync(path.join(h.dirs.worlds, FIRST + '.json'), path.join(h.dirs.worlds, FIRST + '.JSON'));
            const before = await snapshot(h, settings);
            const result = await worlds.delete(h.handle, FIRST, { expectedVersion: before.books[FIRST].revision });
            const actual = await snapshot(h, settings);
            expect(result).toBe(true);
            expect(actual).toEqual({ books: { [SECOND]: before.books[SECOND], Unchanged: before.books.Unchanged }, settings: before.settings, cards: before.cards });
        } finally { await h.cleanup(); }
    });
});
