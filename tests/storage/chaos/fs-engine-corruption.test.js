// Chaos: documents the FsEngine's behavior when on-disk files are manually
// mangled (garbage JSON in chat body line, `null` in settings.json, an array
// at a sidecar root, a world file with no `entries` key). The point is to
// catalog the EXACT current contract — not to validate "the right" behavior —
// so when someone later changes the handlers, this catalog flags it. These
// scenarios only apply to the filesystem layout; SqliteEngine stores JSON in
// columns and can't simulate the same on-disk damage.
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { ChatRepo } from '../../../src/storage/repositories/chat-repo.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { WorldInfoRepo } from '../../../src/storage/repositories/world-info-repo.js';

const [{ make: makeFs }] = CONTRACT_HARNESSES;

describe('FS engine corruption recovery', () => {
    let h;
    beforeEach(async () => { h = await makeFs(); });
    afterEach(() => h.cleanup());

    test('chat with garbage JSON line in body returns null (corruption is masked, no throw)', async () => {
        // Contract (ae48dcab6 "chat.get returns null on corrupt/non-conformant
        // docs across all engines"): the chat handler parses the JSONL file
        // line by line; any per-line parse failure collapses the whole
        // record to `null` rather than throwing. Handler-side try/catch
        // in fs-engine-transaction.js masks the SyntaxError so callers
        // uniformly see "no chat" instead of an exception that varies by
        // corruption type.
        //
        // Downstream ChatRepo.append/patch treats null the same as a
        // deleted / never-existed record, which is the correct failure
        // mode for a partially-corrupted file — the alternative (bubble
        // SyntaxError) makes every read path defensive.
        const repo = new ChatRepo({ engine: h.engine });
        await repo.save(
            h.handle, 'TestChar', 'chat1',
            { chat_metadata: { foo: 'bar' }, user_name: 'U' },
            [{ mes: 'hi' }],
            null,
        );
        const fp = path.join(h.dirs.chats, 'TestChar', 'chat1.jsonl');
        const text = fs.readFileSync(fp, 'utf-8');
        const lines = text.split('\n').filter((l) => l.length > 0);
        // Insert a garbage line between the header and the body message.
        lines.splice(1, 0, '{not valid json');
        fs.writeFileSync(fp, lines.join('\n') + '\n');

        expect(await repo.get(h.handle, 'TestChar', 'chat1')).toBeNull();
    });

    test('settings.json containing literal "null" round-trips to JS null', async () => {
        // settings handler is `JSON.parse(raw)` with no shape guard, so
        // writing the string "null" hands the caller back JS null. Repo.get
        // doesn't add any normalization either.
        const repo = new SettingsRepo({ engine: h.engine });
        const fp = path.join(h.dirs.root, 'settings.json');
        fs.mkdirSync(h.dirs.root, { recursive: true });
        fs.writeFileSync(fp, 'null');
        const got = await repo.get(h.handle);
        expect(got).toBeNull();
    });

    test('chat sidecar with array root is returned verbatim as an array', async () => {
        // The chat sidecar handler is bare `JSON.parse` with the only guard
        // being a try/catch that returns null on SyntaxError. A successfully
        // parsed array is therefore returned as-is — this is the current
        // contract, even though every legitimate caller treats sidecars as
        // plain objects. If a future change adds an `isObjectLike` guard,
        // this test flips to `expect(got).toBeNull()`.
        const repo = new ChatRepo({ engine: h.engine });
        await repo.save(
            h.handle, 'TestChar', 'chat1',
            { chat_metadata: {}, user_name: 'U' },
            [],
            null,
        );
        const sidecarPath = path.join(h.dirs.chats, 'TestChar', 'chat1.luker-state.bad.json');
        fs.writeFileSync(sidecarPath, '[1, 2, 3]');

        const got = await repo.getState(h.handle, 'TestChar', 'chat1', 'bad');
        expect(Array.isArray(got)).toBe(true);
        expect(got).toEqual([1, 2, 3]);
    });

    test('world file with no entries key is still returned as the parsed object', async () => {
        // The world handler only rejects non-object roots and parse errors; it
        // does not enforce the `entries` invariant on read (only on write via
        // WorldInfoRepo.save). A legacy file that loses its entries key is
        // surfaced as-is so a UI / migration tool can decide what to do.
        const repo = new WorldInfoRepo({ engine: h.engine });
        const fp = path.join(h.dirs.worlds, 'X.json');
        fs.mkdirSync(h.dirs.worlds, { recursive: true });
        fs.writeFileSync(fp, JSON.stringify({ randomKey: 'value' }));
        const got = await repo.get(h.handle, 'X');
        expect(got).toEqual({ randomKey: 'value' });
    });
});
