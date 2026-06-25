// Engine-level parity for deleteUser(handle). Per design spec §4.1 / §5.3,
// the contract is mode-asymmetric:
//   mysql / postgres  : engine.deleteUser performs a transactional DELETE
//                       sweep across every Repo-backed table; any subsequent
//                       read for the handle MUST return null.
//   fs / sqlite       : engine.deleteUser is a NO-OP — all of a user's data
//                       lives in dirs.root (and dirs.root/luker-storage.sqlite
//                       for sqlite), and the admin /delete handler's
//                       `purge=true` branch is the single, explicit owner
//                       of removing that directory. The endpoint-level
//                       parity test at users-admin-delete.parity.test.js
//                       exercises the dir-rm path; here we only verify that
//                       deleteUser is callable + returns void without
//                       throwing (idempotent semantics).
//
// Two tests run per engine:
//   1. Single-chat probe — fs/sqlite: deleteUser is a no-op, chat survives.
//      mysql/pg: chat row is gone.
//   2. All-tables probe — fs/sqlite: every row survives (no-op contract).
//      mysql/pg: every Repo-backed table is empty for the handle.

import fs from 'node:fs';
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';

describe.each(CONTRACT_HARNESSES)('engine.deleteUser on $name', ({ make }) => {
    let h;

    beforeEach(async () => {
        h = await make();
        if (typeof h.engine.ping === 'function') {
            await h.engine.ping(h.handle);
        }
    });

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    test('single-chat probe: db engines wipe the row, fs/sqlite leave it intact (no-op contract)', async () => {
        // Write a chat through the engine so the user has at least one resource.
        // NB: the chat handler's put() reads record.header / record.body /
        // record.integrity directly (see fs-engine-transaction.js
        // registerChatHandler), not record.doc.{header,body}, so we pass the
        // flat record shape used throughout the existing engine tests.
        await h.engine.withTransaction(h.handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' },
                {
                    header: { user_name: 'tester', character_name: 'Alice', chat_metadata: {} },
                    body: [{ name: 'User', is_user: true, mes: 'hi' }],
                    integrity: 'INT0',
                    updatedAt: 1,
                    createdAt: 1,
                },
            );
        });

        // Must not throw on any engine. Idempotent semantics: a second call
        // would also no-op (fs/sqlite) or DELETE-zero-rows (mysql/pg).
        await h.engine.deleteUser(h.handle);

        if (h.kind === 'fs' || h.kind === 'sqlite') {
            // No-op contract: the user dir (and sqlite db) still exist,
            // and the chat the test wrote above is still readable.
            expect(fs.existsSync(h.dirs.root)).toBe(true);
            const got = await h.engine.withTransaction(h.handle, (tx) =>
                tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
            expect(got).not.toBeNull();
        } else {
            // mysql/postgres: the chat row was transactionally DELETEd; a
            // subsequent read returns null.
            const got = await h.engine.withTransaction(h.handle, (tx) =>
                tx.getResource({ kind: 'chat', handle: h.handle, charDir: 'Alice', name: 'c1' }));
            expect(got).toBeNull();
        }
    });

    test('all-tables probe: db engines wipe every Repo-backed table, fs/sqlite leave them intact', async () => {
        const handle = h.handle;
        // Write at least one row to every user-data table inside one
        // transaction. The chat resource uses the flat
        // {header, body, integrity} shape because the chat handler reads
        // those fields directly (record.header etc.); every other handler
        // reads record.doc, so the rest are nested under { doc: ... }.
        // tx.putChatState / tx.putPresetState are first-class methods on
        // every engine's transaction class — they take the parent key,
        // a namespace string, and a plain JSON doc.
        await h.engine.withTransaction(handle, async (tx) => {
            await tx.putResource(
                { kind: 'chat', handle, charDir: 'Alice', name: 'c1' },
                {
                    header: { user_name: 'tester', character_name: 'Alice', chat_metadata: {} },
                    body: [{ name: 'User', is_user: true, mes: 'hi' }],
                    integrity: 'INT0',
                    updatedAt: 1,
                    createdAt: 1,
                },
            );
            await tx.putChatState(
                { kind: 'chat', handle, charDir: 'Alice', name: 'c1' },
                'ns1',
                { foo: 'bar' },
            );

            await tx.putResource(
                { kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'p1' },
                { doc: { temperature: 0.5 } },
            );
            await tx.putPresetState(
                { kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'p1' },
                'ns',
                { v: 1 },
            );

            await tx.putResource(
                { kind: 'world', handle, name: 'w1' },
                { doc: { entries: {} } },
            );

            await tx.putResource(
                { kind: 'named-doc', handle, bucket: 'themes', name: 't1' },
                { doc: { accent: '#abc' } },
            );

            await tx.putResource(
                { kind: 'group', handle, id: 'g1' },
                { doc: { id: 'g1', name: 'Test', chats: [] } },
            );

            await tx.putResource(
                { kind: 'settings', handle },
                { doc: { user_name: 'test' } },
            );

            await tx.putResource(
                { kind: 'stats', handle },
                { doc: { totalChats: 0 } },
            );
        });

        // Sanity: at least one resource we just wrote is visible BEFORE
        // deleteUser. This guards against the "test silently writes
        // nothing then probes nothing" failure mode.
        const beforeDelete = await h.engine.withTransaction(handle, (tx) =>
            tx.getResource({ kind: 'chat', handle, charDir: 'Alice', name: 'c1' }));
        expect(beforeDelete).not.toBeNull();

        await h.engine.deleteUser(handle);

        // Probe every Repo-backed resource type after deleteUser. The
        // expected post-state is mode-dependent per the spec.
        const probes = await h.engine.withTransaction(handle, async (tx) => {
            const out = {};
            out.chat = await tx.getResource({ kind: 'chat', handle, charDir: 'Alice', name: 'c1' });
            out.preset = await tx.getResource({ kind: 'preset', handle, dirKey: 'openAI_Settings', name: 'p1' });
            out.world = await tx.getResource({ kind: 'world', handle, name: 'w1' });
            out.namedDoc = await tx.getResource({ kind: 'named-doc', handle, bucket: 'themes', name: 't1' });
            out.group = await tx.getResource({ kind: 'group', handle, id: 'g1' });
            out.settings = await tx.getResource({ kind: 'settings', handle });
            out.stats = await tx.getResource({ kind: 'stats', handle });
            return out;
        });

        if (h.kind === 'fs' || h.kind === 'sqlite') {
            // No-op contract: every row we wrote above is still readable.
            // The endpoint-level test at users-admin-delete.parity.test.js
            // exercises the dir-rm path that actually wipes this data
            // when the admin issues `purge=true`.
            expect(probes.chat).not.toBeNull();
            expect(probes.preset).not.toBeNull();
            expect(probes.world).not.toBeNull();
            expect(probes.namedDoc).not.toBeNull();
            expect(probes.group).not.toBeNull();
            expect(probes.settings).not.toBeNull();
            expect(probes.stats).not.toBeNull();
        } else {
            // mysql/postgres: every row is wiped. The wrapped-object
            // expectation (`{ [k]: v }` toEqual `{ [k]: null }`) names
            // the failing resource in the Jest diff instead of dumping
            // an unlabelled v.
            for (const [k, v] of Object.entries(probes)) {
                expect({ [k]: v }).toEqual({ [k]: null });
            }
        }
    });
});
