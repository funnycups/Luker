// e2e/storage/cross-mode-recovery/05-fs-to-postgres.e2e.js

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → postgres preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-fs-to-postgres-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'fs', destMode: 'postgres', specId: '05-fs-to-postgres', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
