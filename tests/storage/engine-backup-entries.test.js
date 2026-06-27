import { ENGINE_META_ENTRY, ENGINE_DUMP_ENTRY, SCRATCH_HANDLE_PREFIX } from '../../src/storage/engine-backup-entries.js';

// These three constants are read by multiple modules across the storage,
// endpoint, and migration trees. A silent rename anywhere would corrupt
// backup ZIPs (writer/reader mismatch) or stop the gc sweep from
// recognizing its targets. Lock the literal values so any future rename
// must update every consumer in lockstep.
describe('engine-backup-entries', () => {
    test('exports stable sentinel filenames', () => {
        expect(ENGINE_META_ENTRY).toBe('_engine_meta.json');
        expect(ENGINE_DUMP_ENTRY).toBe('_engine_dump.bin');
    });

    test('SCRATCH_HANDLE_PREFIX is the underscore-leading namespace', () => {
        expect(SCRATCH_HANDLE_PREFIX).toBe('_xrestore_');
        // The leading underscore is the contract that keeps scratch handles
        // from colliding with real user handles. If a future rename drops
        // the underscore, fix gc-scratch.js + cross-mode-restore.js first.
        expect(SCRATCH_HANDLE_PREFIX.startsWith('_')).toBe(true);
    });
});
