// e2e/storage/cross-mode-recovery/09-sqlite-to-postgres.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: sqlite → postgres preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-sqlite-to-postgres-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'sqlite', destMode: 'postgres', specId: '09-sqlite-to-postgres', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
