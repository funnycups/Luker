import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_HARNESSES } from './harness/contract-harness.js';
import { currentScopeForResources } from '../harness/storage-scope.js';
import { WorldInfoRepo } from '../../src/storage/repositories/world-info-repo.js';
import { SettingsRepo } from '../../src/storage/repositories/settings-repo.js';
import { MysqlEngine } from '../../src/storage/engines/mysql-engine.js';
import { PgEngine } from '../../src/storage/engines/postgres-engine.js';
import { createDatabaseCommitFault } from './harness/database-commit-fault.js';
import { assertWorldNotBound } from '../../src/character-world-ownership.js';
import { TransactionOutcomeUnknownError } from '../../src/storage/transaction-outcome.js';

const sqlOnly = CONTRACT_HARNESSES.filter(harness => ['MysqlEngine', 'PgEngine'].includes(harness.name));
const describeSql = sqlOnly.length ? describe.each(sqlOnly) : () => {};

async function observe(name, data) {
    await currentScopeForResources().captureDiagnostic({
        name: `${name}-${randomUUID()}.json`,
        contentType: 'application/json',
        bytes: Buffer.from(JSON.stringify(data, null, 2) + '\n'),
    });
}

async function seedDistinct(h, name, doc) {
    const revision = randomUUID();
    if (h.kind === 'fs') {
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        fs.writeFileSync(path.join(h.dirs.worlds, name + '.json'), JSON.stringify(doc));
    } else if (h.kind === 'sqlite') {
        await h.engine.ping(h.handle);
        h.engine._dbFor(h.handle).prepare('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES (?,?,?,?,?)').run(h.handle, name, JSON.stringify(doc), 100, revision);
    } else if (h.kind === 'mysql') {
        await h.engine.ping(h.handle);
        await h.engine._pool.execute('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES (?,?,?,?,?)', [h.handle, name, JSON.stringify(doc), 100, revision]);
    } else {
        await h.engine.ping(h.handle);
        await h.engine._pool.query('INSERT INTO worlds (handle,name,doc,updated_at,revision) VALUES ($1,$2,$3::jsonb,$4,$5)', [h.handle, name, JSON.stringify(doc), 100, revision]);
    }
}

describe.each(CONTRACT_HARNESSES)('exact world identity on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); fs.mkdirSync(h.dirs.characters, { recursive: true }); });
    afterEach(async () => { await h.cleanup(); });

    test('deleting a normalized sibling does not refuse a surviving exact reference', async () => {
        const deleted = { entries: { '1': { content: 'The narrow archive' } }, extensions: { sibling: ['first'] } };
        const survivor = { entries: { '2': { content: 'The separate archive' } }, extensions: { sibling: ['second'] } };
        await seedDistinct(h, 'Archive Ledger', deleted);
        await seedDistinct(h, 'Archive  Ledger', survivor);
        const worlds = new WorldInfoRepo({ engine: h.engine }); const settings = new SettingsRepo({ engine: h.engine });
        expect(await worlds.get(h.handle, 'Archive Ledger')).toEqual(deleted);
        expect(await worlds.get(h.handle, 'Archive  Ledger')).toEqual(survivor);
        const source = { world_info_settings: { world_info: { charLore: [] } }, sibling: { untouched: ['settings'] } };
        await settings.save(h.handle, source);
        expect(await worlds.resolveName(h.handle, 'Archive Ledger')).toBe('Archive Ledger');
        expect(await worlds.resolveName(h.handle, 'Archive  Ledger')).toBe('Archive  Ledger');
        const version = await worlds.getVersion(h.handle, 'Archive Ledger');
        const deletion = worlds.delete(h.handle, 'Archive Ledger', { expectedVersion: version });
        const intended = { ...source, world_info_settings: { world_info: { charLore: [{ name: 'keeper', extraBooks: ['Archive  Ledger'] }] } } };
        const writing = settings.save(h.handle, intended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code }));
        expect(await deletion).toBe(true);
        const outcome = await writing;
        const actual = { deleted: await worlds.get(h.handle, 'Archive Ledger'), survivor: await worlds.get(h.handle, 'Archive  Ledger'), settings: await settings.get(h.handle) };
        await observe('exact-identity-' + h.kind, { source, intended, outcome, actual, expectedDeleted: deleted, expectedSurvivor: survivor });
        expect(outcome).toEqual({ saved: true });
        expect(actual).toEqual({ deleted: survivor, survivor, settings: intended });
        expect(await worlds.listNames(h.handle)).toEqual(['Archive  Ledger']);
    });

    test('persisted auxiliary adoption of a distinct exact sibling does not refuse deletion', async () => {
        const first = { entries: { '1': { content: 'First archive' } }, retained: ['first'] };
        const second = { entries: { '2': { content: 'Second archive' } }, retained: ['second'] };
        await seedDistinct(h, 'Archive Ledger', first); await seedDistinct(h, 'Archive  Ledger', second);
        const worlds = new WorldInfoRepo({ engine: h.engine }); const settings = new SettingsRepo({ engine: h.engine });
        const expected = { world_info_settings: { world_info: { charLore: [{ name: 'keeper', extraBooks: ['Archive  Ledger'] }] } }, retained: ['settings'] };
        await settings.save(h.handle, expected);
        const version = await worlds.getVersion(h.handle, 'Archive Ledger');
        const outcome = await worlds.delete(h.handle, 'Archive Ledger', { expectedVersion: version, beforeDelete: async resolveName => assertWorldNotBound(h.dirs.characters, 'Archive Ledger', undefined, await settings.get(h.handle), resolveName) }).then(deleted => ({ deleted }), error => ({ error: error.code }));
        const actual = { settings: await settings.get(h.handle), names: await worlds.listNames(h.handle), survivor: await worlds.get(h.handle, 'Archive  Ledger') };
        await observe('exact-adoption-' + h.kind, { first, second, expected, outcome, actual });
        expect(outcome).toEqual({ deleted: true }); expect(actual).toEqual({ settings: expected, names: ['Archive  Ledger'], survivor: second });
    });

    test('an alias cannot retarget to a normalized sibling after its original target disappears', async () => {
        const first = { entries: { '1': { content: 'First archive' } }, retained: ['first'] };
        const second = { entries: { '2': { content: 'Second archive' } }, retained: ['second'] };
        await seedDistinct(h, 'Archive Ledger', first); await seedDistinct(h, 'Archive  Ledger', second);
        const worlds = new WorldInfoRepo({ engine: h.engine }); const settings = new SettingsRepo({ engine: h.engine });
        const alias = 'Archive   Ledger'; const originalTarget = await worlds.resolveName(h.handle, alias);
        const survivor = originalTarget === 'Archive Ledger' ? 'Archive  Ledger' : 'Archive Ledger';
        const source = { world_info_settings: { world_info: { charLore: [] } }, retained: ['settings'] }; await settings.save(h.handle, source);
        const deletion = worlds.delete(h.handle, originalTarget, { expectedVersion: await worlds.getVersion(h.handle, originalTarget) });
        const writing = settings.save(h.handle, { ...source, world_info_settings: { world_info: { charLore: [{ name: 'keeper', extraBooks: [alias] }] } } }).then(() => ({ saved: true }), error => ({ saved: false, code: error.code }));
        expect(await deletion).toBe(true); const outcome = await writing;
        const actual = { settings: await settings.get(h.handle), resolvedAfter: await worlds.resolveName(h.handle, alias), names: await worlds.listNames(h.handle), book: await worlds.get(h.handle, survivor) };
        await observe('alias-lifetime-' + h.kind, { alias, originalTarget, survivor, first, second, source, outcome, actual });
        expect(outcome).toEqual({ saved: false, code: 'world_deleted' }); expect(actual.settings).toEqual(source); expect(actual.resolvedAfter).toBe(survivor); expect(actual.names).toEqual([survivor]); expect(actual.book).toEqual(survivor === 'Archive Ledger' ? first : second);
    });
});

describeSql('unknown commit ownership on $name', ({ make }) => {
    let h, fault, engine;
    beforeEach(async () => { h = await make(); await h.engine.ping(h.handle); });
    afterEach(async () => {
        if (fault) await observe('fault-shutdown-' + h.kind, { database: h.dbName || h.schemaName, observations: fault.observations, errors: fault.errors });
        try { if (fault) await fault.close(); } finally { try { if (engine) await engine.close(); } finally { await h.cleanup(); } }
    });

    test('a lost actual COMMIT acknowledgement cannot release a dangling auxiliary write', async () => {
        const url = h.kind === 'mysql' ? h.url : h.engine._pool.options.connectionString;
        fault = await createDatabaseCommitFault(h.kind, url);
        engine = h.kind === 'mysql' ? new MysqlEngine({ url: fault.url }) : new PgEngine({ url: fault.url });
        await engine.ping(h.handle);
        const worlds = new WorldInfoRepo({ engine }); const settings = new SettingsRepo({ engine });
        const independent = new WorldInfoRepo({ engine: h.engine });
        const book = { entries: { '7': { content: 'The acknowledged archive' } }, extensions: { retained: ['book'] } };
        const source = { world_info_settings: { world_info: { charLore: [] } }, sibling: { retained: ['settings'] } };
        const version = await worlds.save(h.handle, 'Owned', book);
        await settings.save(h.handle, source);
        const observationStart = fault.observations.length;
        const held = fault.arm();
        let rejection;
        const deletion = worlds.delete(h.handle, 'Owned', { expectedVersion: version }).then(value => ({ deleted: value }), error => {
            rejection = error;
            return { error: error.message, code: error.code, operation: error.operation, cause: { name: error.cause.name, message: error.cause.message, code: error.cause.code } };
        });
        const acknowledgement = await held;
        expect(await independent.get(h.handle, 'Owned')).toBeNull();
        const intended = { ...source, world_info_settings: { world_info: { charLore: [{ name: 'keeper', extraBooks: ['Owned'] }] } } };
        const writing = settings.save(h.handle, intended).then(() => ({ saved: true }), error => ({ saved: false, code: error.code }));
        await fault.drop();
        const outcome = { deletion: await deletion, writing: await writing, book: await independent.get(h.handle, 'Owned'), settings: await new SettingsRepo({ engine: h.engine }).get(h.handle) };
        await observe('commit-outcome-' + h.kind, { acknowledgement, observationStart, observations: fault.observations, errors: fault.errors, source, intended, outcome });
        expect(outcome.writing).toEqual({ saved: false, code: 'world_deletion_unknown' });
        expect(outcome.settings).toEqual(source); expect(outcome.book).toBeNull();
        expect(outcome.deletion.code).toBe('transaction_outcome_unknown');
        expect(rejection).toBeInstanceOf(TransactionOutcomeUnknownError);
        expect(rejection.name).toBe('TransactionOutcomeUnknownError');
        expect(rejection.operation).toBe('COMMIT');
        expect(rejection.cause).toBeInstanceOf(Error);
        expect(rejection.message).toBe(`Cannot confirm storage COMMIT outcome: ${rejection.cause.message}. Reload persisted state before retrying.`);
        expect(Object.keys(rejection).sort()).toEqual(['code', 'name', 'operation']);
        const admitted = fault.observations.slice(observationStart);
        expect(admitted.filter(item => item.event === 'execute-world-delete')).toHaveLength(1);
        // Source identity capture commits before the native DELETE transaction.
        const deletionFrames = admitted.slice(admitted.findIndex(item => item.event === 'execute-world-delete'));
        expect(deletionFrames.filter(item => item.event === 'commit')).toEqual([{ id: acknowledgement.id, event: 'commit' }]);
        expect(admitted.filter(item => item.event === 'rollback')).toEqual([]);
    });
});

describeSql('confirmed rollback on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); await h.engine.ping(h.handle); });
    afterEach(async () => { await h.cleanup(); });

    test('an actual deadlock rolls back and retries the complete transaction', async () => {
        const worlds = new WorldInfoRepo({ engine: h.engine });
        const original = { entries: { '7': { content: 'Original archive' } }, retained: ['sibling'] };
        await worlds.save(h.handle, 'North', original); await worlds.save(h.handle, 'South', original);
        const attempts = { north: 0, south: 0 }, errors = [], committed = [];
        let northLocked, southLocked;
        const northReady = new Promise(resolve => { northLocked = resolve; });
        const southReady = new Promise(resolve => { southLocked = resolve; });
        const write = async (owner, names, locked) => {
            await h.engine.withTransaction(h.handle, async tx => {
                attempts[owner]++;
                const doc = { ...original, entries: { '7': { content: owner } } };
                try {
                    await tx.putResource({ kind: 'world', handle: h.handle, name: names[0] }, { doc });
                    if (attempts[owner] === 1) { locked(); await Promise.all([northReady, southReady]); }
                    await tx.putResource({ kind: 'world', handle: h.handle, name: names[1] }, { doc });
                } catch (error) {
                    errors.push({ owner, code: error.code, message: error.message });
                    throw error;
                }
            });
            committed.push(owner);
        };
        await Promise.all([write('north', ['North', 'South'], northLocked), write('south', ['South', 'North'], southLocked)]);
        const expected = { ...original, entries: { '7': { content: committed.at(-1) } } };
        const actual = { north: await worlds.get(h.handle, 'North'), south: await worlds.get(h.handle, 'South') };
        await observe('known-rollback-' + h.kind, { original, attempts, errors, committed, expected, actual });
        expect(errors).toMatchObject([{ code: h.kind === 'mysql' ? 'ER_LOCK_DEADLOCK' : '40P01' }]);
        expect(Object.values(attempts).sort()).toEqual([1, 2]);
        expect(actual).toEqual({ north: expected, south: expected });
    });
});
