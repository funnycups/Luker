// #85 — A global runtime-limit auto-save reaches the character copy.

import { test, expect } from '../../harness/playwright.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, selectCharacterByName } from '../_lib/page.js';
import {
    clickOrchSetupBarButton,
    enableOrchestratorMode,
    getOrchRuntimeLimitInput,
} from '../_lib/ui-orchestrator.js';
import { openOrchWorkspace } from '../_lib/ui-workbench.js';
import { read as readPngCard } from '../../../src/character-card-parser.js';

let server, mock;

const CHARACTER_NAME = 'Seraphina';

function readActiveGlobalAgendaEntry() {
    const settings = JSON.parse(readFileSync(resolve(server.dataRoot, 'default-user', 'settings.json'), 'utf8'));
    const orch = settings?.extension_settings?.orchestrator;
    const activeId = orch?.activePresetIds?.agenda || '';
    return activeId ? (orch?.presetLibraries?.agenda?.[activeId] || null) : null;
}

function readCardAgendaEntry(avatar) {
    const png = readFileSync(resolve(server.dataRoot, 'default-user', 'characters', avatar));
    const orch = JSON.parse(readPngCard(png))?.data?.extensions?.orchestrator;
    const activeId = orch?.activePresetIds?.agenda || '';
    return activeId ? (orch?.presetLibraries?.agenda?.[activeId] || null) : null;
}

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    mock = await startMockLLM({});
    server = await startServer({
        scope,
        batchKey: 'orchestrator',
        scenarioId: '85-global-limit-auto-save-reaches-card-copy',
        extraConfig: { storage: { mode: 'fs' } },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
});

test.afterAll(async () => {
    await mock?.stop();
});

test.describe('#85 — a global runtime-limit auto-save reaches the character draft', () => {
    test.setTimeout(90_000);

    test('Copy agents from spec + Save To Character Override writes the new global limit onto the card', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, CHARACTER_NAME);
        await enableOrchestratorMode(page, 'agenda', { closeAfter: false });
        await expect.poll(() => readActiveGlobalAgendaEntry()?.limits?.maxConcurrentAgents ?? null, { timeout: 10_000 }).not.toBeNull();

        const avatar = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            return String(ctx.characters?.[ctx.characterId]?.avatar || '');
        });
        expect(readCardAgendaEntry(avatar), 'the card starts without an agenda slot').toBeNull();

        const maxConcurrent = await getOrchRuntimeLimitInput(page, /Max concurrent agents|最大并发 Agent|最大並行 Agent/i);
        const before = Number(await maxConcurrent.inputValue());
        expect(before).toBe(Number(readActiveGlobalAgendaEntry().limits.maxConcurrentAgents));
        const next = before + 2;
        await maxConcurrent.fill(String(next));
        await maxConcurrent.press('Tab');
        await expect.poll(() => readActiveGlobalAgendaEntry()?.limits?.maxConcurrentAgents, { timeout: 15_000 }).toBe(next);

        const lens = await openOrchWorkspace(page, 'setup');
        await lens.locator('button', { hasText: /Copy agents from spec|从 Spec 复制|從 Spec 複製/i }).first().click();
        await clickOrchSetupBarButton(page, /Save To Character Override|保存为角色覆盖|儲存為角色覆寫/i);
        await expect.poll(() => readCardAgendaEntry(avatar)?.limits?.maxConcurrentAgents ?? null, {
            timeout: 15_000,
            message: 'the card agenda slot holds the limit set just before the copy',
        }).toBe(next);
        const cardLimitInput = await getOrchRuntimeLimitInput(page, /Max concurrent agents|最大并发 Agent|最大並行 Agent/i);
        await expect(cardLimitInput).toHaveValue(String(next));
    });
});
