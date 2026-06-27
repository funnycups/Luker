// e2e/storage/cross-mode-recovery/02-sqlite-to-fs.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → fs preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-sqlite-to-fs-'));
    try {
        await runCrossModeRecoveryFlow({
            page,
            sourceMode: 'sqlite',
            destMode: 'fs',
            specId: '02-sqlite-to-fs',
            tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
