// Chaos: the read-only guard fires in `assertWritable()` at the synchronous
// prefix of each repo write — so a write that already entered its async
// pipeline before `setReadOnly(true)` runs through. Writes scheduled AFTER
// the flip throw `StorageReadOnlyError` deterministically, even when many
// of them race. Reads must keep working unconditionally because the flag
// only freezes the source surface during migration.
//
// Parameterized over both engines: the contract is engine-agnostic since the
// guard lives in the Repo layer, but we want explicit coverage so the matrix
// stays honest if the guard ever migrates down into an engine.
import { CONTRACT_HARNESSES } from '../harness/contract-harness.js';
import { SettingsRepo } from '../../../src/storage/repositories/settings-repo.js';
import { setReadOnly } from '../../../src/storage/read-only-mode.js';
import { StorageReadOnlyError } from '../../../src/storage/errors.js';

describe.each(CONTRACT_HARNESSES)('READ_ONLY under load on $name', ({ make }) => {
    let h;
    beforeEach(async () => { h = await make(); });
    afterEach(() => { setReadOnly(false); h.cleanup(); });

    test('in-flight write started before the flip completes; next write throws', async () => {
        const repo = new SettingsRepo({ engine: h.engine });

        // Calling `save` synchronously runs `assertWritable()` at the top of
        // the async function body BEFORE awaiting the engine. By the time
        // setReadOnly(true) executes, the in-flight write is already past
        // the guard, so it must settle successfully.
        const inFlight = repo.save(h.handle, { x: 1 });
        setReadOnly(true);
        await inFlight;
        expect(await repo.get(h.handle)).toEqual({ x: 1 });

        // Now every subsequent write is gated.
        await expect(repo.save(h.handle, { x: 2 }))
            .rejects.toBeInstanceOf(StorageReadOnlyError);
    });

    test('reads remain available when read-only', async () => {
        const repo = new SettingsRepo({ engine: h.engine });
        await repo.save(h.handle, { x: 42 });
        setReadOnly(true);
        expect(await repo.get(h.handle)).toEqual({ x: 42 });
    });

    test('concurrent writes after the flip all reject with StorageReadOnlyError', async () => {
        const repo = new SettingsRepo({ engine: h.engine });
        setReadOnly(true);
        const promises = Array.from({ length: 10 }, (_, i) => repo.save(h.handle, { x: i }));
        const results = await Promise.allSettled(promises);
        for (const r of results) {
            expect(r.status).toBe('rejected');
            expect(r.reason).toBeInstanceOf(StorageReadOnlyError);
        }
    });
});
