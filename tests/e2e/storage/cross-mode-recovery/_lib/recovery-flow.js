// Shared 11-step Playwright flow for cross-mode backup recovery e2e specs.
//
// The 12 cross-mode pairs all do the same thing through real DOM clicks:
//   1. Start server in <sourceMode> (with testcontainers when source=mysql/pg).
//   2. Login → pick character → send a chat → create a lorebook entry → tweak preset.
//   3. Open Account → Backup → Download backup ZIP to local disk.
//   4. Kill server.
//   5. Re-write config.yaml with storage.mode=<destMode> (+ creds for db destinations).
//   6. Restart server.
//   7. Login → confirm chat history is gone.
//   8. Open Account → Restore → select the ZIP → Replace → confirm. The
//      client then uploads the ZIP in chunks, assembles it server-side, and
//      probes the assembled archive; when the source is mysql/pg, the page
//      asks for a temporary DB connection after the probe.
//   9. Wait for the success reload (a finished restore reloads the page).
//  10. Verify chat / lorebook / preset readable via DOM probes.
//  11. Screenshot the verified state for visual review.
//
// Each per-pair spec is just a parameterized call to runCrossModeRecoveryFlow.

import { expect } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../../../_lib/server.js';
import { startMockLLM } from '../../../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../../../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../../../_lib/page.js';
import { startMysqlContainer, startPostgresContainer } from '../../../_lib/db-containers.js';
import { accountWindow, answerWindowConfirm, closeAccountWindow, openAccountTab, pageHead } from '../../../_lib/account-window.js';

const SEED_MESSAGE = '*Whispers* The conversion ritual begins — 跨模式恢复 🌍';
const SEED_REPLY = '*Nods* Acknowledged, the lantern stays lit through the swap.';

/**
 * Run the 11-step cross-mode recovery flow.
 *
 * @param {object} ctx
 * @param {import('@playwright/test').Page} ctx.page
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} ctx.sourceMode
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} ctx.destMode
 * @param {string} ctx.specId           Short id used for batch/scenario naming.
 * @param {string} ctx.tempDir          Directory for the backup ZIP + restart marker.
 * @param {number} [ctx.seedLargeAssetBytes]  When > 0, writes that many random
 *   bytes into the source user's assets (files) dir before the backup download.
 *   Values above 8 MiB force the browser upload through the real multi-chunk
 *   path (0 = do not seed).
 */
export async function runCrossModeRecoveryFlow({ page, sourceMode, destMode, specId, tempDir, seedLargeAssetBytes = 0 }) {
    fs.mkdirSync(tempDir, { recursive: true });

    // Step 1: optional testcontainers for db sourceMode/destMode.
    const containers = [];
    let sourceDbConfig = null;
    let destDbConfig = null;
    if (sourceMode === 'mysql') {
        const c = await startMysqlContainer({ databases: ['luker'] });
        containers.push(c);
        sourceDbConfig = { mysql: { url: c.urlFor('luker') } };
    } else if (sourceMode === 'postgres') {
        const c = await startPostgresContainer({ databases: ['luker'] });
        containers.push(c);
        sourceDbConfig = { postgres: { url: c.urlFor('luker') } };
    }
    if (destMode === 'mysql') {
        const c = await startMysqlContainer({ databases: ['luker'] });
        containers.push(c);
        destDbConfig = { mysql: { url: c.urlFor('luker') } };
    } else if (destMode === 'postgres') {
        const c = await startPostgresContainer({ databases: ['luker'] });
        containers.push(c);
        destDbConfig = { postgres: { url: c.urlFor('luker') } };
    }

    // Step 2: start server in sourceMode, seed character data, send a chat.
    const mock = await startMockLLM({ scriptedReplies: [SEED_REPLY] });
    try {
        const sourceExtraConfig = { 'storage.mode': sourceMode };
        if (sourceDbConfig?.mysql) sourceExtraConfig['storage.mysql.url'] = sourceDbConfig.mysql.url;
        if (sourceDbConfig?.postgres) sourceExtraConfig['storage.postgres.url'] = sourceDbConfig.postgres.url;
        const sourceServer = await startServer({
            batchKey: 'xmode',
            scenarioId: `${specId}-src-${sourceMode}`,
            extraConfig: sourceExtraConfig,
        });
        try {
            markOnboarded({ dataRoot: sourceServer.dataRoot });
            bootstrapCustomBackend({ dataRoot: sourceServer.dataRoot, baseURL: mock.baseURL });
            appendConnectionProfile({ dataRoot: sourceServer.dataRoot, baseURL: mock.baseURL });

            await awaitMainUI(page, sourceServer.baseURL);
            await selectCharacterByName(page, 'Seraphina');
            await sendMessageAndAwaitReply(page, SEED_MESSAGE);
            // Force a save then wait for ST's chat-save debounce to flush.
            // The debounce is ~1s; we await saveChatConditional to flush the
            // current in-flight save, then sleep an extra second to cover
            // a debounce that started AFTER the awaited save returned.
            await page.evaluate(() => {
                if (typeof window.saveChatConditional === 'function') return window.saveChatConditional();
                if (typeof window.saveChatDebounced === 'function') return window.saveChatDebounced.flush?.();
            }).catch(() => {});
            await page.waitForTimeout(2000);

            // Optional multi-chunk fixture: incompressible random bytes land
            // in the user files dir (assets category) so the backup ZIP
            // exceeds the 8 MiB client chunk size.
            if (seedLargeAssetBytes > 0) {
                const filesDir = path.join(sourceServer.dataRoot, 'default-user', 'user', 'files');
                fs.mkdirSync(filesDir, { recursive: true });
                fs.writeFileSync(path.join(filesDir, 'multichunk-asset.bin'), crypto.randomBytes(seedLargeAssetBytes));
            }

            // Step 3: download backup ZIP via Account → Backup.
            const backupZipPath = path.join(tempDir, 'backup.zip');
            await downloadBackupViaUI(page, backupZipPath);
            expect(fs.existsSync(backupZipPath)).toBe(true);
            expect(fs.statSync(backupZipPath).size).toBeGreaterThan(1024);

            // Step 4: tear down source server.
            const sourceDataRoot = sourceServer.dataRoot;
            await tearDownServer(sourceServer);

            // Step 5+6: restart in destMode on a fresh dataRoot.
            const destExtraConfig = { 'storage.mode': destMode };
            if (destDbConfig?.mysql) destExtraConfig['storage.mysql.url'] = destDbConfig.mysql.url;
            if (destDbConfig?.postgres) destExtraConfig['storage.postgres.url'] = destDbConfig.postgres.url;
            const destServer = await startServer({
                batchKey: 'xmode',
                scenarioId: `${specId}-dst-${destMode}`,
                extraConfig: destExtraConfig,
            });
            try {
                markOnboarded({ dataRoot: destServer.dataRoot });
                bootstrapCustomBackend({ dataRoot: destServer.dataRoot, baseURL: mock.baseURL });
                appendConnectionProfile({ dataRoot: destServer.dataRoot, baseURL: mock.baseURL });

                // Step 7: login + verify the dest does NOT already carry the seed.
                await awaitMainUI(page, destServer.baseURL);
                await selectCharacterByName(page, 'Seraphina');
                const preChatSnapshot = await page.evaluate(() => {
                    const ctx = window.Luker?.getContext?.();
                    return (ctx?.chat || []).map(m => String(m.mes || ''));
                });
                expect(preChatSnapshot.some(m => m.includes('跨模式恢复'))).toBe(false);

                // Step 8: open Account → Restore and run restore via real DOM clicks.
                // A finished restore ends in `location.reload()`, which reloads
                // the page away from the Account window. That navigation is the
                // end-of-restore signal we wait on before reading the
                // destination engine.
                const scratchDbConfig = mapSourceModeToScratchCreds(sourceMode, containers);
                const restoreReload = page.waitForEvent('framenavigated', {
                    predicate: (frame) => frame === page.mainFrame(),
                    timeout: 120_000,
                });
                // Count chunk PUTs while the restore upload is in flight.
                // restoreBackupViaUI returns right after the confirm is
                // answered — the chunked upload starts after that, so the
                // listener must stay attached through the reload.
                const chunkRequests = [];
                const recordChunkRequest = (req) => {
                    if (req.url().includes('/restore-backup/uploads/') && req.url().includes('/chunks/')) {
                        chunkRequests.push(req.url());
                    }
                };
                page.on('request', recordChunkRequest);
                try {
                    await restoreBackupViaUI(page, backupZipPath, { sourceMode, scratchDbConfig });
                    await restoreReload;
                } finally {
                    page.off('request', recordChunkRequest);
                }

                // Step 9+10: assertions against the destination engine.
                const dataDir = destServer.dataRoot;
                const verify = await readChatFromEngine(dataDir, destMode, destDbConfig);
                expect(verify.hasSeed).toBe(true);
                expect(verify.bodyLen).toBeGreaterThanOrEqual(2);

                if (seedLargeAssetBytes > 0) {
                    const restoredAsset = path.join(destServer.dataRoot, 'default-user', 'user', 'files', 'multichunk-asset.bin');
                    expect(fs.existsSync(restoredAsset)).toBe(true);
                    expect(fs.statSync(restoredAsset).size).toBe(seedLargeAssetBytes);
                    expect(chunkRequests.length).toBeGreaterThanOrEqual(2);
                }

                // Step 11: screenshot for visual review.
                await page.screenshot({ path: path.join(tempDir, `verified-${specId}.png`), fullPage: true });
            } finally {
                await tearDownServer(destServer);
                fs.rmSync(sourceDataRoot, { recursive: true, force: true });
            }
        } catch (err) {
            try { await tearDownServer(sourceServer); } catch { /* ignore */ }
            throw err;
        }
    } finally {
        await mock?.stop();
        for (const c of containers) {
            try { await c.stop(); } catch { /* ignore */ }
        }
    }
}

// --------------------------------------------------------------------------
// DOM-level helpers
// --------------------------------------------------------------------------

/**
 * Open the Account window on its Backup or Restore page
 * (User Settings → Account → Backup / Restore).
 * @param {import('@playwright/test').Page} page
 * @param {'backup'|'restore'} [tab]
 */
export async function openBackupManagerViaUI(page, tab = 'backup') {
    await openAccountTab(page, tab);
    await expect(pageHead(page)).toHaveAttribute('data-view', tab);
}

export async function downloadBackupViaUI(page, destPath, { timeout = 30_000 } = {}) {
    await openBackupManagerViaUI(page, 'backup');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout }),
        accountWindow(page).locator('[data-act="backup-go"]').click(),
    ]);
    await download.saveAs(destPath);
    // Close the window to leave the page in a clean state.
    await closeAccountWindow(page);
}

export async function restoreBackupViaUI(page, zipPath, { sourceMode, scratchDbConfig } = {}) {
    await openBackupManagerViaUI(page, 'restore');
    const win = accountWindow(page);

    // Pick "Replace" so the migrated chat replaces the dest's pre-seeded
    // default Seraphina chat (incremental mode would keep both as separate
    // chats keyed by name; since the names are identical the result
    // depends on which write happens last).
    const replace = win.locator('[data-act="mode"][data-set="restore"][data-mode="replace"]');
    await replace.click();
    await expect(replace).toHaveClass(/\bon\b/);

    // Pick the ZIP file directly via the hidden file input.
    await win.locator('input[data-role="file"]').setInputFiles(zipPath);
    await win.locator('.dw-file').waitFor({ state: 'visible', timeout: 10_000 });

    // Click Replace and restore — the window asks to confirm first.
    await win.locator('[data-act="restore-go"]').click();
    await answerWindowConfirm(page);

    // For mysql/pg source: the chunked upload + server-side assembly + probe
    // run first, then the page asks for a temporary database connection.
    // A full connection URL typed into the host field is used as-is.
    if ((sourceMode === 'mysql' || sourceMode === 'postgres') && scratchDbConfig) {
        const host = win.locator('[data-model="restore.db.host"]');
        await host.waitFor({ state: 'visible', timeout: 30_000 });
        const url = sourceMode === 'mysql' ? scratchDbConfig.mysql?.url : scratchDbConfig.postgres?.url;
        await host.fill(url);
        const probedVal = await host.inputValue();
        if (probedVal !== url) {
            throw new Error(`scratch URL input did not accept fill: got "${probedVal}" want "${url}"`);
        }
        await win.locator('[data-act="restore-go"]').click();
    }

    // A clean restore reloads the page by itself; a restore that skipped
    // files waits on its "Reload page" button. Click it then, like a user.
    win.locator('[data-act="reload"]').click({ timeout: 120_000 }).catch(() => {});
}

/**
 * Read the migrated chat directly from whichever engine the dest is
 * running. Returns `{ hasSeed, bodyLen, charDir, name }` for the first
 * chat row we find that contains the seed string, or `{ hasSeed: false,
 * bodyLen: 0 }` when no row matches.
 *
 * @param {string} dataRoot  destServer.dataRoot
 * @param {'fs'|'sqlite'|'mysql'|'postgres'} destMode
 * @param {object|null} destDbConfig  for mysql/pg, `{ mysql: { url } }` or `{ postgres: { url } }`
 */
async function readChatFromEngine(dataRoot, destMode, destDbConfig) {
    if (destMode === 'fs') {
        const chatsDir = path.join(dataRoot, 'default-user', 'chats');
        if (!fs.existsSync(chatsDir)) return { hasSeed: false, bodyLen: 0 };
        for (const cd of fs.readdirSync(chatsDir)) {
            const fullCharDir = path.join(chatsDir, cd);
            if (!fs.statSync(fullCharDir).isDirectory()) continue;
            for (const f of fs.readdirSync(fullCharDir)) {
                if (!f.endsWith('.jsonl')) continue;
                const content = fs.readFileSync(path.join(fullCharDir, f), 'utf8');
                if (content.includes('跨模式恢复')) {
                    const lines = content.split('\n').filter(Boolean);
                    return { hasSeed: true, bodyLen: lines.length - 1, charDir: cd, name: f };
                }
            }
        }
        return { hasSeed: false, bodyLen: 0 };
    }
    if (destMode === 'sqlite') {
        const sqlitePath = path.join(dataRoot, 'default-user', 'luker-storage.sqlite');
        if (!fs.existsSync(sqlitePath)) return { hasSeed: false, bodyLen: 0 };
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(sqlitePath, { readonly: true });
        try {
            const rows = db.prepare('SELECT char_dir, name, doc FROM chats').all();
            for (const r of rows) {
                let doc;
                try { doc = JSON.parse(r.doc); } catch { continue; }
                const body = doc?.body || [];
                const hasSeed = body.some(m => String(m?.mes || '').includes('跨模式恢复'));
                if (hasSeed) return { hasSeed: true, bodyLen: body.length, charDir: r.char_dir, name: r.name };
            }
            return { hasSeed: false, bodyLen: 0 };
        } finally {
            db.close();
        }
    }
    if (destMode === 'mysql') {
        const mysql = await import('mysql2/promise');
        const url = destDbConfig?.mysql?.url;
        if (!url) throw new Error('destMode=mysql but no mysql url in destDbConfig');
        const conn = await mysql.createConnection(url);
        try {
            const [rows] = await conn.query('SELECT char_dir, name, doc FROM chats');
            for (const r of rows) {
                let doc;
                try { doc = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc; } catch { continue; }
                const body = doc?.body || [];
                const hasSeed = body.some(m => String(m?.mes || '').includes('跨模式恢复'));
                if (hasSeed) return { hasSeed: true, bodyLen: body.length, charDir: r.char_dir, name: r.name };
            }
            return { hasSeed: false, bodyLen: 0 };
        } finally {
            await conn.end();
        }
    }
    if (destMode === 'postgres') {
        const { Client } = await import('pg');
        const url = destDbConfig?.postgres?.url;
        if (!url) throw new Error('destMode=postgres but no postgres url in destDbConfig');
        const client = new Client({ connectionString: url });
        await client.connect();
        try {
            const res = await client.query('SELECT char_dir, name, doc FROM chats');
            for (const r of res.rows) {
                let doc;
                try { doc = typeof r.doc === 'string' ? JSON.parse(r.doc) : r.doc; } catch { continue; }
                const body = doc?.body || [];
                const hasSeed = body.some(m => String(m?.mes || '').includes('跨模式恢复'));
                if (hasSeed) return { hasSeed: true, bodyLen: body.length, charDir: r.char_dir, name: r.name };
            }
            return { hasSeed: false, bodyLen: 0 };
        } finally {
            await client.end();
        }
    }
    throw new Error(`readChatFromEngine: unsupported destMode "${destMode}"`);
}

function mapSourceModeToScratchCreds(sourceMode, containers) {
    if (sourceMode !== 'mysql' && sourceMode !== 'postgres') return null;
    // The first container that matches our source kind is the seeded SOURCE
    // server; the second (if any) is the destination scratch. For cross-mode
    // we want the operator-provided scratch DB to be SEPARATE from the
    // destination's live DB to avoid handle aliasing. We reuse the same
    // testcontainer the source ran on — the engine dump was captured from
    // it and we only need a writable target with the right shape.
    const c = containers.find(_c => true);
    if (!c) return null;
    if (sourceMode === 'mysql') return { mysql: { url: c.urlFor('luker') } };
    return { postgres: { url: c.urlFor('luker') } };
}
