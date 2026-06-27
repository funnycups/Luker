import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gcScratch } from '../../../src/storage/migration/gc-scratch.js';
import { SCRATCH_HANDLE_PREFIX } from '../../../src/storage/engine-backup-entries.js';

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'luker-gc-'));
}

function makeScratch(root, name, ageMs) {
    const dir = path.join(root, '_storage-migrations', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'x');
    if (ageMs != null) {
        const mtime = new Date(Date.now() - ageMs);
        fs.utimesSync(dir, mtime, mtime);
    }
    return dir;
}

describe('gcScratch', () => {
    test('removes _xrestore_ dirs older than maxAgeMs', async () => {
        const root = makeRoot();
        try {
            const oldDir = makeScratch(root, `${SCRATCH_HANDLE_PREFIX}old`, 25 * 3600 * 1000);
            const freshDir = makeScratch(root, `${SCRATCH_HANDLE_PREFIX}fresh`, 1 * 1000);
            const counts = await gcScratch({ dataRoot: root, maxAgeMs: 24 * 3600 * 1000 });
            expect(counts.scanned).toBe(2);
            expect(counts.removed).toBe(1);
            expect(counts.kept).toBe(1);
            expect(fs.existsSync(oldDir)).toBe(false);
            expect(fs.existsSync(freshDir)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('leaves non-scratch directories untouched', async () => {
        const root = makeRoot();
        try {
            const realSnapshotDir = path.join(root, '_storage-migrations', '2026-01-01T00-00-00-000Z-realuser');
            fs.mkdirSync(realSnapshotDir, { recursive: true });
            fs.writeFileSync(path.join(realSnapshotDir, 'data.txt'), 'x');
            const oldMtime = new Date(Date.now() - 100 * 24 * 3600 * 1000);
            fs.utimesSync(realSnapshotDir, oldMtime, oldMtime);

            const counts = await gcScratch({ dataRoot: root, maxAgeMs: 24 * 3600 * 1000 });
            // Snapshot dirs do NOT start with _xrestore_; they must not appear in scanned.
            expect(counts.scanned).toBe(0);
            expect(fs.existsSync(realSnapshotDir)).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('missing migrations root is a no-op', async () => {
        const root = makeRoot();
        try {
            const counts = await gcScratch({ dataRoot: root });
            expect(counts.scanned).toBe(0);
            expect(counts.removed).toBe(0);
            expect(counts.errors).toBe(0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('missing dataRoot returns immediately', async () => {
        const counts = await gcScratch({});
        expect(counts.scanned).toBe(0);
    });
});
