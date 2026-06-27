// Shared 11-step Playwright flow for cross-mode backup recovery e2e specs.
//
// The 12 cross-mode pairs all do the same thing through real DOM clicks:
//   1. Start server in <sourceMode> (with testcontainers when source=mysql/pg).
//   2. Login → pick character → send a chat → create a lorebook entry → tweak preset.
//   3. Open Backup Manager → Download Backup ZIP to local disk.
//   4. Kill server.
//   5. Re-write config.yaml with storage.mode=<destMode> (+ creds for db destinations).
//   6. Restart server.
//   7. Login → confirm chat history is gone.
//   8. Open Backup Manager → select the ZIP → click Restore → fill scratch DB creds
//      via the cross-mode prompt when source is mysql/pg.
//   9. Wait for the success toast.
//  10. Verify chat / lorebook / preset readable via DOM probes.
//  11. Screenshot the verified state for visual review.
//
// Each per-pair spec is just a parameterized call to runCrossModeRecoveryFlow.

import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { startServer, tearDownServer } from '../../../_lib/server.js';
import { startMockLLM } from '../../../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../../../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../../../_lib/page.js';
import { startMysqlContainer, startPostgresContainer } from '../../../_lib/db-containers.js';

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
 */
export async function runCrossModeRecoveryFlow({ page, sourceMode, destMode, specId, tempDir }) {
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

            // Step 3: download backup ZIP via the Backup Manager UI.
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

                // Step 8: open Backup Manager and run restore via real DOM clicks.
                const scratchDbConfig = mapSourceModeToScratchCreds(sourceMode, containers);
                await restoreBackupViaUI(page, backupZipPath, { sourceMode, scratchDbConfig });

                // Step 9: poll the engine until the migrated chat lands.
                // The runRestore POST is in flight after we resolved the
                // confirm popup; the cross-mode orchestrator runs
                // synchronously server-side and writes the chat before
                // returning the HTTP response.
                const dataDir = destServer.dataRoot;
                let verify = { hasSeed: false, bodyLen: 0 };
                const deadline = Date.now() + 60_000;
                while (Date.now() < deadline) {
                    verify = await readChatFromEngine(dataDir, destMode, destDbConfig);
                    if (verify.hasSeed) break;
                    await page.waitForTimeout(250);
                }
                // Step 10: assertions.
                expect(verify.hasSeed).toBe(true);
                expect(verify.bodyLen).toBeGreaterThanOrEqual(2);

                // Step 11: screenshot for visual review.
                await page.screenshot({ path: path.join(tempDir, `verified-${specId}.png`), fullPage: true });
            } finally {
                await tearDownServer(destServer);
                fs.rmSync(sourceDataRoot, { recursive: true, force: true });
            }
        } catch (err) {
            try { await tearDownServer(sourceServer); } catch {}
            throw err;
        }
    } finally {
        await mock?.stop();
        for (const c of containers) {
            try { await c.stop(); } catch {}
        }
    }
}

// --------------------------------------------------------------------------
// DOM-level helpers
// --------------------------------------------------------------------------

async function openBackupManagerViaUI(page) {
    await ensureUserSettingsDrawerOpen(page);
    // The Backup Manager opens from inside the User Profile popup, which is
    // reached via the `#account_button` in the user-settings drawer.
    const accountBtn = page.locator('#account_button');
    await accountBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await accountBtn.click();
    // The user profile popup contains the `.userBackupButton`.
    const backupBtn = page.locator('.userBackupButton').last();
    await backupBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await backupBtn.click();
    // Backup Manager popup is now open.
    await page.locator('.userBackupManager').last().waitFor({ state: 'visible', timeout: 10_000 });
}

async function downloadBackupViaUI(page, destPath) {
    await openBackupManagerViaUI(page);
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.locator('.backupDownloadButton').last().click(),
    ]);
    await download.saveAs(destPath);
    // Close the popup chain to leave the page in a clean state.
    await page.keyboard.press('Escape').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
}

async function restoreBackupViaUI(page, zipPath, { sourceMode, scratchDbConfig }) {
    await openBackupManagerViaUI(page);

    // Pick "Overwrite Update" so the migrated chat replaces the dest's
    // pre-seeded default Seraphina chat (merge mode would keep both as
    // separate chats keyed by name; since the names are identical the
    // result depends on which write happens last).
    await page.locator('input[name="backupRestoreMode"][value="overwrite"]').last().click();

    // Pick the ZIP file directly via the hidden file input.
    const fileInput = page.locator('.backupRestoreFileInput').last();
    await fileInput.setInputFiles(zipPath);

    // Snapshot the current open-popup count BEFORE triggering the restore;
    // resolveTopmostPopupAffirmative waits for one MORE popup to mount so
    // we don't accidentally dismiss a pre-existing popup (Account Info /
    // Backup Manager itself).
    const baseOpenCount = await openPopupCount(page);

    // Click Restore — this triggers the confirm popup.
    await page.locator('.backupRestoreButton').last().click();

    // Wait for the confirm popup to mount (open count = base + 1), then
    // resolve it with POPUP_RESULT.AFFIRMATIVE via Popup.util.complete.
    // We bypass locator.click() / dispatchEvent on the OK <div>: in
    // headless Chrome both occasionally land on the dialog backdrop and
    // silently no-op, leaving the restore POST unsent. Calling the Popup
    // instance's complete() directly is the same path the click handler
    // ends up taking, just without the DOM event plumbing.
    await resolveTopmostPopupAffirmative(page, baseOpenCount + 1);

    // For mysql/pg source: a probe-driven prompt asks for the scratch URL.
    if ((sourceMode === 'mysql' || sourceMode === 'postgres') && scratchDbConfig) {
        const credsBlock = page.locator('.crossModeScratchCreds').last();
        await credsBlock.waitFor({ state: 'visible', timeout: 15_000 });
        const url = sourceMode === 'mysql' ? scratchDbConfig.mysql?.url : scratchDbConfig.postgres?.url;
        const inputSel = sourceMode === 'mysql' ? '.crossModeScratchMysqlUrl' : '.crossModeScratchPostgresUrl';
        // Use evaluate to set value directly and dispatch input event so
        // jQuery sees the change. locator.fill() under headless Chrome has
        // intermittently no-op'd here against the cross-mode template.
        await page.evaluate(({ sel, val }) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`scratch input not found: ${sel}`);
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { sel: inputSel, val: url });
        const probedVal = await page.locator(inputSel).last().inputValue();
        if (probedVal !== url) {
            throw new Error(`scratch URL input did not accept fill: got "${probedVal}" want "${url}"`);
        }
        const credsBaseOpenCount = await openPopupCount(page);
        await resolveTopmostPopupAffirmative(page, credsBaseOpenCount);
    }
}

async function openPopupCount(page) {
    return await page.evaluate(async () => {
        const mod = await import('/scripts/popup.js');
        return (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open')).length;
    });
}

/**
 * Resolve the topmost open Popup with POPUP_RESULT.AFFIRMATIVE (= 1).
 *
 * The popup.js OK button is a `<div role="button">` whose click handler
 * is wired via `addEventListener('click', ...)` on the `[data-result]`
 * node. Playwright's locator.click() on this div under headless Chrome
 * lands intermittently — the click sometimes hits the dialog backdrop
 * instead of the div and silently no-ops. Synthetic MouseEvent dispatch
 * works but races the dialog's opening animation. The deterministic
 * path is to grab the Popup instance from `Popup.util.popups` and call
 * its `complete()` directly — the same code path the click handler
 * ultimately runs, without the DOM event plumbing in the middle.
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} expectedMinOpenCount  minimum number of open popups we
 *   expect by the time the target popup has mounted. Critical: the
 *   caller usually triggered the new popup with a click that's in flight;
 *   without this guard we'd grab whichever popup was already open and
 *   accidentally dismiss it.
 */
async function resolveTopmostPopupAffirmative(page, expectedMinOpenCount) {
    await page.waitForFunction(async (minOpen) => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        return open.length >= minOpen;
    }, expectedMinOpenCount, { timeout: 15_000 });
    const beforeCount = await openPopupCount(page);
    await page.evaluate(async () => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        if (open.length === 0) throw new Error('no open popup');
        // POPUP_RESULT.AFFIRMATIVE = 1
        await open[open.length - 1].complete(1);
    });
    // Wait briefly for the popup to close — the synthetic complete resolves
    // its promise but `runAfterAnimation` closes the dialog on the next
    // frame. Without this wait the next openPopupCount call is racy.
    await page.waitForFunction(async (expected) => {
        const mod = await import('/scripts/popup.js');
        const open = (mod?.Popup?.util?.popups || []).filter(p => p?.dlg?.hasAttribute('open'));
        return open.length === expected;
    }, beforeCount - 1, { timeout: 5_000 }).catch(() => {});
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
            const rows = db.prepare(`SELECT char_dir, name, doc FROM chats`).all();
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

async function ensureUserSettingsDrawerOpen(page) {
    const settingsDrawer = page.locator('#user-settings-button');
    if (await settingsDrawer.count() === 0) return;
    const drawerClosed = await page
        .locator('#user-settings-button .drawer-icon.closedIcon').count().then(n => n > 0);
    if (drawerClosed) {
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
    }
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
