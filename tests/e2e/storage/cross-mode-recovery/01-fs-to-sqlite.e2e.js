// e2e/storage/cross-mode-recovery/01-fs-to-sqlite.e2e.js
//
// End-to-end test for the fs → sqlite cross-mode recovery flow. Uses real
// Playwright + a real server + the real Backup Manager UI: NO mocks except
// the LLM (per the LLM-is-only-legitimate-mock convention).
//
// No docker required for this pair — both engines are file-based.

import { test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCrossModeRecoveryFlow } from './_lib/recovery-flow.js';

test('cross-mode recovery: fs → sqlite preserves chat through engine swap', async ({ page }) => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xmode-fs-to-sqlite-'));
    try {
        await runCrossModeRecoveryFlow({
            page,
            sourceMode: 'fs',
            destMode: 'sqlite',
            specId: '01-fs-to-sqlite',
            tempDir,
        });
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
});
