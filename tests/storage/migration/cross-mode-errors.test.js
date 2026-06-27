import {
    CrossModeScratchCredsRequiredError,
    CrossModeScratchConnectionError,
    CrossModeConversionFailedError,
} from '../../../src/storage/migration/cross-mode-errors.js';

describe('CrossModeScratchCredsRequiredError', () => {
    test('mysql case: name, kind, requiredCreds, message', () => {
        const err = new CrossModeScratchCredsRequiredError('mysql');
        expect(err.name).toBe('CrossModeScratchCredsRequiredError');
        expect(err.kind).toBe('mysql');
        expect(err.requiredCreds).toBe('mysql');
        expect(err.message).toMatch(/mysql engine/);
        expect(err.message).toMatch(/scratch mysql connection/);
        expect(err).toBeInstanceOf(Error);
    });

    test('postgres case: kind and requiredCreds reflect postgres', () => {
        const err = new CrossModeScratchCredsRequiredError('postgres');
        expect(err.kind).toBe('postgres');
        expect(err.requiredCreds).toBe('postgres');
        expect(err.message).toMatch(/postgres engine/);
    });
});

describe('CrossModeScratchConnectionError', () => {
    test('preserves the underlying driver error as cause', () => {
        const cause = new Error('ECONNREFUSED 127.0.0.1:3306');
        const err = new CrossModeScratchConnectionError('mysql', cause);
        expect(err.name).toBe('CrossModeScratchConnectionError');
        expect(err.kind).toBe('mysql');
        expect(err.cause).toBe(cause);
        expect(err.message).toMatch(/Cannot connect to scratch mysql DB/);
        expect(err.message).toMatch(/ECONNREFUSED/);
    });

    test('non-Error cause is stringified into the message', () => {
        const err = new CrossModeScratchConnectionError('postgres', 'plain string failure');
        expect(err.cause).toBe('plain string failure');
        expect(err.message).toMatch(/plain string failure/);
    });
});

describe('CrossModeConversionFailedError', () => {
    test('rollback: ok — message reports clean restore', () => {
        const cause = new Error('chat verify mismatch for A::c1');
        const err = new CrossModeConversionFailedError(cause, { rollback: 'ok', snapshotPath: '/tmp/snap-1' });
        expect(err.name).toBe('CrossModeConversionFailedError');
        expect(err.cause).toBe(cause);
        expect(err.rollback).toBe('ok');
        expect(err.rollbackError).toBeNull();
        expect(err.snapshotPath).toBe('/tmp/snap-1');
        expect(err.message).toMatch(/chat verify mismatch/);
        expect(err.message).toMatch(/Live data restored from snapshot/);
    });

    test('rollback: partial — message names snapshotPath and rollback error', () => {
        const cause = new Error('original failure');
        const rbErr = new Error('rmSync EACCES');
        const err = new CrossModeConversionFailedError(cause, {
            rollback: 'partial',
            rollbackError: rbErr,
            snapshotPath: '/tmp/snap-2',
        });
        expect(err.rollback).toBe('partial');
        expect(err.rollbackError).toBe(rbErr);
        expect(err.snapshotPath).toBe('/tmp/snap-2');
        expect(err.message).toMatch(/PARTIAL ROLLBACK/);
        expect(err.message).toMatch(/\/tmp\/snap-2/);
        expect(err.message).toMatch(/rmSync EACCES/);
    });

    test('rollback: merge-no-snapshot — message warns about partial state', () => {
        const err = new CrossModeConversionFailedError(new Error('mid-extract io error'), {
            rollback: 'merge-no-snapshot',
        });
        expect(err.rollback).toBe('merge-no-snapshot');
        expect(err.snapshotPath).toBeNull();
        expect(err.message).toMatch(/Merge mode took no snapshot/);
        expect(err.message).toMatch(/partial state/);
    });

    test('rollback: partial with null snapshotPath falls back to placeholder', () => {
        const err = new CrossModeConversionFailedError(new Error('x'), {
            rollback: 'partial',
            rollbackError: new Error('y'),
        });
        expect(err.message).toMatch(/snapshot path unknown/);
    });
});
