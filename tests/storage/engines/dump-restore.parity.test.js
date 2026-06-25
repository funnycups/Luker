// Engine-level parity for dumpUser / restoreUser.
// Per spec §4.1: fs returns null (no engine-side dump; disk tree IS the backup).
// sqlite returns a binary stream of the .sqlite file.
// mysql / postgres return a text stream of newline-separated JSON-encoded INSERTs.
// restoreUser of the SAME kind round-trips dump+restore to recreate all user rows.

import { Readable } from 'node:stream';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

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
        // Spec §4.1 round-trip is byte-for-byte; mysql/pg restore reads the
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
});
