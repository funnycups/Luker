// Engine-level parity for dumpUser / restoreUser.
// fs returns null (no engine-side dump; disk tree IS the backup).
// sqlite returns a binary stream of the .sqlite file.
// mysql / postgres return a text stream of newline-separated JSON-encoded INSERTs.
// restoreUser of the SAME kind round-trips dump+restore to recreate all user rows.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { RestoreDumpInvalidError } from '../../../src/storage/errors.js';
import { SqliteEngine, SQLITE_USER_TABLES } from '../../../src/storage/engines/sqlite-engine.js';
import { MysqlEngine } from '../../../src/storage/engines/mysql-engine.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
// Multi-byte UTF-8 content guards against silent mojibake in the restore
// stream decoder: CJK chars are 3 bytes and emoji are 4, so if the engine's
// stream loop ever falls back to plain `chunk.toString('utf8')` (no
// StringDecoder buffering across chunk boundaries) a partial sequence at a
// chunk break would surface as U+FFFD here. The dedicated split-boundary
// test below forces the worst-case boundary deterministically; this seed
// also exercises the happy path under whatever chunking the engine emits.
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi 你好 🌍' },
    { name: 'Alice', is_user: false, mes: 'hello 世界 ✨' },
];

async function streamToBuffer(stream) {
    if (stream == null) return null;
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function bufferToStream(buf) {
    return Readable.from([buf]);
}

describe.each(CONTRACT_HARNESSES)('engine.dumpUser/restoreUser on $name', ({ make }) => {
    let h;

    beforeEach(async () => {
        h = await make();
        if (typeof h.engine.ping === 'function') await h.engine.ping(h.handle);
    });

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    test('dumpUser returns null for fs, non-null Readable for others', async () => {
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
        });
        const dump = await h.engine.dumpUser(h.handle);
        if (h.kind === 'fs') {
            expect(dump).toBeNull();
        } else {
            expect(dump).not.toBeNull();
            expect(typeof dump.pipe).toBe('function'); // is a Readable
        }
    });

    test('restoreUser is a no-op for fs', async () => {
        if (h.kind !== 'fs') return;
        await h.engine.restoreUser(h.handle, Readable.from(['ignored']));
        // No throw, no state change.
    });

    test('dump→deleteUser→restore round-trips all user data', async () => {
        if (h.kind === 'fs') return; // fs branch is skipped per spec

        // Seed all 9 Repo-backed resource types.
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
            await tx.putChatState({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }, 'ns', { foo: 'bar' });
            await tx.putResource({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' },
                { doc: { temperature: 0.5 } });
            await tx.putPresetState({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' }, 'ns', { v: 1 });
            await tx.putResource({ kind: 'world', handle: h.handle, name: 'w1' }, { doc: { entries: {} } });
            await tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 't1' },
                { doc: { accent: '#abc' } });
            await tx.putResource({ kind: 'group', handle: h.handle, id: 'g1' },
                { doc: { id: 'g1', name: 'Test', chats: [] } });
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'test' } });
            await tx.putResource({ kind: 'stats', handle: h.handle }, { doc: { totalChats: 0 } });
        });

        // Capture dump.
        const dumpBuf = await streamToBuffer(await h.engine.dumpUser(h.handle));
        expect(dumpBuf).not.toBeNull();
        expect(dumpBuf.length).toBeGreaterThan(0);

        // Wipe + mutate. `deleteUser` semantics are engine-specific: mysql/pg
        // clear rows, sqlite is a no-op for row-removal per spec §5.3 (only
        // evicts the cached handle; the .sqlite file stays put for `purge=true`
        // to sweep separately). To make the restore-actually-restored claim
        // verifiable on every engine — sqlite included — we mutate every
        // resource AFTER the wipe and assert the restore brings the ORIGINAL
        // back. Mutation-then-restore is unambiguously stronger than
        // wipe-then-restore: a no-op `restoreUser` would leave the mutated
        // values intact and the assertions below would fail loudly.
        await h.engine.deleteUser(h.handle);
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: [{ name: 'User', is_user: true, mes: 'MUTATED' }] });
            await tx.putChatState({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }, 'ns', { foo: 'MUTATED' });
            await tx.putResource({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' },
                { doc: { temperature: 9.9 } });
            await tx.putPresetState({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' }, 'ns', { v: 999 });
            await tx.putResource({ kind: 'world', handle: h.handle, name: 'w1' }, { doc: { entries: { mutated: true } } });
            await tx.putResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 't1' },
                { doc: { accent: '#MUTATED' } });
            await tx.putResource({ kind: 'group', handle: h.handle, id: 'g1' },
                { doc: { id: 'g1', name: 'MUTATED', chats: [] } });
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'MUTATED' } });
            await tx.putResource({ kind: 'stats', handle: h.handle }, { doc: { totalChats: 999 } });
        });

        // Restore from dump — must overwrite the mutations and bring back the
        // original values.
        await h.engine.restoreUser(h.handle, bufferToStream(dumpBuf));

        // Probe every Repo-backed resource — must match what we ORIGINALLY
        // wrote, not the mutations. All 9 user-data tables are covered: 7 base
        // records plus the two sidecar namespaces (chat_states + preset_states)
        // so the round-trip claim is verifiable for every table dumped by
        // DUMP_TABLES.
        //
        // Note on shape: most Repo handlers (preset/world/named-doc/group/
        // settings/stats) return the parsed JSON doc DIRECTLY — there is no
        // outer `{doc: ...}` wrapper. Only the `chat` handler returns a record
        // with `header`, `body`, `integrity`, `updatedAt`, `createdAt`.
        const probes = await h.engine.withTransaction(h.handle, async (tx) => ({
            chat: await tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }),
            chatState: await tx.getChatState({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }, 'ns'),
            preset: await tx.getResource({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' }),
            presetState: await tx.getPresetState({ kind: 'preset', handle: h.handle, dirKey: 'openAI_Settings', name: 'p1' }, 'ns'),
            world: await tx.getResource({ kind: 'world', handle: h.handle, name: 'w1' }),
            namedDoc: await tx.getResource({ kind: 'named-doc', handle: h.handle, bucket: 'themes', name: 't1' }),
            group: await tx.getResource({ kind: 'group', handle: h.handle, id: 'g1' }),
            settings: await tx.getResource({ kind: 'settings', handle: h.handle }),
            stats: await tx.getResource({ kind: 'stats', handle: h.handle }),
        }));
        expect(probes.chat).not.toBeNull();
        expect(probes.chat.body).toEqual(MESSAGES);
        expect(probes.chatState).toEqual({ foo: 'bar' });
        expect(probes.preset?.temperature).toBe(0.5);
        expect(probes.presetState).toEqual({ v: 1 });
        expect(probes.world?.entries).toEqual({});
        expect(probes.namedDoc?.accent).toBe('#abc');
        expect(probes.group?.id).toBe('g1');
        expect(probes.group?.name).toBe('Test');
        expect(probes.settings?.user_name).toBe('test');
        expect(probes.stats?.totalChats).toBe(0);
    });

    test('restoreUser decodes multi-byte UTF-8 across chunk boundaries', async () => {
        // The dump/restore round-trip is byte-for-byte; mysql/pg restore reads the
        // dump stream chunk-by-chunk and must reassemble multi-byte UTF-8
        // sequences split at a chunk boundary. Without StringDecoder,
        // `chunk.toString('utf8')` on a partial sequence emits U+FFFD in
        // BOTH the trailing bytes of this chunk and the leading bytes of
        // the next — silent mojibake in restored chat content.
        //
        // sqlite restore is binary (just rename the .sqlite file), so chunk
        // boundaries can't corrupt content there. fs has no restore body.
        // The bug, and therefore this test, applies only to mysql/pg.
        if (h.kind === 'fs' || h.kind === 'sqlite') return;

        // Seed: chat content with CJK (3-byte) and emoji (4-byte) chars so
        // any boundary inside them surfaces as U+FFFD on a buggy decoder.
        const cjkBody = [
            { name: 'User', is_user: true, mes: 'こんにちは 你好 안녕하세요 🌍🎉🚀' },
            { name: 'Alice', is_user: false, mes: '世界 émoji ✨ 漢字 🐉' },
        ];
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: cjkBody });
        });

        // Capture the real engine dump.
        const dumpBuf = await streamToBuffer(await h.engine.dumpUser(h.handle));
        expect(dumpBuf).not.toBeNull();
        expect(dumpBuf.length).toBeGreaterThan(0);

        // Build a chunked Readable that splits the dump at EVERY single
        // byte boundary. This guarantees the boundary falls mid multi-byte
        // sequence many times — the buggy decoder would emit a flood of
        // U+FFFD; the StringDecoder fix reassembles them losslessly.
        const oneByteChunks = [];
        for (let i = 0; i < dumpBuf.length; i++) {
            oneByteChunks.push(dumpBuf.subarray(i, i + 1));
        }
        const chunkedStream = Readable.from(oneByteChunks);

        // Wipe and restore through the artificially-chunked stream.
        await h.engine.deleteUser(h.handle);
        await h.engine.restoreUser(h.handle, chunkedStream);

        const restored = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        expect(restored).not.toBeNull();
        expect(restored.body).toEqual(cjkBody);
        // Belt + suspenders: stringify and check there are no U+FFFD chars
        // anywhere in the restored payload. A buggy decoder would have
        // sprinkled them through the multi-byte regions.
        expect(JSON.stringify(restored.body)).not.toMatch(/�/);
    });

    test('restoreUser rolls back without retrying when the dump stream fails transiently', async () => {
        // mysql/pg replay the dump inside one transaction. A transient-coded
        // error raised by the dump stream must roll the restore back, not
        // retry against a drained stream and commit an empty restore.
        if (h.kind === 'fs' || h.kind === 'sqlite') return;

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
        });
        const before = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        const dumpText = (await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8');
        const firstLine = dumpText.slice(0, dumpText.indexOf('\n') + 1);
        expect(firstLine.length).toBeGreaterThan(1);

        // Re-iterable source: the first pass yields one valid record and then
        // fails with a transient code; any later pass yields nothing, like a
        // stream that has already been consumed.
        let passes = 0;
        const source = {
            async *[Symbol.asyncIterator]() {
                passes += 1;
                if (passes > 1) return;
                yield Buffer.from(firstLine);
                throw Object.assign(new Error('socket reset mid-restore'), { code: 'ECONNRESET' });
            },
        };

        await expect(h.engine.restoreUser(h.handle, source)).rejects.toMatchObject({ code: 'ECONNRESET' });
        expect(passes).toBe(1);
        const after = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        expect(after).toEqual(before);
    });

    test('restoreUser rejects a corrupt dump and keeps the existing data', async () => {
        if (h.kind === 'fs') return; // fs has no engine dump

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
        });
        const before = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from('not a real dump'))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const after = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
        expect(after).toEqual(before);
    });

    test('restoreUser rejects a dump statement that is not an engine INSERT and keeps every user\'s data', async () => {
        if (h.kind === 'fs' || h.kind === 'sqlite') return; // only mysql/pg replay SQL records

        const otherHandle = 'other-user';
        for (const handle of [h.handle, otherHandle]) {
            await h.engine.withTransaction(handle, async (tx) => {
                await tx.putResource({ kind: 'chat', handle, charDir: 'Alice', name: 'c1' },
                    { header: HEADER, body: MESSAGES });
            });
        }
        const before = await readChat(h.engine, h.handle);
        const otherBefore = await readChat(h.engine, otherHandle);
        const dumpText = (await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8');
        const injected = JSON.stringify({ sql: `DELETE FROM chats WHERE handle = '${otherHandle}'`, params: [] });

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from(`${dumpText}${injected}\n`))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        expect(await readChat(h.engine, otherHandle)).toEqual(otherBefore);
        expect(await readChat(h.engine, h.handle)).toEqual(before);
    });

    test('restoreUser rejects an INSERT into a table outside the engine dump', async () => {
        if (h.kind === 'fs' || h.kind === 'sqlite') return; // only mysql/pg replay SQL records

        await h.engine._pool.query('CREATE TABLE dump_probe (handle VARCHAR(64), v VARCHAR(64))');
        const placeholders = h.kind === 'postgres' ? '$1, $2' : '?, ?';
        const injected = JSON.stringify({ sql: `INSERT INTO dump_probe (handle, v) VALUES (${placeholders})`, params: [h.handle, 'x'] });

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from(`${injected}\n`))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const result = await h.engine._pool.query('SELECT COUNT(*) AS n FROM dump_probe');
        const rows = h.kind === 'postgres' ? result.rows : result[0];
        expect(Number(rows[0].n)).toBe(0);
    });

    test('restoreUser rejects an engine INSERT whose param count does not match its columns', async () => {
        if (h.kind === 'fs' || h.kind === 'sqlite') return; // only mysql/pg replay SQL records

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'kept' } });
        });
        const dumpText = (await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8').trim();
        const record = JSON.parse(dumpText.split('\n')[0]);
        record.params.push('extra');

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from(`${JSON.stringify(record)}\n`))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const settings = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle: h.handle }));
        expect(settings?.user_name).toBe('kept');
    });

    test('restoreUser rejects dump rows that collide once moved onto the target handle and keeps the data', async () => {
        if (h.kind === 'fs' || h.kind === 'sqlite') return; // only mysql/pg replay SQL records

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'kept' } });
        });
        const record = JSON.parse((await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8').trim().split('\n')[0]);
        const fromOtherAccount = { ...record, params: ['other-user', ...record.params.slice(1)] };
        const dump = `${JSON.stringify(record)}\n${JSON.stringify(fromOtherAccount)}\n`;

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from(dump))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const settings = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle: h.handle }));
        expect(settings?.user_name).toBe('kept');
    });

    // settings params: [handle, doc JSON, updated_at BIGINT]; worlds params: [handle, name VARCHAR(128), doc, updated_at].
    test.each([
        ['a doc that is not JSON', 'settings', (params) => [params[0], 'not json {', params[2]]],
        ['an updated_at that is not a number', 'settings', (params) => [params[0], params[1], 'not a number']],
        ['an updated_at outside the BIGINT range', 'settings', (params) => [params[0], params[1], 1e30]],
        ['a name longer than its column', 'worlds', (params) => [params[0], 'w'.repeat(129), params[2], params[3]]],
    ])('restoreUser rejects a dump row with %s and keeps the data', async (_label, table, craft) => {
        if (h.kind === 'fs' || h.kind === 'sqlite') return; // only mysql/pg replay SQL records

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'kept' } });
            await tx.putResource({ kind: 'world', handle: h.handle, name: 'w1' }, { doc: { entries: { kept: true } } });
        });
        const records = (await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
        const record = records.find(r => r.sql.startsWith(`INSERT INTO ${table} `));
        const crafted = { ...record, params: craft(record.params) };

        await expect(h.engine.restoreUser(h.handle, bufferToStream(Buffer.from(`${JSON.stringify(crafted)}\n`))))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const kept = await h.engine.withTransaction(h.handle, async (tx) => ({
            settings: await tx.getResource({ kind: 'settings', handle: h.handle }),
            world: await tx.getResource({ kind: 'world', handle: h.handle, name: 'w1' }),
        }));
        expect(kept.settings?.user_name).toBe('kept');
        expect(kept.world).toEqual({ entries: { kept: true } });
    });

    test('restoreUser writes a dump from another handle under the target handle', async () => {
        if (h.kind === 'fs') return; // fs has no engine dump

        const source = await makeSourceEngine(h);
        try {
            await seedEveryTable(source.engine, source.handle, 'source');
            await seedEveryTable(h.engine, h.handle, 'MUTATED');
            const sourceBefore = await readEveryTable(source.engine, source.handle);
            expect(sourceBefore.stats?.tag).toBe('source');
            const dumpBuf = await streamToBuffer(await source.engine.dumpUser(source.handle));

            await h.engine.restoreUser(h.handle, bufferToStream(dumpBuf));

            expect(await readEveryTable(h.engine, h.handle)).toEqual(sourceBefore);
            expect(await readEveryTable(source.engine, source.handle)).toEqual(sourceBefore);
        } finally {
            source.cleanup();
        }
    });

    test('sqlite restoreUser rejects a database without the Luker tables', async () => {
        if (h.kind !== 'sqlite') return;

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
        });
        const before = await readChat(h.engine, h.handle);
        const foreignPath = path.join(h.dataRoot, 'foreign.sqlite');
        const foreign = new Database(foreignPath);
        foreign.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
        foreign.close();

        await expect(h.engine.restoreUser(h.handle, fs.createReadStream(foreignPath)))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        expect(await readChat(h.engine, h.handle)).toEqual(before);
    });

    test('sqlite restoreUser rejects rows of several accounts that collide on one handle and keeps the data', async () => {
        if (h.kind !== 'sqlite') return;

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'kept' } });
        });
        const payloadPath = path.join(h.dataRoot, 'two-accounts.sqlite');
        fs.writeFileSync(payloadPath, await streamToBuffer(await h.engine.dumpUser(h.handle)));
        const payload = new Database(payloadPath);
        payload.exec(`
            CREATE TEMP TABLE copy AS SELECT * FROM settings;
            UPDATE copy SET handle = 'other-user';
            INSERT INTO settings SELECT * FROM copy;
        `);
        payload.close();

        await expect(h.engine.restoreUser(h.handle, fs.createReadStream(payloadPath)))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        const settings = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle: h.handle }));
        expect(settings?.user_name).toBe('kept');
    });

    test('sqlite restoreUser rejects a database whose Luker tables lack the handle column', async () => {
        if (h.kind !== 'sqlite') return;

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                { header: HEADER, body: MESSAGES });
        });
        const before = await readChat(h.engine, h.handle);
        const craftedPath = path.join(h.dataRoot, 'no-handle.sqlite');
        const crafted = new Database(craftedPath);
        for (const table of SQLITE_USER_TABLES) {
            crafted.exec(table === 'chats'
                ? 'CREATE TABLE chats (id INTEGER PRIMARY KEY, body TEXT)'
                : `CREATE TABLE ${table} (handle TEXT, doc TEXT)`);
        }
        crafted.close();

        await expect(h.engine.restoreUser(h.handle, fs.createReadStream(craftedPath)))
            .rejects.toBeInstanceOf(RestoreDumpInvalidError);
        expect(await readChat(h.engine, h.handle)).toEqual(before);
    });

    test('restoreUser round-trips quotes and backslashes byte-identical', async () => {
        if (h.kind === 'fs') return; // fs has no engine dump

        await seedQuotedValues(h.engine, h.handle);
        const before = await readQuotedValues(h.engine, h.handle);
        const dumpBuf = await streamToBuffer(await h.engine.dumpUser(h.handle));
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'MUTATED' } });
        });

        await h.engine.restoreUser(h.handle, bufferToStream(dumpBuf));

        expect(await readQuotedValues(h.engine, h.handle)).toEqual(before);
        expect(before.settings.user_name).toBe(QUOTED_VALUE);
    });

    test.each(['not a number', '12abc'])('mysql restoreUser rejects %s when the server runs without strict mode and leaves the session mode as it was', async (invalidValue) => {
        if (h.kind !== 'mysql') return; // strict mode is a mysql sql_mode

        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource({ kind: 'settings', handle: h.handle }, { doc: { user_name: 'kept' } });
        });
        const record = JSON.parse((await streamToBuffer(await h.engine.dumpUser(h.handle))).toString('utf8').trim().split('\n')[0]);
        const crafted = { ...record, params: [record.params[0], record.params[1], invalidValue] };

        // One connection, so the mode read afterwards is the restore connection's.
        const lenientEngine = new MysqlEngine({ url: h.url, poolSize: 1 });
        lenientEngine._pool.on('connection', (conn) => {
            conn.query('SET SESSION sql_mode = \'\'');
        });
        try {
            const [before] = await lenientEngine._pool.query('SELECT @@SESSION.sql_mode AS mode');
            expect(before[0].mode).toBe('');
            await expect(lenientEngine.restoreUser(h.handle, bufferToStream(Buffer.from(`${JSON.stringify(crafted)}\n`))))
                .rejects.toBeInstanceOf(RestoreDumpInvalidError);
            const [after] = await lenientEngine._pool.query('SELECT @@SESSION.sql_mode AS mode');
            expect(after[0].mode).toBe('');
        } finally {
            await lenientEngine.close();
        }
        const settings = await h.engine.withTransaction(h.handle, async (tx) =>
            tx.getResource({ kind: 'settings', handle: h.handle }));
        expect(settings?.user_name).toBe('kept');
    });

    test('mysql restoreUser keeps quotes and backslashes when the server runs NO_BACKSLASH_ESCAPES', async () => {
        if (h.kind !== 'mysql') return; // the sql_mode is mysql-specific

        await seedQuotedValues(h.engine, h.handle);
        const before = await readQuotedValues(h.engine, h.handle);
        const dumpBuf = await streamToBuffer(await h.engine.dumpUser(h.handle));

        const nbeEngine = new MysqlEngine({ url: h.url });
        nbeEngine._pool.on('connection', (conn) => {
            conn.query('SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, \',NO_BACKSLASH_ESCAPES\')');
        });
        try {
            const [modeRows] = await nbeEngine._pool.query('SELECT @@SESSION.sql_mode AS mode');
            expect(modeRows[0].mode.split(',')).toContain('NO_BACKSLASH_ESCAPES');
            await nbeEngine.restoreUser(h.handle, bufferToStream(dumpBuf));
        } finally {
            await nbeEngine.close();
        }

        expect(await readQuotedValues(h.engine, h.handle)).toEqual(before);
    });

    test('sqlite restoreUser removes stale WAL and SHM sidecars before swapping the database file', async () => {
        if (h.kind !== 'sqlite') return;
        await seedEveryTable(h.engine, h.handle, 'original');
        const dumpBuf = await streamToBuffer(await h.engine.dumpUser(h.handle));
        await seedEveryTable(h.engine, h.handle, 'overwritten');

        const dbPath = path.join(h.dirs.root, 'luker-storage.sqlite');
        fs.writeFileSync(`${dbPath}-wal`, Buffer.from('stale wal bytes'));
        fs.writeFileSync(`${dbPath}-shm`, Buffer.from('stale shm bytes'));

        await h.engine.restoreUser(h.handle, bufferToStream(dumpBuf));

        expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
        expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
        const restored = await readEveryTable(h.engine, h.handle);
        expect(restored.settings.user_name).toBe('original');
    });
});

// A single quote, a backslash and a backslash-quote: the characters a
// client-side escaper rewrites, and the ones that end a string literal when
// the server reads backslashes literally.
const QUOTED_VALUE = 'O\'Brien \\ C:\\dir\\ \\\' end';
// Stored names may not hold a backslash.
const QUOTED_NAME = 'O\'Brien';

async function seedQuotedValues(engine, handle) {
    await engine.withTransaction(handle, async (tx) => {
        await tx.putResource({ kind: 'settings', handle }, { doc: { user_name: QUOTED_VALUE } });
        await tx.putResource({ kind: 'chat', handle, charDir: 'Alice', name: QUOTED_NAME },
            { header: HEADER, body: [{ name: 'User', is_user: true, mes: QUOTED_VALUE }] });
    });
}

async function readQuotedValues(engine, handle) {
    return engine.withTransaction(handle, async (tx) => ({
        settings: await tx.getResource({ kind: 'settings', handle }),
        chat: await tx.getResource({ kind: 'chat', handle, charDir: 'Alice', name: QUOTED_NAME }),
    }));
}

/**
 * One row in each of the 9 user-data tables the engine dump writes, with
 * `tag` in every value so rows written for different accounts differ.
 */
async function seedEveryTable(engine, handle, tag) {
    const chat = { kind: 'chat', handle, charDir: 'Alice', name: 'c1' };
    const preset = { kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'p1' };
    await engine.withTransaction(handle, async (tx) => {
        await tx.putResource(chat, { header: HEADER, body: [{ name: 'User', is_user: true, mes: `${tag} 你好 🌍` }] });
        await tx.putChatState(chat, 'ns', { tag });
        await tx.putResource(preset, { doc: { tag } });
        await tx.putPresetState(preset, 'ns', { tag });
        await tx.putResource({ kind: 'world', handle, name: 'w1' }, { doc: { entries: {}, tag } });
        await tx.putResource({ kind: 'named-doc', handle, bucket: 'themes', name: 't1' }, { doc: { tag } });
        await tx.putResource({ kind: 'group', handle, id: 'g1' }, { doc: { id: 'g1', name: tag, chats: [] } });
        await tx.putResource({ kind: 'settings', handle }, { doc: { user_name: tag } });
        await tx.putResource({ kind: 'stats', handle }, { doc: { tag } });
    });
}

async function readEveryTable(engine, handle) {
    const chat = { kind: 'chat', handle, charDir: 'Alice', name: 'c1' };
    const preset = { kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'p1' };
    return engine.withTransaction(handle, async (tx) => ({
        chat: (await tx.getResource(chat))?.body,
        chatState: await tx.getChatState(chat, 'ns'),
        preset: await tx.getResource(preset),
        presetState: await tx.getPresetState(preset, 'ns'),
        world: await tx.getResource({ kind: 'world', handle, name: 'w1' }),
        namedDoc: await tx.getResource({ kind: 'named-doc', handle, bucket: 'themes', name: 't1' }),
        group: await tx.getResource({ kind: 'group', handle, id: 'g1' }),
        settings: await tx.getResource({ kind: 'settings', handle }),
        stats: await tx.getResource({ kind: 'stats', handle }),
    }));
}

async function readChat(engine, handle) {
    return engine.withTransaction(handle, async (tx) =>
        tx.getResource({ kind: 'chat', handle, charDir: 'Alice', name: 'c1' }));
}

/**
 * A source account for cross-handle restore: mysql/pg share the harness DB
 * under another handle; sqlite keeps one file per account, so it gets its own
 * engine and directory.
 */
async function makeSourceEngine(h) {
    if (h.kind !== 'sqlite') {
        return { engine: h.engine, handle: 'source-user', cleanup: () => {} };
    }
    const root = path.join(h.dataRoot, 'source-user');
    const engine = new SqliteEngine({ directoriesByHandle: () => ({ root }) });
    return { engine, handle: 'source-user', cleanup: () => engine.close() };
}
