// #26 — Mid-chat single-message delete must settle floor-state from the
// deleted floor (not chat.length), keeping commits before the deleted floor
// intact while dropping shifted commits so later writes never deadlock on
// stale high-floor commits or trip replay errors.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    reloadAndAwait,
    selectCharacterByName,
    sendMessageAndAwaitReply,
    getRenderedChatTexts,
} from '../_lib/page.js';

const REPLIES = [
    '*Seraphina traces the reef line.* "Reply 1: mark the northern shoal on the chart."',
    '*Seraphina checks the barometer.* "Reply 2: the squall line is three leagues out."',
    '*Seraphina trims the wick.* "Reply 3 first swipe: keep the lantern shielded."',
    '*Seraphina adjusts the compass.* "Reply 3 second swipe: steer two points east."',
];

let server, mock;

test.beforeAll(async () => {
    mock = await startMockLLM({ scriptedReplies: REPLIES });
    server = await startServer({ batchKey: 'chat', scenarioId: 'mid-delete-floor-state' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
    // Keep background Memory Graph extraction off so mockLLM scripted replies
    // belong exclusively to the main chat turns + swipe in this scenario.
    const settingsPath = resolve(server.dataRoot, 'default-user/settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.memory_graph = { ...(settings.extension_settings.memory_graph || {}), enabled: false };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mock?.stop();
});

async function deleteMessageRealUI(page, mesid) {
    const mes = page.locator(`.mes[mesid="${mesid}"]`);
    await mes.waitFor({ state: 'visible', timeout: 10_000 });
    await mes.hover();
    await mes.locator('.mes_edit').first().click();
    await mes.locator('.mes_edit_delete').first().waitFor({ state: 'visible', timeout: 5000 });

    const deletePromise = page.evaluate(() => new Promise((resolve, reject) => {
        const ctx = window.Luker.getContext();
        const t = setTimeout(() => reject(new Error('delete timeout')), 20_000);
        const off = ctx.eventSource.on(ctx.eventTypes.MESSAGE_DELETED, (len) => {
            clearTimeout(t);
            try { ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_DELETED, off); } catch { /* ignore */ }
            resolve(len);
        });
    }));

    await mes.locator('.mes_edit_delete').first().click();

    await page.waitForFunction(() => {
        return Array.from(document.querySelectorAll('dialog.popup')).some(d => d.hasAttribute('open'));
    }, null, { timeout: 2000 }).catch(() => {});
    await page.evaluate(() => {
        const openDlg = Array.from(document.querySelectorAll('dialog.popup')).reverse().find(d => d.hasAttribute('open'));
        if (openDlg) {
            const ok = openDlg.querySelector('.popup-button-ok');
            if (ok) ok.click();
        }
    });
    await deletePromise;
}

async function waitForGenerationIdle(page) {
    await page.waitForFunction(() => {
        const stop = document.querySelector('#mes_stop');
        const send = document.querySelector('#send_but');
        const stopHidden = !stop || getComputedStyle(stop).display === 'none';
        const sendVisible = Boolean(send) && !send.classList.contains('displayNone') && getComputedStyle(send).display !== 'none';
        return stopHidden && sendVisible;
    }, null, { timeout: 30_000 });
}

test.describe('#26 — mid-chat delete floor-state truncation', () => {
    test('deleting a middle message preserves earlier floors and drops shifted commits cleanly', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 10_000 });

        await sendMessageAndAwaitReply(page, 'What should we mark on the chart first?');
        await waitForGenerationIdle(page);
        await sendMessageAndAwaitReply(page, 'How close is the squall line?');
        await waitForGenerationIdle(page);
        await sendMessageAndAwaitReply(page, 'Which heading should we take?');
        await waitForGenerationIdle(page);

        // Swipe right on the last reply via real UI so floor 6 lands on swipe_id = 1.
        await page.locator('.last_mes .swipe_right').click();
        await page.waitForFunction(() => {
            const texts = Array.from(document.querySelectorAll('#chat .mes .mes_text')).map(el => el.textContent || '');
            return texts.some(t => /Reply 3 second swipe/.test(t));
        }, null, { timeout: 15_000 });
        await waitForGenerationIdle(page);

        const renderedBefore = await getRenderedChatTexts(page);
        const floor1 = renderedBefore.findIndex(t => /Reply 1/.test(t || ''));
        const floor2 = renderedBefore.findIndex(t => /Reply 2/.test(t || ''));
        const floor3 = renderedBefore.findIndex(t => /Reply 3 second swipe/.test(t || ''));
        expect(floor1).toBeGreaterThanOrEqual(0);
        expect(floor2).toBeGreaterThan(floor1);
        expect(floor3).toBeGreaterThan(floor2);

        // Mount a real floor-state instance and commit incremental array ops
        // anchored at floor1, floor2, and floor3 (the swiped tail).
        const seeded = await page.evaluate(async ({ f1, f2, f3 }) => {
            const ctx = window.Luker.getContext();
            const fs = await ctx.createFloorState({ namespace: 'mid_delete_probe' });
            window.__midDeleteFs = fs;
            const r1 = await fs.update(() => ({ entries: ['e1'] }), { floor: f1 });
            const r2 = await fs.update((s) => ({ entries: [...s.entries, 'e2'] }), { floor: f2 });
            const r3 = await fs.update((s) => ({ entries: [...s.entries, 'e3'] }), { floor: f3 });
            const got = await fs.get();
            return { ok: r1.ok && r2.ok && r3.ok, state: got.state };
        }, { f1: floor1, f2: floor2, f3: floor3 });
        expect(seeded.ok).toBe(true);
        expect(seeded.state).toEqual({ entries: ['e1', 'e2', 'e3'] });

        // Delete middle message (Reply 2) through the real pencil UI.
        await deleteMessageRealUI(page, floor2);
        await page.waitForFunction(({ wantLen }) => {
            return document.querySelectorAll('#chat .mes').length === wantLen;
        }, { wantLen: renderedBefore.length - 1 }, { timeout: 10_000 });

        // Floor-state must immediately preserve floor1, drop floor2 & floor3,
        // create no __orphans backup, and accept a new commit at floor2.
        const afterDelete = await page.evaluate(async ({ f2 }) => {
            const ctx = window.Luker.getContext();
            const fs = window.__midDeleteFs;
            await fs.ready();
            const gotBeforeWrite = await fs.get();
            const logBeforeWrite = await ctx.getChatState('mid_delete_probe__floor_log');
            const orphansBeforeWrite = await ctx.getChatState('mid_delete_probe__orphans');
            const writeAfter = await fs.update((s) => ({ entries: [...s.entries, 'e2-rebuilt'] }), { floor: f2 });
            const gotAfterWrite = await fs.get();
            return {
                stateBeforeWrite: gotBeforeWrite.state,
                recovered: Boolean(gotBeforeWrite.recovered),
                commitFloors: (logBeforeWrite?.state?.commits || []).map(c => c.floor),
                orphans: orphansBeforeWrite?.state ?? null,
                writeOk: writeAfter.ok,
                writeReason: writeAfter.reason ?? null,
                stateAfterWrite: gotAfterWrite.state,
            };
        }, { f2: floor2 });

        expect(afterDelete.recovered).toBe(false);
        expect(afterDelete.orphans).toBeNull();
        expect(afterDelete.commitFloors).toEqual([floor1]);
        expect(afterDelete.stateBeforeWrite).toEqual({ entries: ['e1'] });
        expect(afterDelete.writeOk).toBe(true);
        expect(afterDelete.writeReason).toBeNull();
        expect(afterDelete.stateAfterWrite).toEqual({ entries: ['e1', 'e2-rebuilt'] });

        await server.restart();
        await reloadAndAwait(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 2, null, { timeout: 15_000 });

        const afterRestart = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            const fs = await ctx.createFloorState({ namespace: 'mid_delete_probe' });
            const got = await fs.get();
            const orphans = await ctx.getChatState('mid_delete_probe__orphans');
            await fs.destroy();
            return {
                ok: got.ok,
                recovered: Boolean(got.recovered),
                state: got.state,
                orphans: orphans?.state ?? null,
            };
        });

        expect(afterRestart.ok).toBe(true);
        expect(afterRestart.recovered).toBe(false);
        expect(afterRestart.orphans).toBeNull();
        expect(afterRestart.state).toEqual({ entries: ['e1', 'e2-rebuilt'] });
    });
});
