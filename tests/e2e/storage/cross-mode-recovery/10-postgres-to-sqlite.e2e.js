// e2e/storage/cross-mode-recovery/10-postgres-to-sqlite.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: postgres → sqlite preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-postgres-to-sqlite-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'postgres', destMode: 'sqlite', specId: '10-postgres-to-sqlite', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
