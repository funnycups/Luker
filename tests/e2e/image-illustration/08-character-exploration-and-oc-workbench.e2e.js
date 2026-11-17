// SPDX-License-Identifier: AGPL-3.0-or-later

import http from 'node:http';
import zlib from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import {
    awaitMainUI,
    closeAnyOpenTopSettingsDrawer,
    openExtensionsDrawer,
    openInlineDrawer,
    selectCharacterByName,
    sendMessageAndAwaitReply,
} from '../_lib/page.js';

test.describe.configure({ mode: 'serial' });

function createSolidPngBuffer(width = 128, height = 128, [r, g, b] = [68, 120, 195]) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunk = (type, data) => {
        const typeBuf = Buffer.from(type, 'ascii');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(data.length, 0);
        const crcBuf = Buffer.alloc(4);
        const crcVal = zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0;
        crcBuf.writeUInt32BE(crcVal, 0);
        return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
    };

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const stride = 1 + width * 3;
    const rawPixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const rowOffset = y * stride;
        rawPixels[rowOffset] = 0; // filter None
        for (let x = 0; x < width; x++) {
            const px = rowOffset + 1 + x * 3;
            rawPixels[px] = r;
            rawPixels[px + 1] = g;
            rawPixels[px + 2] = b;
        }
    }
    const idat = zlib.deflateSync(rawPixels);
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

async function startScenarioMocks() {
    const refSheetPng = createSolidPngBuffer(128, 128, [45, 95, 185]);
    const generatedPortraitPng = createSolidPngBuffer(128, 128, [185, 95, 135]);
    const generatedPortraitBase64 = generatedPortraitPng.toString('base64');

    const llmRequests = [];
    const geminiRequests = [];
    const searchImageRequests = [];
    const proxyRequests = [];

    let exploreCallCount = 0;

    const llmServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'mock-agent-llm' }] }));
            return;
        }

        const body = raw ? JSON.parse(raw) : {};
        llmRequests.push(body);

        const tools = Array.isArray(body.tools) ? body.tools.map(t => t.function?.name) : [];
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const lastUserText = [...messages].reverse().find(m => m.role === 'user' && typeof m.content === 'string')?.content || '';
        const toolMessages = messages.filter(m => m.role === 'tool');

        const sendToolCalls = (calls) => {
            const normalizedCalls = calls.map((c, index) => ({
                index,
                id: c.id || `call_${llmRequests.length}_${index}`,
                type: 'function',
                function: {
                    name: c.name,
                    arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}),
                },
            }));
            if (body.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${llmRequests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant', content: '', tool_calls: normalizedCalls },
                        finish_reason: null,
                    }],
                })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${llmRequests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                })}\n\n`);
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `chatcmpl_${llmRequests.length}`,
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    finish_reason: 'tool_calls',
                    message: {
                        role: 'assistant',
                        content: '',
                        tool_calls: normalizedCalls.map(({ index: _idx, ...rest }) => rest),
                    },
                }],
            }));
        };

        const sendToolCall = (name, args, id = `call_${llmRequests.length}`) => {
            sendToolCalls([{ id, name, args }]);
        };

        const sendText = (content) => {
            if (body.stream) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${llmRequests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
                })}\n\n`);
                res.write(`data: ${JSON.stringify({
                    id: `chatcmpl_${llmRequests.length}`,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                })}\n\n`);
                res.end('data: [DONE]\n\n');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: `chatcmpl_${llmRequests.length}`,
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    finish_reason: 'stop',
                    message: { role: 'assistant', content },
                }],
            }));
        };

        // 1. Main roleplay chat reply (no tools)
        if (tools.length === 0) {
            if (lastUserText.includes('Aurelia enters')) {
                sendText('Aurelia stepped onto the starlit balcony and raised the astrolabe.');
                return;
            }
            if (lastUserText.includes('Vesper returns')) {
                sendText('Vesper unfolded the celestial map across the oak desk.');
                return;
            }
            sendText('Vesper adjusted her silver compass beside the lantern.');
            return;
        }

        // 2. Exploration agent toolset
        if (tools.includes('save_character_profile')) {
            if (toolMessages.length === 0) {
                exploreCallCount += 1;
                sendToolCalls([
                    { id: 'exp_card', name: 'read_character_card', args: {} },
                    { id: 'exp_lore', name: 'lorebook_get', args: { book_name: 'StarlightCanon', uids: [0] } },
                    { id: 'exp_search', name: 'search_character_sources', args: { source: 'web', query: 'Vesper Starlight' } },
                ]);
                return;
            }
            if (toolMessages.length === 3) {
                sendToolCall('fetch_reference_image', {
                    image_url: 'http://cdn.art-archive.example/vesper_sheet.png',
                    profile_id: 'char_vesper',
                }, 'exp_fetch');
                return;
            }
            if (toolMessages.length === 4) {
                const fetchOut = JSON.parse(toolMessages[3].content);
                sendToolCall('save_character_profile', {
                    id: 'char_vesper',
                    name: 'Vesper',
                    source_work: 'Starlight',
                    canonical_tags: ['1girl', 'silver hair', 'cobalt cloak'],
                    outfits: [{
                        id: 'outfit_navigator',
                        name: 'Navigator Cloak',
                        tags: ['cobalt cloak', 'silver compass'],
                        reference_images: [fetchOut.imagePath],
                    }],
                    default_outfit_id: 'outfit_navigator',
                }, 'exp_save');
                return;
            }
            sendText('Archived Vesper visual profile.');
            return;
        }

        // 3. Studio character_design toolset
        if (tools.includes('stage_character_profile')) {
            const userTurns = messages.filter(m => m.role === 'user');
            if (userTurns.length === 1) {
                if (toolMessages.length === 0) {
                    sendToolCalls([
                        { id: 'st_card', name: 'read_character_card', args: {} },
                        { id: 'st_lore', name: 'lorebook_get', args: { book_name: 'StarlightCanon', uids: [1] } },
                    ]);
                    return;
                }
                if (toolMessages.length === 2) {
                    sendToolCall('generate_image', {
                        prompt: '1girl, Aurelia, golden circlet, starlit white gown, character sheet',
                    }, 'st_gen_1');
                    return;
                }
                sendText('Generated initial Aurelia portrait.');
                return;
            }

            // Second user turn in Studio: refine + stage_character_profile
            const lastAssistantIdx = messages.map(m => m.role).lastIndexOf('assistant');
            const toolsSinceSecondUser = lastAssistantIdx > messages.map(m => m.role).lastIndexOf('user')
                ? messages.slice(messages.map(m => m.role).lastIndexOf('user')).filter(m => m.role === 'tool')
                : [];
            if (toolsSinceSecondUser.length === 0) {
                sendToolCall('generate_image', {
                    prompt: '1girl, Aurelia, golden circlet, sapphire sash, starlit white gown, refined sheet',
                }, 'st_gen_2');
                return;
            }
            if (toolsSinceSecondUser.length === 1) {
                const latestImg = JSON.parse(toolsSinceSecondUser[0].content);
                sendToolCall('stage_character_profile', {
                    profile_id: 'char_aurelia',
                    name: 'Aurelia',
                    source_work: 'Original',
                    canonical_tags: ['1girl', 'golden circlet', 'amber eyes'],
                    outfits: [{
                        id: 'outfit_gala',
                        name: 'Starlit Gown',
                        tags: ['starlit white gown', 'sapphire sash'],
                        image_ids: [latestImg.image_id],
                    }],
                    default_outfit_id: 'outfit_gala',
                }, 'st_stage');
                return;
            }
            sendText('Staged Aurelia profile for archive review.');
            return;
        }

        // 4. Illustration agent toolset
        if (tools.includes('add_image_prompt')) {
            const archiveMatch = /<character_archive>\n([\s\S]*?)\n<\/character_archive>/.exec(lastUserText);
            const archiveText = archiveMatch ? archiveMatch[1] : '';

            // Aurelia scene
            if (lastUserText.includes('Aurelia stepped onto the starlit balcony')) {
                if (toolMessages.length === 0) {
                    const m = /id=(char_[a-zA-Z0-9_-]+) \| name=Aurelia/.exec(archiveText);
                    sendToolCall('read_character_profiles', { ids: [m ? m[1] : 'char_aurelia'] }, 'ill_read_oc');
                    return;
                }
                const m = /id:\s*(char_[a-zA-Z0-9_-]+)/.exec(toolMessages[0].content);
                sendToolCall('add_image_prompt', {
                    prompt: '1girl, Aurelia, golden circlet, starlit white gown, balcony astrolabe',
                    character_refs: [{ profile_id: m ? m[1] : 'char_aurelia', outfit_id: 'outfit_gala' }],
                    insert_after: 'stepped onto the starlit balcony',
                    insert_before: 'and raised the astrolabe.',
                }, 'ill_prompt_oc');
                return;
            }

            // Vesper scene: if not in archive yet, call explore_characters; if already archived, call read_character_profiles!
            if (!archiveText.includes('name=Vesper')) {
                if (toolMessages.length === 0) {
                    sendToolCall('explore_characters', {
                        targets: [{ name: 'Vesper', work: 'Starlight' }],
                    }, 'ill_explore_vesper');
                    return;
                }
                sendToolCall('add_image_prompt', {
                    prompt: '1girl, Vesper, silver hair, cobalt cloak, silver compass beside lantern',
                    character_refs: [{ profile_id: 'char_vesper', outfit_id: 'outfit_navigator' }],
                    insert_after: 'adjusted her silver compass',
                    insert_before: 'beside the lantern.',
                }, 'ill_prompt_vesper_1');
                return;
            }

            // Vesper already in <character_archive> -> skip explore_characters!
            if (toolMessages.length === 0) {
                sendToolCall('read_character_profiles', { ids: ['char_vesper'] }, 'ill_read_vesper_cached');
                return;
            }
            sendToolCall('add_image_prompt', {
                prompt: '1girl, Vesper, silver hair, cobalt cloak, unfolding celestial map',
                character_refs: [{ profile_id: 'char_vesper', outfit_id: 'outfit_navigator' }],
                insert_after: 'unfolded the celestial map',
                insert_before: 'across the oak desk.',
            }, 'ill_prompt_vesper_2');
            return;
        }

        sendText('OK');
    });

    const geminiServer = http.createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname.endsWith('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                models: [{ name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] }],
            }));
            return;
        }
        const body = raw ? JSON.parse(raw) : {};
        geminiRequests.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            candidates: [{
                content: {
                    parts: [{
                        inlineData: {
                            mimeType: 'image/png',
                            data: generatedPortraitBase64,
                        },
                    }],
                },
            }],
        }));
    });

    const searxngServer = http.createServer(async (req, res) => {
        searchImageRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            results: [{
                title: 'Vesper Official Reference Sheet',
                img_src: 'http://cdn.art-archive.example/vesper_sheet.png',
                thumbnail_src: 'http://cdn.art-archive.example/vesper_sheet.png',
                url: 'http://cdn.art-archive.example/vesper',
                img_format: '128 x 128',
            }],
        }));
    });

    const artProxyServer = http.createServer((req, res) => {
        proxyRequests.push(req.url);
        if (String(req.url).includes('vesper_sheet.png')) {
            res.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(refSheetPng.length),
            });
            res.end(refSheetPng);
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
    });

    await Promise.all([
        new Promise(r => llmServer.listen(0, '127.0.0.1', r)),
        new Promise(r => geminiServer.listen(0, '127.0.0.1', r)),
        new Promise(r => searxngServer.listen(0, '127.0.0.1', r)),
        new Promise(r => artProxyServer.listen(0, '127.0.0.1', r)),
    ]);

    return {
        llmURL: `http://127.0.0.1:${llmServer.address().port}/v1`,
        geminiURL: `http://127.0.0.1:${geminiServer.address().port}`,
        searxngURL: `http://127.0.0.1:${searxngServer.address().port}`,
        proxyURL: `http://127.0.0.1:${artProxyServer.address().port}`,
        llmRequests,
        geminiRequests,
        searchImageRequests,
        proxyRequests,
        getExploreCount: () => exploreCallCount,
        async stop() {
            for (const srv of [llmServer, geminiServer, searxngServer, artProxyServer]) {
                srv.closeAllConnections?.();
            }
            await Promise.all([
                new Promise(r => llmServer.close(r)),
                new Promise(r => geminiServer.close(r)),
                new Promise(r => searxngServer.close(r)),
                new Promise(r => artProxyServer.close(r)),
            ]);
        },
    };
}

function seedWorldbookAndSecrets({ dataRoot, searxngURL, geminiURL }) {
    const worldPath = resolve(dataRoot, 'default-user', 'worlds', 'StarlightCanon.json');
    mkdirSync(dirname(worldPath), { recursive: true });
    writeFileSync(worldPath, JSON.stringify({
        entries: {
            0: {
                uid: 0,
                key: ['Vesper'],
                comment: 'Vesper Appearance',
                content: 'Vesper has silver hair, wears a cobalt navigator cloak, and carries a silver compass.',
                disable: false,
                constant: true,
            },
            1: {
                uid: 1,
                key: ['Aurelia'],
                comment: 'Aurelia OC Notes',
                content: 'Aurelia is an original astronomer heroine with amber eyes, a golden circlet, and a starlit white gown.',
                disable: false,
                constant: true,
            },
        },
    }, null, 2));

    const secretsFile = resolve(dataRoot, 'default-user', 'secrets.json');
    let secrets = {};
    try { secrets = JSON.parse(readFileSync(secretsFile, 'utf8')); } catch { /* ignore */ }
    secrets._migrated = true;
    secrets.api_key_makersuite = [
        { id: 'sec-gemini-e2e', value: 'gemini-e2e-key', label: 'GeminiE2E', active: true },
    ];
    writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));

    const settingsFile = resolve(dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    settings.world_info = { globalSelect: ['StarlightCanon'] };
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.connectionManager = settings.extension_settings.connectionManager || { profiles: [] };
    settings.extension_settings.connectionManager.profiles.push({
        id: 'gemini-img-profile',
        name: 'Gemini Image Relay',
        mode: 'cc',
        api: 'makersuite',
        model: 'gemini-2.5-flash-image',
        'api-url': geminiURL,
        'secret-id': 'sec-gemini-e2e',
    });
    settings.extension_settings.search_tools = {
        enabled: true,
        provider: 'searxng',
        providers: {
            searxng: {
                baseUrl: searxngURL,
                safeSearch: 'moderate',
            },
        },
    };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

let server, mocks;

test.beforeAll(async () => {
    mocks = await startScenarioMocks();
    server = await startServer({
        batchKey: 'image-illustration',
        scenarioId: '08-exploration-oc-wb',
        extraConfig: {
            'requestProxy.enabled': true,
            'requestProxy.url': `"${mocks.proxyURL}"`,
        },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mocks.llmURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mocks.llmURL, api: 'custom' });
    seedWorldbookAndSecrets({
        dataRoot: server.dataRoot,
        searxngURL: mocks.searxngURL,
        geminiURL: mocks.geminiURL,
    });
});

test.afterAll(async () => {
    await tearDownServer(server);
    await mocks?.stop();
});

test.describe('character exploration archive and OC Workbench studio', () => {
    test('explores unknown character once, reuses cached GlobalState archive on subsequent turn, and designs + promotes OC reference sheet in Workbench', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        // Connect main chat LLM
        await page.locator('#sys-settings-button > .drawer-toggle').click();
        await page.locator('#api_button_openai').click();
        await page.locator('#send_but:not(.displayNone)').waitFor({ state: 'visible', timeout: 30_000 });
        await closeAnyOpenTopSettingsDrawer(page);

        // Configure Google Gemini native image backend bound to Gemini Image Relay connection profile via real UI
        await openExtensionsDrawer(page);
        await openInlineDrawer(page, 'sd_container');
        await page.locator('#sd_source').selectOption('google');
        await page.locator('#sd_model').selectOption('gemini-2.5-flash-image');
        await page.locator('#sd_connection_profile').selectOption('Gemini Image Relay');

        await openInlineDrawer(page, 'sd_illustration_container');
        await page.locator('#sd_illustration_enabled').check();
        await page.locator('#sd_illustration_auto_generate').check();
        await closeAnyOpenTopSettingsDrawer(page);

        // --- Part 1: Auto-illustration dispatches explore_characters -> searches web + fetches PNG -> generates with reference ---
        await sendMessageAndAwaitReply(page, 'Introduce Vesper.');

        await page.waitForFunction(() => {
            const msg = window.Luker.getContext().chat.at(-1);
            return Array.isArray(msg?.extra?.illustrations) && msg.extra.illustrations.length === 1;
        }, null, { timeout: 60_000 });

        expect(mocks.getExploreCount()).toBe(1);
        expect(mocks.searchImageRequests.length).toBeGreaterThanOrEqual(1);
        expect(mocks.proxyRequests.some(u => String(u).includes('vesper_sheet.png'))).toBe(true);
        expect(mocks.geminiRequests).toHaveLength(1);
        const firstGeminiParts = mocks.geminiRequests[0].contents?.[0]?.parts || [];
        expect(firstGeminiParts.some(p => p.inlineData?.mimeType === 'image/png')).toBe(true);

        // Verify states/sd_character_profiles.json persisted on disk
        const archiveFile = resolve(server.dataRoot, 'default-user', 'states', 'sd_character_profiles.json');
        expect(existsSync(archiveFile)).toBe(true);
        const archiveJson1 = JSON.parse(readFileSync(archiveFile, 'utf8'));
        expect(archiveJson1.profiles?.char_vesper?.name).toBe('Vesper');

        // Second message with Vesper -> hits cached <character_archive>, skips explore_characters!
        await sendMessageAndAwaitReply(page, 'Vesper returns with the map.');
        await page.waitForFunction(() => {
            const msg = window.Luker.getContext().chat.at(-1);
            return Array.isArray(msg?.extra?.illustrations) && msg.extra.illustrations.length === 1;
        }, null, { timeout: 60_000 });

        expect(mocks.getExploreCount()).toBe(1);
        expect(mocks.geminiRequests).toHaveLength(2);
        const secondGeminiParts = mocks.geminiRequests[1].contents?.[0]?.parts || [];
        expect(secondGeminiParts.some(p => p.inlineData?.mimeType === 'image/png')).toBe(true);

        // --- Part 2: Open Workbench -> Character Archive -> per-action OC design -> Studio multi-turn -> Apply -> Chat illustration + History Undo ---
        await page.locator('#extensionsMenuButton').click();
        await page.locator('#sd_illustration_open_studio').click();
        const wbWin = page.locator('.wbench .wb-win:not([hidden])');
        await expect(wbWin).toBeVisible({ timeout: 10_000 });

        // Switch to Character Archive subview and use per-invocation OC design launcher
        await wbWin.locator('[data-sd-nav="characters"]').click();
        await expect(wbWin.locator('[data-sd-view="characters"]')).toBeVisible();
        await expect(wbWin.locator('[data-sd-view="characters"]')).toContainText('Vesper');

        await wbWin.locator('[data-sd-launch-mode="oc"]').click();
        await wbWin.locator('[data-sd-role="launch-target-input"]').fill('Aurelia');
        await wbWin.locator('[data-sd-role="launch-submit"]').click();

        // Automatically enters Studio in character_design mode
        const studioView = wbWin.locator('[data-sd-view="studio"]');
        await expect(studioView).toBeVisible();

        // Turn 1 in OC Studio: reads card + lorebook and generates initial candidate portrait
        await studioView.locator('[data-sd-role="studio-input"]').fill('Design Aurelia from the lorebook notes.');
        await studioView.locator('[data-sd-role="studio-send"]').click();
        await expect(studioView.locator('[data-studio-image-id]')).toHaveCount(1, { timeout: 30_000 });

        // Turn 2 in OC Studio: user refines -> generates 2nd candidate + stages character profile review card
        await studioView.locator('[data-sd-role="studio-input"]').fill('Add a sapphire sash and stage her profile.');
        await studioView.locator('[data-sd-role="studio-send"]').click();
        await expect(studioView.locator('[data-studio-image-id]')).toHaveCount(2, { timeout: 30_000 });
        const applyBtn = studioView.locator('[data-sd-role="apply-staged-profile"]');
        await expect(applyBtn).toBeVisible({ timeout: 15_000 });

        // Click Apply -> promotes _studio portrait into /user/images/_references/ and writes to sd_character_profiles
        await applyBtn.click();
        await expect(studioView.locator('[data-sd-role="staged-proposal"]')).toHaveCount(0, { timeout: 10_000 });

        await expect.poll(() => {
            const disk = JSON.parse(readFileSync(archiveFile, 'utf8'));
            return disk.profiles?.char_aurelia?.outfits?.[0]?.referenceImages?.[0] || '';
        }, { timeout: 10_000 }).toContain('/user/images/_references/');

        // Fold Workbench, send chat message featuring Aurelia -> Illustration Agent binds Aurelia's promoted OC reference image!
        await page.locator('.wbench .wb-titlebar .lw-ibtn.is-close').click();
        await expect(wbWin).toBeHidden();

        const geminiCountBeforeOc = mocks.geminiRequests.length;
        await sendMessageAndAwaitReply(page, 'Aurelia enters the observatory.');
        await page.waitForFunction(() => {
            const msg = window.Luker.getContext().chat.at(-1);
            return Array.isArray(msg?.extra?.illustrations) && msg.extra.illustrations.length === 1;
        }, null, { timeout: 60_000 });

        expect(mocks.geminiRequests.length).toBe(geminiCountBeforeOc + 1);
        const ocGeminiParts = mocks.geminiRequests.at(-1).contents?.[0]?.parts || [];
        expect(ocGeminiParts.some(p => p.inlineData?.mimeType === 'image/png')).toBe(true);
        expect(ocGeminiParts.some(p => String(p.text || '').includes('Aurelia'))).toBe(true);

        // Open Workbench Change History page and verify Undo removes Aurelia cleanly
        await page.locator('.wbench .wb-pill').click();
        await expect(wbWin).toBeVisible();
        await wbWin.locator('.wb-rail .wb-tab').nth(3).click();
        const undoBtn = wbWin.locator('.wb-hist-item button', { hasText: /Undo|撤销|撤銷/ }).first();
        await expect(undoBtn).toBeVisible();
        await undoBtn.click();

        await expect.poll(() => {
            const disk = JSON.parse(readFileSync(archiveFile, 'utf8'));
            return Boolean(disk.profiles?.char_aurelia);
        }, { timeout: 10_000 }).toBe(false);
    });
});
