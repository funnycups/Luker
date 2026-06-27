// e2e/storage/cross-mode-recovery/03-fs-to-mysql.e2e.js
//
// Requires Docker (testcontainers spins up a real mysql:8.0).

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → mysql preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-fs-to-mysql-'));
    try {
        await runCrossModeRecoveryFlow({
            page, sourceMode: 'fs', destMode: 'mysql', specId: '03-fs-to-mysql', tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
