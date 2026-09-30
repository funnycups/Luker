// e2e/storage/cross-mode-recovery/13-fs-to-fs-multichunk.e2e.js
//
// Same-engine fs → fs restore whose backup ZIP carries a 20 MiB
// incompressible asset, forcing the browser upload through the real
// multi-chunk path (8 MiB chunks → 3 PUTs). Real Playwright + real server +
// real Backup Manager UI; the only mock is the LLM.

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('backup restore: fs → fs round-trips a multi-chunk archive', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-fs-multichunk-'));
    try {
        await runCrossModeRecoveryFlow({
            page,
            sourceMode: 'fs',
            destMode: 'fs',
            specId: '13-fs-multichunk',
            tempDir,
            seedLargeAssetBytes: 20 * 1024 * 1024,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
