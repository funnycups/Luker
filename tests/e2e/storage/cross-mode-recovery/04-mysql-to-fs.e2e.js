// e2e/storage/cross-mode-recovery/04-mysql-to-fs.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → fs preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-mysql-to-fs-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'mysql', destMode: 'fs', specId: '04-mysql-to-fs', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
