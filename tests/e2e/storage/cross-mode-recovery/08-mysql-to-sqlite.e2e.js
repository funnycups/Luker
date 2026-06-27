// e2e/storage/cross-mode-recovery/08-mysql-to-sqlite.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → sqlite preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-mysql-to-sqlite-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'mysql', destMode: 'sqlite', specId: '08-mysql-to-sqlite', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
