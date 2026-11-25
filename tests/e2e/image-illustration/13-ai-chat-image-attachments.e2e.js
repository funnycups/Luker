// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { startSdWebUiMock } from '../_lib/sdMock.js';
import {
    bootstrapCustomBackend,
    appendConnectionProfile,
    markOnboarded,
    writeCharacter,
} from '../_lib/fixtures.js';
import {
    awaitMainUI,
    openExtensionsDrawer,
    openInlineDrawer,
    closeAnyOpenTopSettingsDrawer,
} from '../_lib/page.js';
import { openCharacterList } from '../_lib/ui-character.js';
import {
    openWorkbenchIterate,
    switchWorkbenchTab,
    selectWorkbenchTab,
    closeWorkbench,
} from '../_lib/ui-workbench.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SAMPLE_PNG_PATH = resolve(REPO_ROOT, 'default/content/default_Seraphina.png');
const SAMPLE_PNG_BYTES = readFileSync(SAMPLE_PNG_PATH);
const SAMPLE_DATA_URL = `data:image/png;base64,${SAMPLE_PNG_BYTES.toString('base64')}`;

let server;
let llm;
let sdMock;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    sdMock = await startSdWebUiMock();
    llm = await startMockLLM();
    server = await startServer({
        scope,
        batchKey: 'image-illustration',
        scenarioId: '13-ai-chat-image-attachments',
        extraConfig: { enableUserAccounts: false, disableUpdateCheck: true },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: llm.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, name: 'e2e-vision', baseURL: llm.baseURL, api: 'custom' });
    writeCharacter({ dataRoot: server.dataRoot, avatarFile: 'ash-the-cartographer.png' });
});

test.afterAll(async () => {
    await llm?.stop();
    await sdMock?.stop();
});

function listAiAttachments() {
    const dir = join(server.dataRoot, 'default-user/user/images/_ai_attachments');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => !name.startsWith('.')).sort();
}

function listSandboxSessionDirs() {
    const dir = join(server.dataRoot, 'default-user/user/images/_sandbox_tmp');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => !name.startsWith('.')).sort();
}

function chatCompletionRequests(sinceIndex = 0) {
    return llm.requests
        .slice(sinceIndex)
        .filter(request => String(request.url || '').includes('/chat/completions'));
}

function extractImageDataUrls(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .filter(m => Array.isArray(m?.content))
        .flatMap(m => m.content)
        .filter(part => part?.type === 'image_url' && typeof part?.image_url?.url === 'string')
        .map(part => part.image_url.url);
}

function extractAllText(messages = []) {
    return (Array.isArray(messages) ? messages : [])
        .flatMap(m => {
            if (typeof m?.content === 'string') return [m.content];
            if (Array.isArray(m?.content)) {
                return m.content
                    .filter(part => part?.type === 'text' && typeof part.text === 'string')
                    .map(part => part.text);
            }
            return [];
        })
        .join('\n');
}

async function attachSampleImage(page, container) {
    const chooserPromise = page.waitForEvent('filechooser');
    await container.locator('[data-lw-role="att-button"]').first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles(SAMPLE_PNG_PATH);
    await expect(container.locator('[data-lw-role="att-chip"]')).toHaveCount(1, { timeout: 10_000 });
}

async function confirmAlertDialog(page) {
    const dlg = page.getByRole('alertdialog').last();
    await expect(dlg).toBeVisible({ timeout: 10_000 });
    const okBtn = dlg.getByRole('button', { name: /^(Delete|Confirm|Clear all|删除|刪除|确认|確認|全部清空)$/i }).first();
    await okBtn.click();
    await expect(dlg).toBeHidden({ timeout: 10_000 });
}

async function readProfiles(page) {
    const response = await page.request.get(`${server.baseURL}/api/state/get?account=default-user&namespace=sd_character_profiles`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.ok).toBe(true);
    return body.data?.profiles ?? {};
}

async function ensureSessionsDrawerOpen(win) {
    const sessToggle = win.locator('.wb-src-toggle').first();
    if (await sessToggle.isVisible().catch(() => false)) {
        await sessToggle.click();
    }
}

async function uncheckVisualInspection(page) {
    const visualCheck = page.locator('#sd_illustration_visual_inspection');
    if (!(await visualCheck.isVisible())) {
        await visualCheck.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " inline-drawer ")][1]')
            .locator('> .inline-drawer-toggle').click();
    }
    await visualCheck.uncheck();
    await expect(visualCheck).not.toBeChecked();
}

test.describe.serial('Unified AI chat image attachments', () => {
    test('Workbench AI iteration and Q&A: lossless upload, multi-turn replay, copy-on-branch, deletion cleanup, and provider error surfacing', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        llm.setChatCompletionFailure(null);
        llm.scriptCompletion(() => ({ text: 'I can see the attached portrait clearly.' }));

        const win = await openWorkbenchIterate(page, 'preset');
        const composer = win.locator('.wb-composer').first();

        // Pending image stays memory-staged until Send is clicked.
        await attachSampleImage(page, composer);
        expect(listAiAttachments()).toEqual([]);

        const reqBeforeTurn1 = llm.requests.length;
        await composer.locator('.wb-input').fill('Inspect this preset reference screenshot.');
        await composer.locator('.wb-send').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeTurn1).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(win.locator('.wb-msg-ai').last()).toContainText('I can see the attached portrait clearly.', { timeout: 30_000 });

        const turn1Req = chatCompletionRequests(reqBeforeTurn1)[0];
        expect(extractImageDataUrls(turn1Req.body.messages)).toContain(SAMPLE_DATA_URL);

        const filesAfterTurn1 = listAiAttachments();
        expect(filesAfterTurn1).toHaveLength(1);
        const origFile = filesAfterTurn1[0];
        expect(readFileSync(join(server.dataRoot, 'default-user/user/images/_ai_attachments', origFile))).toEqual(SAMPLE_PNG_BYTES);

        // Turn 2 (text-only) must replay Turn 1's lossless image.
        const reqBeforeTurn2 = llm.requests.length;
        await composer.locator('.wb-input').fill('Follow up on the same image.');
        await composer.locator('.wb-send').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeTurn2).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 30_000 });
        const turn2Req = chatCompletionRequests(reqBeforeTurn2)[0];
        expect(extractImageDataUrls(turn2Req.body.messages)).toContain(SAMPLE_DATA_URL);

        // Branch from here must copy the attachment so each session owns an independent file.
        const branchBtn = win.locator('.wb-msg-ai').last().getByRole('button', { name: /^(Branch from here|从这里分支|從這裡分支)$/i });
        await branchBtn.click();
        await expect.poll(() => listAiAttachments().length, { timeout: 15_000 }).toBe(2);
        const filesAfterFork = listAiAttachments();
        const branchFile = filesAfterFork.find(f => f !== origFile);
        expect(branchFile).toBeTruthy();

        // Open session drawer if compact so session rows are visible, delete original session.
        await ensureSessionsDrawerOpen(win);
        const origRow = win.locator('.wb-sess-row').filter({ hasNot: page.locator('.wb-sess-item[aria-current="true"]') }).first();
        await expect(origRow).toBeVisible({ timeout: 10_000 });
        await origRow.locator('.wb-sess-del').click();
        await confirmAlertDialog(page);

        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([branchFile]);

        // Delete the branched session too; _ai_attachments must be completely clean.
        const branchRow = win.locator('.wb-sess-row').first();
        await branchRow.locator('.wb-sess-del').click();
        await confirmAlertDialog(page);
        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([]);

        // Switch to Workbench Q&A (Ask).
        await switchWorkbenchTab(page, 'ask');
        const askComposer = win.locator('.wb-composer').first();

        // Non-vision provider error must surface directly without swallowing.
        llm.setChatCompletionFailure(() => ({
            status: 400,
            body: JSON.stringify({ error: { message: 'This model does not support image inputs.' } }),
        }));
        await attachSampleImage(page, askComposer);
        await askComposer.locator('.wb-input').fill('Check image on non-vision model.');
        await askComposer.locator('.wb-send').click();
        await expect(win.locator('.wb-msg-ai .wb-msg-error').last()).toContainText('does not support image inputs', { timeout: 30_000 });

        await win.locator('.wb-chat-del').click();
        await confirmAlertDialog(page);
        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([]);

        // Successful multi-turn Q&A with image replay and delete cleanup.
        llm.setChatCompletionFailure(null);
        llm.scriptCompletion(() => ({ text: 'Q&A saw the attached image.' }));
        const reqBeforeAsk1 = llm.requests.length;
        await attachSampleImage(page, askComposer);
        await askComposer.locator('.wb-input').fill('What is shown in this screenshot?');
        await askComposer.locator('.wb-send').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeAsk1).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(win.locator('.wb-msg-ai').last()).toContainText('Q&A saw the attached image.', { timeout: 30_000 });
        expect(extractImageDataUrls(chatCompletionRequests(reqBeforeAsk1)[0].body.messages)).toContain(SAMPLE_DATA_URL);
        expect(listAiAttachments()).toHaveLength(1);

        const reqBeforeAsk2 = llm.requests.length;
        await askComposer.locator('.wb-input').fill('Summarize that again.');
        await askComposer.locator('.wb-send').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeAsk2).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(win.locator('.wb-reads.is-live')).toHaveCount(0, { timeout: 30_000 });
        expect(extractImageDataUrls(chatCompletionRequests(reqBeforeAsk2)[0].body.messages)).toContain(SAMPLE_DATA_URL);

        await win.locator('.wb-chat-del').click();
        await confirmAlertDialog(page);
        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([]);

        await closeWorkbench(page);
    });

    test('SD AI Profile Builder: lossless chat attachment with visualInspection OFF, archive promotion, on-demand inspect_image, and cancel cleanup', async ({ page }) => {
        const transient403s = [];
        page.on('response', (res) => {
            if (res.status() === 403 && res.url().includes('_sandbox_tmp')) {
                const req = res.request();
                transient403s.push({
                    url: req.url(),
                    method: req.method(),
                    resourceType: req.resourceType(),
                    headers: req.headers(),
                });
            }
        });
        await awaitMainUI(page, server.baseURL);

        // Configure SD WebUI mock and explicitly UNCHECK visualInspection.
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await page.locator('#sd_source').selectOption('auto');
        await page.locator('#sd_auto_url').fill(sdMock.baseURL);
        await page.locator('#sd_auto_validate').click();
        await expect(page.locator('#sd_model option').first()).toBeAttached({ timeout: 15_000 });

        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await uncheckVisualInspection(page);
        await closeAnyOpenTopSettingsDrawer(page);

        const wb = await selectWorkbenchTab(page, 'sd');
        await wb.locator('[data-sd-nav="characters"]').click();
        const archive = wb.locator('[data-sd-view="characters"]');
        await expect(archive.locator('[data-sd-role="open-ai-builder"]').first()).toBeVisible({ timeout: 15_000 });

        // Case A: User attaches a character image in Builder chat -> AI sees lossless original + path annotation -> adopts directly into draft -> Confirm promotes to _references & cleans _sandbox_tmp.
        let builderStep = 'attach_stage';
        let attachedSandboxPath = '';
        llm.setChatCompletionFailure(null);
        llm.scriptCompletion(({ body }) => {
            if (builderStep === 'attach_stage') {
                builderStep = 'attach_done';
                const allText = extractAllText(body.messages);
                const match = /\[Attached image #1:\s*(\/user\/images\/_sandbox_tmp\/[^\]\s]+)\]/.exec(allText);
                attachedSandboxPath = match?.[1] || '';
                return {
                    tool: 'stage_character_profile',
                    arguments: {
                        name: 'Seraphina Reverse-Engineered',
                        description: 'Silver-white hair, blue-trimmed coat, calm coastal gaze.',
                        reference_images: attachedSandboxPath
                            ? [{ path: attachedSandboxPath, label: 'User uploaded portrait' }]
                            : [],
                    },
                };
            }
            return { text: 'Reverse-engineered the portrait and added it to the draft.' };
        });

        await archive.locator('[data-sd-role="open-ai-builder"]').first().click();
        const dialog1 = page.locator('[data-sd-role="character-builder-dialog"]').last();
        await expect(dialog1).toBeVisible({ timeout: 15_000 });

        const reqBeforeBuilder1 = llm.requests.length;
        await attachSampleImage(page, dialog1.locator('.sdlens-builder-compose'));
        await dialog1.locator('[data-sd-role="builder-input"]').fill('Reverse-engineer this character and adopt the image.');
        await dialog1.locator('[data-sd-role="builder-send"]').click();

        await expect(dialog1.locator('[data-sd-builder-field="name"]')).toHaveValue('Seraphina Reverse-Engineered', { timeout: 30_000 });
        const builder1Reqs = chatCompletionRequests(reqBeforeBuilder1);
        expect(builder1Reqs.length).toBeGreaterThanOrEqual(2);
        expect(extractImageDataUrls(builder1Reqs[0].body.messages)).toContain(SAMPLE_DATA_URL);
        expect(attachedSandboxPath).toMatch(/^\/user\/images\/_sandbox_tmp\//);
        expect(builder1Reqs[0].body.tools.map(t => t.function.name)).toContain('inspect_image');

        await dialog1.locator('[data-sd-role="builder-confirm"]').click();
        await expect(dialog1).toBeHidden({ timeout: 15_000 });

        expect(listSandboxSessionDirs()).toEqual([]);
        const profiles = await readProfiles(page);
        const saved = Object.values(profiles).find(p => p.name === 'Seraphina Reverse-Engineered');
        expect(saved).toBeTruthy();
        expect(saved.referenceImages).toHaveLength(1);
        expect(saved.referenceImages[0].path).toMatch(/^\/user\/images\/_references\//);
        const formalFile = join(server.dataRoot, 'default-user', saved.referenceImages[0].path.replace(/^\//, ''));
        expect(existsSync(formalFile)).toBe(true);
        expect(readFileSync(formalFile)).toEqual(SAMPLE_PNG_BYTES);

        // Case B: Upload local reference on right draft pane -> AI calls inspect_image (still with visualInspection OFF) -> receives lossless original -> Cancel removes _sandbox_tmp.
        await archive.locator('[data-sd-role="open-ai-builder"]').first().click();
        const dialog2 = page.locator('[data-sd-role="character-builder-dialog"]').last();
        await expect(dialog2).toBeVisible({ timeout: 15_000 });

        const refChooserPromise = page.waitForEvent('filechooser');
        await dialog2.locator('[data-sd-role="builder-upload-ref"]').click();
        await (await refChooserPromise).setFiles(SAMPLE_PNG_PATH);
        const refItem = dialog2.locator('[data-sd-role="builder-ref-item"]').first();
        await expect(refItem).toBeVisible({ timeout: 15_000 });
        const uploadedRefPath = await refItem.getAttribute('data-image-path');
        expect(uploadedRefPath).toMatch(/^\/user\/images\/_sandbox_tmp\//);

        let inspectStep = 'call_inspect';
        llm.scriptCompletion(() => {
            if (inspectStep === 'call_inspect') {
                inspectStep = 'after_inspect';
                return {
                    tool: 'inspect_image',
                    arguments: { image_paths: [uploadedRefPath] },
                };
            }
            return { text: 'Inspected the uploaded draft reference image.' };
        });

        const reqBeforeInspect = llm.requests.length;
        await dialog2.locator('[data-sd-role="builder-input"]').fill('Inspect the uploaded draft reference image.');
        await dialog2.locator('[data-sd-role="builder-send"]').click();
        await expect(dialog2.locator('[data-sd-role="builder-messages"]')).toContainText('Inspected the uploaded draft reference image.', { timeout: 30_000 });

        const inspectReqs = chatCompletionRequests(reqBeforeInspect);
        expect(inspectReqs.length).toBeGreaterThanOrEqual(2);
        expect(extractImageDataUrls(inspectReqs[1].body.messages)).toContain(SAMPLE_DATA_URL);

        await dialog2.locator('[data-sd-role="builder-cancel"]').click();
        await expect(dialog2).toBeHidden({ timeout: 15_000 });
        await expect.poll(() => listSandboxSessionDirs(), { timeout: 15_000 }).toEqual([]);
        expect(transient403s).toEqual([]);

        await closeWorkbench(page);
    });

    test('SD Image Studio: lossless chat attachment, multi-turn replay, copy-on-branch, and delete cleanup', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await page.locator('#extensionsMenuButton').click();
        await page.locator('#sd_illustration_open_studio').click();
        const studioRoot = page.locator('.wbench .wb-win:not([hidden]) [data-sd-view="studio"]');
        await expect(studioRoot).toBeVisible({ timeout: 15_000 });

        llm.setChatCompletionFailure(null);
        llm.scriptCompletion(() => ({ text: 'Studio AI received your attached reference.' }));

        await attachSampleImage(page, studioRoot.locator('.sdlens-studio-compose'));
        expect(listAiAttachments()).toEqual([]);

        const reqBeforeTurn1 = llm.requests.length;
        await studioRoot.locator('[data-sd-role="studio-input"]').fill('Describe this composition for our next image.');
        await studioRoot.locator('[data-sd-role="studio-send"]').click();
        await expect(studioRoot.locator('.sdlens-studio-messages')).toContainText('Studio AI received your attached reference.', { timeout: 30_000 });

        const studioTurn1 = chatCompletionRequests(reqBeforeTurn1)[0];
        expect(extractImageDataUrls(studioTurn1.body.messages)).toContain(SAMPLE_DATA_URL);
        expect(extractAllText(studioTurn1.body.messages)).toMatch(/\[Attached image #1:\s*\/user\/images\/_ai_attachments\//);

        const filesAfterTurn1 = listAiAttachments();
        expect(filesAfterTurn1).toHaveLength(1);
        const origStudioFile = filesAfterTurn1[0];

        // Turn 2 replays Turn 1's image losslessly.
        const reqBeforeTurn2 = llm.requests.length;
        await studioRoot.locator('[data-sd-role="studio-input"]').fill('Keep the lighting from that image.');
        await studioRoot.locator('[data-sd-role="studio-send"]').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeTurn2).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(studioRoot.locator('[data-sd-role="studio-send"]')).toBeVisible({ timeout: 30_000 });
        expect(extractImageDataUrls(chatCompletionRequests(reqBeforeTurn2)[0].body.messages)).toContain(SAMPLE_DATA_URL);

        // Branch from here copies the attachment independently.
        const studioBranchBtn = studioRoot.locator('.sdlens-msg.is-assistant').last().locator('button').first();
        await studioBranchBtn.click();
        await expect.poll(() => listAiAttachments().length, { timeout: 15_000 }).toBe(2);
        const branchStudioFile = listAiAttachments().find(f => f !== origStudioFile);
        expect(branchStudioFile).toBeTruthy();

        // Delete both sessions -> _ai_attachments becomes empty.
        while ((await studioRoot.locator('[data-studio-session-id]').count()) > 0) {
            const countBefore = await studioRoot.locator('[data-studio-session-id]').count();
            await studioRoot.locator('[data-studio-session-id]').first().locator('button').last().click();
            await expect.poll(() => studioRoot.locator('[data-studio-session-id]').count(), { timeout: 15_000 }).toBeLessThan(countBefore);
        }
        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([]);

        await closeWorkbench(page);
    });

    test('CardApp Studio: lossless chat attachment, multi-turn replay, and clear-chat cleanup', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);

        await openCharacterList(page);
        await page.locator('#rm_print_characters_block .character_select').filter({ hasText: 'Seraphina' }).first().click();
        await expect(page.locator('#character_name_pole')).toHaveValue('Seraphina', { timeout: 15_000 });

        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'character_editor_assistant_settings');
        await page.locator('#cea_open_cardapp_studio').click();

        const leftPanel = page.locator('#card-app-studio-left');
        await expect(leftPanel).toBeVisible({ timeout: 15_000 });

        llm.setChatCompletionFailure(null);
        llm.scriptCompletion(() => ({ text: 'CardApp Studio saw your layout mockup.' }));

        await attachSampleImage(page, leftPanel.locator('.card-app-studio-composer'));
        expect(listAiAttachments()).toEqual([]);

        const reqBeforeTurn1 = llm.requests.length;
        await leftPanel.locator('[data-studio-input]').fill('Match this layout mockup.');
        await leftPanel.locator('[data-studio-action="send"]').click();
        await expect(leftPanel.locator('[data-studio-chat]')).toContainText('CardApp Studio saw your layout mockup.', { timeout: 30_000 });

        const turn1Req = chatCompletionRequests(reqBeforeTurn1)[0];
        expect(extractImageDataUrls(turn1Req.body.messages)).toContain(SAMPLE_DATA_URL);
        expect(listAiAttachments()).toHaveLength(1);

        // Turn 2 replays Turn 1's lossless image.
        const reqBeforeTurn2 = llm.requests.length;
        await leftPanel.locator('[data-studio-input]').fill('Refine the header spacing from that mockup.');
        await leftPanel.locator('[data-studio-action="send"]').click();
        await expect.poll(() => chatCompletionRequests(reqBeforeTurn2).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
        await expect(leftPanel.locator('[data-studio-action="send"]')).toBeEnabled({ timeout: 30_000 });
        expect(extractImageDataUrls(chatCompletionRequests(reqBeforeTurn2)[0].body.messages)).toContain(SAMPLE_DATA_URL);

        // Clear chat must delete owned _ai_attachments files from disk.
        await leftPanel.locator('[data-studio-action="clear-chat"]').click();
        await expect.poll(() => listAiAttachments(), { timeout: 15_000 }).toEqual([]);

        await leftPanel.locator('[data-studio-action="close"]').click();
        await expect(leftPanel).toBeHidden({ timeout: 10_000 });
    });
});
