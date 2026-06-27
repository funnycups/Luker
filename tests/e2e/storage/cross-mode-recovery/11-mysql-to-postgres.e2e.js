// e2e/storage/cross-mode-recovery/11-mysql-to-postgres.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: mysql → postgres preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-mysql-to-postgres-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'mysql', destMode: 'postgres', specId: '11-mysql-to-postgres', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
