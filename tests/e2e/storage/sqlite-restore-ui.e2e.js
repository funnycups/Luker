import { test, expect } from '../../harness/playwright.js';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import Database from 'better-sqlite3';

import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';
import { accountWindow, answerWindowConfirm, closeAccountWindow, openAccountTab, pageHead } from '../_lib/account-window.js';
import { CURRENT_SCHEMA_VERSION, initSchema } from '../../../src/storage/engines/sqlite-schema.js';
import { ENGINE_DUMP_ENTRY, ENGINE_META_ENTRY } from '../../../src/storage/engine-backup-entries.js';

const V1_SQL = fs.readFileSync(
    new URL('../../../src/storage/engines/migrations/sqlite/0001-initial.sql', import.meta.url),
    'utf8',
);

async function writeZip(zipPath, entries) {
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(zipPath);
        const arc = archiver('zip');
        arc.on('error', reject);
        out.on('error', reject);
        out.on('close', resolve);
        arc.pipe(out);
        for (const entry of entries) {
            arc.append(entry.content, { name: entry.name });
        }
        arc.finalize();
    });
}

function readSqliteChats(dataRoot) {
    const dbPath = path.join(dataRoot, 'default-user', 'luker-storage.sqlite');
    if (!fs.existsSync(dbPath)) return [];
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.prepare('SELECT handle, char_dir, name, doc, integrity FROM chats').all().map((row) => ({
            ...row,
            parsed: JSON.parse(row.doc),
        }));
    } finally {
        db.close();
    }
}

function readFsChatsText(dataRoot) {
    const chatsRoot = path.join(dataRoot, 'default-user', 'chats');
    if (!fs.existsSync(chatsRoot)) return '';
    const chunks = [];
    for (const dirName of fs.readdirSync(chatsRoot)) {
        const dir = path.join(chatsRoot, dirName);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const fileName of fs.readdirSync(dir)) {
            if (!fileName.endsWith('.jsonl')) continue;
            chunks.push(fs.readFileSync(path.join(dir, fileName), 'utf8'));
        }
    }
    return chunks.join('\n');
}

function restoreErrorBanner(page) {
    return accountWindow(page).locator('.dw-banner.error');
}

async function submitRestoreViaUI(page, zipPath, { mode = 'merge' } = {}) {
    await openAccountTab(page, 'restore');
    await expect(pageHead(page)).toHaveAttribute('data-view', 'restore');
    const win = accountWindow(page);

    const modeButton = win.locator(`[data-act="mode"][data-set="restore"][data-mode="${mode}"]`);
    await modeButton.click();
    await expect(modeButton).toHaveClass(/\bon\b/);

    await win.locator('input[data-role="file"]').setInputFiles(zipPath);
    await win.locator('.dw-file').waitFor({ state: 'visible', timeout: 10_000 });

    await win.locator('[data-act="restore-go"]').click();
    await answerWindowConfirm(page);
}

test('SQLite mode Account Restore UI rejects structurally invalid dumps before mutation and upgrades valid legacy v1 backups', async ({ page, resources }) => {
    test.setTimeout(180_000);
    const scratchDir = (await resources.directory('sqlite-restore-ui-same')).path;
    const mock = await startMockLLM({
        scriptedReplies: [
            '*Logs the first watch entry beside the harbor bell.*',
            '*Notes the second watch entry after the invalid archive was refused.*',
            '*Appends a fresh entry onto the restored legacy ledger.*',
        ],
    });
    try {
        const server = await startServer({
            scope: resources,
            batchKey: 'storage',
            scenarioId: 'sqlite-restore-ui-same-mode',
            extraConfig: { storage: { mode: 'sqlite' } },
        });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, storageMode: 'sqlite' });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

        const secretsPath = path.join(server.dataRoot, 'default-user', 'secrets.json');
        fs.writeFileSync(secretsPath, JSON.stringify({ api_key_custom: 'keep-sqlite-secret' }));

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const initialMsg = 'Initial watchpost log before invalid restore';
        await sendMessageAndAwaitReply(page, initialMsg);
        await expect.poll(() => readSqliteChats(server.dataRoot).some(
            row => (row.parsed.body || []).some(m => String(m?.mes || '').includes(initialMsg)),
        ), { timeout: 20_000 }).toBe(true);

        // Craft an invalid SQLite dump (non-generated chats.integrity + missing chat_states FK)
        // with secrets.json positioned BEFORE _engine_dump.bin to verify zero account mutation.
        const badDbPath = path.join(scratchDir, 'invalid-schema.sqlite');
        const badDb = new Database(badDbPath);
        try {
            initSchema(badDb);
            badDb.pragma('foreign_keys = OFF');
            badDb.exec(`
                DROP TABLE chat_states;
                DROP TABLE chats;
                CREATE TABLE chats (
                    handle TEXT NOT NULL, char_dir TEXT NOT NULL, name TEXT NOT NULL,
                    is_group INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL DEFAULT '',
                    doc TEXT NOT NULL, integrity TEXT, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
                    PRIMARY KEY (handle, char_dir, name, is_group, group_id)
                );
                CREATE TABLE chat_states (
                    handle TEXT NOT NULL, char_dir TEXT NOT NULL, name TEXT NOT NULL,
                    is_group INTEGER NOT NULL DEFAULT 0, group_id TEXT NOT NULL DEFAULT '',
                    namespace TEXT NOT NULL, doc TEXT NOT NULL,
                    PRIMARY KEY (handle, char_dir, name, is_group, group_id, namespace)
                );
            `);
        } finally {
            badDb.close();
        }
        const badZipPath = path.join(scratchDir, 'invalid-sqlite-backup.zip');
        await writeZip(badZipPath, [
            { name: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, handle: 'default-user' }) },
            { name: ENGINE_META_ENTRY, content: JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: 'default-user' }) },
            { name: 'secrets.json', content: JSON.stringify({ api_key_custom: 'poisoned-secret' }) },
            { name: ENGINE_DUMP_ENTRY, content: fs.readFileSync(badDbPath) },
        ]);

        // Submit through real Account -> Restore UI (merge mode).
        await submitRestoreViaUI(page, badZipPath, { mode: 'merge' });
        await expect(restoreErrorBanner(page)).toBeVisible({ timeout: 20_000 });
        await expect(restoreErrorBanner(page)).toContainText(/Backup engine dump is invalid/i);

        // Live database rows and secrets.json remain completely intact.
        expect(JSON.parse(fs.readFileSync(secretsPath, 'utf8'))).toEqual({ api_key_custom: 'keep-sqlite-secret' });
        expect(readSqliteChats(server.dataRoot).some(
            row => (row.parsed.body || []).some(m => String(m?.mes || '').includes(initialMsg)),
        )).toBe(true);

        // Close Account window and confirm the live account can still read and write cleanly.
        await closeAccountWindow(page);
        const afterRejectMsg = 'Second watchpost log proving live SQLite writes still work';
        await sendMessageAndAwaitReply(page, afterRejectMsg);
        await expect.poll(() => readSqliteChats(server.dataRoot).some(
            row => (row.parsed.body || []).some(m => String(m?.mes || '').includes(afterRejectMsg)),
        ), { timeout: 20_000 }).toBe(true);

        // Build a genuine legacy schema v1 SQLite backup from 0001-initial.sql (user_version = 1)
        // carrying data under a different source handle, and restore it through real UI Replace mode.
        const liveSeed = (() => {
            const db = new Database(path.join(server.dataRoot, 'default-user', 'luker-storage.sqlite'), { readonly: true });
            try {
                return {
                    settingsDoc: db.prepare('SELECT doc FROM settings WHERE handle = ?').get('default-user')?.doc || '{}',
                    presets: db.prepare('SELECT dir_key, name, doc, updated_at FROM presets WHERE handle = ?').all('default-user'),
                    namedDocs: db.prepare('SELECT bucket, name, doc, updated_at FROM named_docs WHERE handle = ?').all('default-user'),
                };
            } finally {
                db.close();
            }
        })();
        expect(liveSeed.presets.length).toBeGreaterThan(0);
        const seraphinaChat = readSqliteChats(server.dataRoot).find(
            row => (row.parsed.body || []).some(m => String(m?.mes || '').includes(initialMsg)),
        );
        expect(seraphinaChat?.char_dir).toBeTruthy();
        expect(seraphinaChat?.name).toBeTruthy();

        const legacyDbPath = path.join(scratchDir, 'legacy-v1.sqlite');
        const legacyMsg = 'Legacy schema v1 restored lantern ledger';
        const legacyDb = new Database(legacyDbPath);
        try {
            legacyDb.exec(V1_SQL);
            legacyDb.pragma('user_version = 1');
            legacyDb.prepare('INSERT INTO settings (handle, doc, updated_at) VALUES (?, ?, ?)').run('legacy-account', liveSeed.settingsDoc, Date.now());
            const insertPreset = legacyDb.prepare('INSERT INTO presets (handle, dir_key, name, doc, updated_at) VALUES (?, ?, ?, ?, ?)');
            for (const preset of liveSeed.presets) {
                insertPreset.run('legacy-account', preset.dir_key, preset.name, preset.doc, preset.updated_at);
            }
            const insertNamedDoc = legacyDb.prepare('INSERT INTO named_docs (handle, bucket, name, doc, updated_at) VALUES (?, ?, ?, ?, ?)');
            for (const doc of liveSeed.namedDocs) {
                insertNamedDoc.run('legacy-account', doc.bucket, doc.name, doc.doc, doc.updated_at);
            }
            const legacyChatDoc = JSON.stringify({
                header: {
                    user_name: 'User',
                    character_name: 'Seraphina',
                    create_date: '2026-06-27@00h00m00s',
                    chat_metadata: { integrity: 'legacy-integrity-v1' },
                },
                body: [
                    { name: 'Seraphina', is_user: false, is_system: false, send_date: '2026-06-27', mes: '*Turns the lantern wick higher.*' },
                    { name: 'User', is_user: true, is_system: false, send_date: '2026-06-27', mes: legacyMsg },
                ],
            });
            legacyDb.prepare('INSERT INTO chats (handle, char_dir, name, is_group, group_id, doc, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run('legacy-account', seraphinaChat.char_dir, seraphinaChat.name, 0, '', legacyChatDoc, Date.now(), Date.now() - 1000);
            legacyDb.prepare('INSERT INTO worlds (handle, name, doc, updated_at) VALUES (?, ?, ?, ?)')
                .run('legacy-account', 'Legacy Harbor Atlas', JSON.stringify({ entries: { '1': { content: 'Reef depths' } } }), Date.now());
        } finally {
            legacyDb.close();
        }
        const legacyZipPath = path.join(scratchDir, 'legacy-v1-backup.zip');
        const charDir = path.join(server.dataRoot, 'default-user', 'characters');
        const charEntries = fs.readdirSync(charDir)
            .filter(name => fs.statSync(path.join(charDir, name)).isFile())
            .map(name => ({ name: `characters/${name}`, content: fs.readFileSync(path.join(charDir, name)) }));
        await writeZip(legacyZipPath, [
            { name: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, handle: 'legacy-account' }) },
            { name: ENGINE_META_ENTRY, content: JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: 'legacy-account' }) },
            { name: ENGINE_DUMP_ENTRY, content: fs.readFileSync(legacyDbPath) },
            { name: 'secrets.json', content: JSON.stringify({ api_key_custom: 'restored-legacy-secret' }) },
            ...charEntries,
        ]);

        const reloadPromise = page.waitForEvent('framenavigated', {
            predicate: frame => frame === page.mainFrame(),
            timeout: 120_000,
        });
        await submitRestoreViaUI(page, legacyZipPath, { mode: 'replace' });
        await reloadPromise;
        await awaitMainUI(page, server.baseURL);

        // Verify SQLite schema upgraded cleanly, handle rewritten, integrity computed, and revision cleared.
        const dbAfter = new Database(path.join(server.dataRoot, 'default-user', 'luker-storage.sqlite'), { readonly: true });
        try {
            expect(dbAfter.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
            const worldRow = dbAfter.prepare('SELECT handle, name, doc, revision FROM worlds WHERE name = ?').get('Legacy Harbor Atlas');
            expect(worldRow).toMatchObject({ handle: 'default-user', name: 'Legacy Harbor Atlas', revision: null });
            expect(JSON.parse(worldRow.doc)).toEqual({ entries: { '1': { content: 'Reef depths' } } });
            const chatRow = dbAfter.prepare('SELECT handle, integrity, doc FROM chats WHERE char_dir = ? AND name = ?').get(seraphinaChat.char_dir, seraphinaChat.name);
            expect(chatRow).toMatchObject({ handle: 'default-user', integrity: 'legacy-integrity-v1' });
            expect(JSON.parse(chatRow.doc).body.some(m => m.mes === legacyMsg)).toBe(true);
        } finally {
            dbAfter.close();
        }
        expect(JSON.parse(fs.readFileSync(secretsPath, 'utf8'))).toEqual({ api_key_custom: 'restored-legacy-secret' });

        // Verify UI renders the restored chat and accepts a subsequent write cleanly.
        await selectCharacterByName(page, 'Seraphina');
        const lorePopup = page.locator('dialog.popup[open]', { hasText: /embedded World\/Lorebook/i });
        await expect(lorePopup).toBeVisible({ timeout: 10_000 });
        await lorePopup.locator('.popup-button-cancel').click();
        await expect(lorePopup).toBeHidden({ timeout: 10_000 });
        await expect(page.locator('#chat')).toContainText(legacyMsg, { timeout: 15_000 });
        const postRestoreMsg = 'Post-legacy-restore live message';
        await sendMessageAndAwaitReply(page, postRestoreMsg);
        await expect.poll(() => readSqliteChats(server.dataRoot).some(
            row => (row.parsed.body || []).some(m => String(m?.mes || '').includes(postRestoreMsg)),
        ), { timeout: 20_000 }).toBe(true);
    } finally {
        await mock.stop();
    }
});

test('FS mode Account Restore UI rejects cross-mode invalid SQLite dump before mutation and keeps live data writable', async ({ page, resources }) => {
    test.setTimeout(180_000);
    const scratchDir = (await resources.directory('sqlite-restore-ui-cross')).path;
    const mock = await startMockLLM({
        scriptedReplies: [
            '*Records the harbor arrival on parchment.*',
            '*Confirms the parchment log stays writable after refusal.*',
        ],
    });
    try {
        const server = await startServer({
            scope: resources,
            batchKey: 'storage',
            scenarioId: 'sqlite-restore-ui-cross-mode',
            extraConfig: { storage: { mode: 'fs' } },
        });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL, storageMode: 'fs' });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        const initialMsg = 'Live FS chat preserved across invalid sqlite cross-mode restore';
        await sendMessageAndAwaitReply(page, initialMsg);
        await expect.poll(() => readFsChatsText(server.dataRoot).includes(initialMsg), { timeout: 20_000 }).toBe(true);

        // Build an invalid SQLite dump containing an orphan chat_states FK violation.
        const badDbPath = path.join(scratchDir, 'orphan-fk.sqlite');
        const badDb = new Database(badDbPath);
        try {
            initSchema(badDb);
            badDb.pragma('foreign_keys = OFF');
            badDb.prepare('INSERT INTO chat_states (handle, char_dir, name, is_group, group_id, namespace, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run('default-user', 'Seraphina', 'ghost', 0, '', 'ns', '{}');
        } finally {
            badDb.close();
        }
        const badZipPath = path.join(scratchDir, 'invalid-cross-sqlite.zip');
        await writeZip(badZipPath, [
            { name: 'manifest.json', content: JSON.stringify({ schemaVersion: 1, handle: 'default-user' }) },
            { name: ENGINE_META_ENTRY, content: JSON.stringify({ engineKind: 'sqlite', schemaVersion: 1, createdAt: '2026-06-27T00:00:00Z', handle: 'default-user' }) },
            { name: ENGINE_DUMP_ENTRY, content: fs.readFileSync(badDbPath) },
        ]);

        await submitRestoreViaUI(page, badZipPath, { mode: 'replace' });
        await expect(restoreErrorBanner(page)).toBeVisible({ timeout: 20_000 });
        await expect(restoreErrorBanner(page)).toContainText(/Backup engine dump is invalid/i);

        expect(readFsChatsText(server.dataRoot)).toContain(initialMsg);

        await closeAccountWindow(page);
        const followUpMsg = 'Post-rejection FS write succeeds';
        await sendMessageAndAwaitReply(page, followUpMsg);
        await expect.poll(() => readFsChatsText(server.dataRoot).includes(followUpMsg), { timeout: 20_000 }).toBe(true);
    } finally {
        await mock.stop();
    }
});
