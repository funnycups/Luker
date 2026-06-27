// e2e/storage/cross-mode-recovery/07-sqlite-to-mysql.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → mysql preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-sqlite-to-mysql-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'sqlite', destMode: 'mysql', specId: '07-sqlite-to-mysql', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
