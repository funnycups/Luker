// e2e/storage/cross-mode-recovery/06-postgres-to-fs.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → fs preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-postgres-to-fs-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'postgres', destMode: 'fs', specId: '06-postgres-to-fs', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
