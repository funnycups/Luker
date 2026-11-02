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

    test('chat with garbage JSON line exposes the selected line without altering stored data', async () => {
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

        const damaged = fs.readFileSync(fp);
        await expect(repo.get(h.handle, 'TestChar', 'chat1')).rejects.toThrow(/chat1\.jsonl line 2: invalid JSON/);
        expect(fs.readFileSync(fp)).toEqual(damaged);
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
        // Valid JSON state values are returned without shape coercion.
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
