// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end verification of backend-orchestrated plain-text function calling,
// format-correction retries, native HTTP passthrough, and Request Inspector UI
// (badge, parsed/failed status, retry linkage, and call-region raw text toggle
// preserving preceding thinking & text order).

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, openExtensionsDrawer, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

function startMockSearxng() {
    const queries = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/search') {
            const q = url.searchParams.get('q') || '';
            queries.push(q);
            const content = q.includes('Oakhaven')
                ? 'High tide at Oakhaven: 19:25'
                : 'High tide at Bryn-on-Sea: 18:40';
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                results: [{
                    title: 'Coastal Tide Almanac',
                    url: 'https://almanac.example/tides',
                    content,
                }],
            }));
            return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolveReady) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolveReady({
                baseURL: `http://127.0.0.1:${port}`,
                queries,
                async stop() {
                    server.closeAllConnections();
                    await new Promise(r => server.close(r));
                },
            });
        });
    });
}

function startScriptedPlainTextUpstream() {
    const requests = [];
    const handlers = [];
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.includes('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
            return;
        }
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = JSON.parse(rawBody); } catch { /* ignore */ }
            const record = { url: req.url, method: req.method, body };
            requests.push(record);

            const systemText = (body?.messages || [])
                .filter(m => m?.role === 'system')
                .map(m => (typeof m.content === 'string' ? m.content : ''))
                .join('\n');
            const triggerMatch = systemText.match(/<Function_[A-Za-z0-9]+_Start\/>/);
            const trigger = triggerMatch ? triggerMatch[0] : '';

            const handler = handlers.shift();
            if (!handler) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: `cmpl_default_${requests.length}`,
                    object: 'chat.completion',
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'Default upstream reply.' },
                        finish_reason: 'stop',
                    }],
                }));
                return;
            }
            const reply = handler({ body, trigger, record });
            if (Array.isArray(reply.sseChunks)) {
                res.writeHead(reply.status || 200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    'connection': 'keep-alive',
                });
                (async () => {
                    for (const chunk of reply.sseChunks) {
                        const line = typeof chunk === 'string'
                            ? `data: ${chunk}\n\n`
                            : `data: ${JSON.stringify(chunk)}\n\n`;
                        res.write(line);
                        await new Promise(r => setTimeout(r, 8));
                    }
                    res.end();
                })();
                return;
            }
            res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(reply.payload));
        });
    });

    return new Promise((resolveReady) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolveReady({
                baseURL: `http://127.0.0.1:${port}/v1`,
                requests,
                enqueue(fn) { handlers.push(fn); },
                clearHandlers() { handlers.length = 0; },
                async stop() {
                    server.closeAllConnections();
                    await new Promise(r => server.close(r));
                },
            });
        });
    });
}

let server;
let upstream;
let searxng;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    upstream = await startScriptedPlainTextUpstream();
    searxng = await startMockSearxng();
    server = await startServer({ scope, batchKey: 'extensions', scenarioId: '106-pt-fc-inspector' });
    markOnboarded({ dataRoot: server.dataRoot });
    bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: upstream.baseURL });
    appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: upstream.baseURL });

    const sp = resolve(server.dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(sp, 'utf8'));
    s.oai_settings = {
        ...(s.oai_settings || {}),
        function_calling: true,
        function_calling_plain_text: true,
        function_calling_plain_text_error_retry: true,
        function_calling_plain_text_error_retry_max_attempts: 2,
        show_thoughts: true,
        custom_prompt_post_processing: '',
        stream_openai: false,
    };
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = { ...(s.extension_settings.memory_graph || {}), enabled: false };
    writeFileSync(sp, JSON.stringify(s, null, 4));
    await server.restart();
});

async function setStreamingViaUi(page, enabled) {
    const panel = page.locator('#left-nav-panel');
    if (await panel.evaluate(el => el.classList.contains('closedDrawer'))) {
        await page.locator('#ai-config-button > .drawer-toggle > .drawer-icon').click();
        await expect(panel).toHaveClass(/\bopenDrawer\b/, { timeout: 5_000 });
    }
    const streamCheckbox = page.locator('#stream_toggle');
    if (!(await streamCheckbox.isVisible())) {
        const toggle = panel.locator('.inline-drawer', { has: streamCheckbox }).locator('> .inline-drawer-toggle').first();
        await toggle.click();
        await expect(streamCheckbox).toBeVisible({ timeout: 5_000 });
    }
    if (enabled) {
        await streamCheckbox.check();
    } else {
        await streamCheckbox.uncheck();
    }
    await closeAnyOpenTopSettingsDrawer(page);
}

async function enableSearchToolsViaUi(page, searxngBaseUrl) {
    await openExtensionsDrawer(page);
    const block = page.locator('#search_tools_settings');
    await expect(block).toBeVisible({ timeout: 10_000 });
    const content = block.locator('> .inline-drawer-content');
    if (!(await content.isVisible())) {
        await block.locator('> .inline-drawer-toggle').click();
        await expect(content).toBeVisible({ timeout: 5_000 });
    }
    const enabled = page.locator('#search_tools_enabled');
    if (!(await enabled.isChecked())) {
        await enabled.check();
    }
    const provider = page.locator('#search_tools_provider');
    if ((await provider.inputValue()) !== 'searxng') {
        await provider.selectOption('searxng');
    }
    const baseUrlInput = page.locator('#search_tools_field_baseUrl');
    await expect(baseUrlInput).toBeVisible({ timeout: 5_000 });
    if ((await baseUrlInput.inputValue()) !== searxngBaseUrl) {
        const savedPromise = page.waitForResponse(
            r => (r.url().endsWith('/api/settings/save') || r.url().endsWith('/api/settings/patch')) && r.status() === 200,
            { timeout: 10_000 },
        );
        await baseUrlInput.fill(searxngBaseUrl);
        await baseUrlInput.blur();
        await savedPromise;
    }
    await expect.poll(() => page.evaluate(() => {
        const s = window.Luker.getContext().extensionSettings?.search_tools;
        return {
            enabled: Boolean(s?.enabled),
            provider: s?.provider || '',
            baseUrl: s?.providers?.searxng?.baseUrl || '',
        };
    })).toEqual({
        enabled: true,
        provider: 'searxng',
        baseUrl: searxngBaseUrl,
    });
    await closeAnyOpenTopSettingsDrawer(page);
}

test.afterAll(async () => {
    await upstream?.stop();
    await searxng?.stop();
});

test.describe('Plain-text function calling backend orchestration & Request Inspector UI', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(() => {
        upstream.clearHandlers();
    });

    test('backend retry, tool execution, Inspector raw toggle preserving thinking + text order, and normal prose', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 });

        await setStreamingViaUi(page, false);
        await enableSearchToolsViaUi(page, searxng.baseURL);

        // Script upstream sequence:
        //   1. Attempt 1: malformed JSON inside <args_json> after backend trigger
        //   2. Attempt 2 (backend format-correction retry): valid reasoning + preamble + plain-text tool call
        //   3. Post-tool round: normal final prose referencing the tool result
        let observedTrigger = '';
        upstream.enqueue(({ trigger }) => {
            observedTrigger = trigger;
            return {
                status: 200,
                payload: {
                    id: 'cmpl_pt_attempt1',
                    object: 'chat.completion',
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            reasoning_content: 'Drafting tide lookup.',
                            content: `Consulting the almanac.\n${trigger}\n<function_calls><function_call><tool>luker_web_search</tool><args_json><![CDATA[{"query":]]></args_json></function_call></function_calls>`,
                        },
                        finish_reason: 'stop',
                    }],
                },
            };
        });
        upstream.enqueue(({ trigger }) => ({
            status: 200,
            payload: {
                id: 'cmpl_pt_attempt2',
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        reasoning_content: 'Correcting the JSON payload for luker_web_search.',
                        content: `Checking the tide table now.\n${trigger}\n<function_calls><function_call><tool>luker_web_search</tool><args_json><![CDATA[{"query":"Bryn-on-Sea high tide"}]]></args_json></function_call></function_calls>`,
                    },
                    finish_reason: 'stop',
                }],
            },
        }));
        upstream.enqueue(() => ({
            status: 200,
            payload: {
                id: 'cmpl_pt_final',
                object: 'chat.completion',
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'High tide at Bryn-on-Sea arrives at 18:40 tonight.',
                    },
                    finish_reason: 'stop',
                }],
            },
        }));

        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, 'When is high tide at Bryn-on-Sea tonight?');

        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.some((m, i) => i > targetLen && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.includes('18:40'));
        }, chatLenBefore, { timeout: 60_000 });

        // Verify upstream received 3 requests (Attempt 1, backend retry Attempt 2, post-tool Round 2),
        // with ZERO luker_plain_text_tools or native tools leaked upstream.
        expect(observedTrigger).toMatch(/^<Function_[A-Za-z0-9]+_Start\/>$/);
        expect(upstream.requests).toHaveLength(3);
        expect(searxng.queries).toContain('Bryn-on-Sea high tide');
        for (const req of upstream.requests) {
            expect(req.body.luker_plain_text_tools).toBeUndefined();
            expect(req.body.tools).toBeUndefined();
            expect(req.body.tool_choice).toBeUndefined();
        }
        // Round 2 carries the normalized <tool_result> from executing luker_web_search.
        const round2Messages = upstream.requests[2].body.messages || [];
        expect(round2Messages.some(m => m.role === 'user' && String(m.content || '').includes('High tide at Bryn-on-Sea: 18:40'))).toBe(true);

        // Open User Settings drawer, then Request Inspector via real UI button clicks.
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
        await page.locator('#request_inspector_button').click();
        await expect(page.locator('.ri-table tbody tr.ri-row')).toHaveCount(3, { timeout: 15_000 });

        // List is newest-first: row 0 = final prose, row 1 = retry Attempt 2 (parsed), row 2 = Attempt 1 (parse failed).
        await page.locator('.ri-table tbody tr.ri-row').nth(1).click();
        await expect(page.locator('.ri-detail')).toBeVisible();

        // Attempt 2 detail shows Plain-Text Function Call badge, Parsed status,
        // Retry Of button, and exact DOM order: reasoning -> text -> plain_text_tool_calls.
        await expect(page.locator('.ri-pt-call-region .ri-pt-badge')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-status-parsed')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-tool-call-name')).toHaveText('luker_web_search');
        await expect(page.locator('.ri-pt-call-region .ri-tool-call-args')).toContainText('Bryn-on-Sea');

        const responseSection = page.locator('.ri-detail-body .ri-detail-section').first();
        const childOrderBeforeToggle = await responseSection.evaluate((sec) => {
            return Array.from(sec.children)
                .filter(el => el.tagName !== 'H4')
                .map(el => {
                    if (el.classList.contains('ri-reasoning')) return 'reasoning';
                    if (el.classList.contains('ri-response-body')) return 'text';
                    if (el.classList.contains('ri-pt-call-region')) return 'pt_call';
                    return el.className;
                });
        });
        expect(childOrderBeforeToggle).toEqual(['reasoning', 'text', 'pt_call']);
        await expect(responseSection.locator('.ri-response-body')).toHaveText('Checking the tide table now.');

        // Toggle call-region raw text ON -> ONLY call region switches; preceding reasoning + text stay untouched in order.
        const rawToggle = page.locator('.ri-pt-call-region .ri-pt-raw-toggle');
        await rawToggle.click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-view')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-parsed-view')).toBeHidden();
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-text')).toContainText(observedTrigger);
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-text')).toContainText('<function_calls>');
        await expect(responseSection.locator('.ri-response-body')).toHaveText('Checking the tide table now.');
        await expect(responseSection.locator('.ri-reasoning')).toBeVisible();

        // Toggle back to parsed view.
        await rawToggle.click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-parsed-view')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-view')).toBeHidden();

        // Follow the Retry Of link to inspect Attempt 1's preserved parse failure + raw toggle.
        await page.locator('.ri-jump-entry').first().click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-status-failed')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-error-msg')).toContainText('not valid JSON');
        await page.locator('.ri-pt-call-region .ri-pt-raw-toggle').click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-text')).toContainText('{"query":');
    });

    test('streaming mode suppresses split trigger tags, retries malformed JSON, executes tool, and preserves Inspector raw toggle', async ({ page }) => {
        const reqStart = upstream.requests.length;

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 });

        await setStreamingViaUi(page, true);
        await enableSearchToolsViaUi(page, searxng.baseURL);

        await page.evaluate(() => {
            // Read-only DOM observer during streaming to verify raw trigger tags / XML never appear in .mes_text.
            window.__ptStreamLeaks = [];
            const chatEl = document.getElementById('chat');
            const inspectNodes = () => {
                for (const node of chatEl.querySelectorAll('.mes_text')) {
                    const txt = node.textContent || '';
                    if (txt.includes('<Function_') || txt.includes('<function_calls>')) {
                        window.__ptStreamLeaks.push(txt);
                    }
                }
            };
            window.__ptStreamObserver = new MutationObserver(inspectNodes);
            window.__ptStreamObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });
        });

        const makeDeltaChunk = (id, delta, finishReason = null) => ({
            id,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        });

        let observedTrigger = '';
        // Attempt 1 (streaming): split trigger across SSE chunks + malformed args JSON.
        upstream.enqueue(({ trigger }) => {
            observedTrigger = trigger;
            const splitAt = Math.floor(trigger.length / 2);
            return {
                status: 200,
                sseChunks: [
                    makeDeltaChunk('cmpl_pts_1', { role: 'assistant', reasoning_content: 'Drafting harbor lookup.' }),
                    makeDeltaChunk('cmpl_pts_1', { content: 'Consulting the harbor chart.\n' }),
                    makeDeltaChunk('cmpl_pts_1', { content: trigger.slice(0, splitAt) }),
                    makeDeltaChunk('cmpl_pts_1', { content: trigger.slice(splitAt) }),
                    makeDeltaChunk('cmpl_pts_1', { content: '\n<function_calls><function_call><tool>luker_web_search</tool><args_json><![CDATA[{"query":]]></args_json></function_call></function_calls>' }),
                    makeDeltaChunk('cmpl_pts_1', {}, 'stop'),
                    '[DONE]',
                ],
            };
        });
        // Attempt 2 (backend format-correction retry): backend executes retry non-streaming (`stream: false`).
        upstream.enqueue(({ body, trigger }) => {
            expect(body.stream).toBe(false);
            return {
                status: 200,
                payload: {
                    id: 'cmpl_pts_2',
                    object: 'chat.completion',
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            reasoning_content: 'Repairing JSON for Oakhaven.',
                            content: `Re-checking the tide table.\n${trigger}\n<function_calls><function_call><tool>luker_web_search</tool><args_json><![CDATA[{"query":"Oakhaven high tide"}]]></args_json></function_call></function_calls>`,
                        },
                        finish_reason: 'stop',
                    }],
                },
            };
        });
        // Round 2 (streaming post-tool): clean final prose.
        upstream.enqueue(() => ({
            status: 200,
            sseChunks: [
                makeDeltaChunk('cmpl_pts_3', { role: 'assistant', content: 'High tide at Oakhaven ' }),
                makeDeltaChunk('cmpl_pts_3', { content: 'arrives at 19:25 tonight.' }),
                makeDeltaChunk('cmpl_pts_3', {}, 'stop'),
                '[DONE]',
            ],
        }));

        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, 'When is high tide at Oakhaven tonight?');

        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            return ctx.chat.some((m, i) => i > targetLen && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.includes('19:25'));
        }, chatLenBefore, { timeout: 60_000 });

        const streamCheck = await page.evaluate(() => {
            window.__ptStreamObserver?.disconnect();
            const texts = Array.from(document.querySelectorAll('#chat .mes .mes_text')).map(el => el.textContent || '');
            return {
                leaks: window.__ptStreamLeaks || [],
                lastText: texts[texts.length - 1] || '',
            };
        });
        expect(streamCheck.leaks).toEqual([]);
        expect(streamCheck.lastText).toContain('High tide at Oakhaven arrives at 19:25 tonight.');
        expect(streamCheck.lastText).not.toContain('<Function_');
        expect(streamCheck.lastText).not.toContain('<function_calls>');

        const runRequests = upstream.requests.slice(reqStart);
        expect(observedTrigger).toMatch(/^<Function_[A-Za-z0-9]+_Start\/>$/);
        expect(runRequests).toHaveLength(3);
        expect(searxng.queries).toContain('Oakhaven high tide');
        expect(runRequests[0].body.stream).toBe(true);
        expect(runRequests[1].body.stream).toBe(false);
        expect(runRequests[2].body.stream).toBe(true);
        for (const req of runRequests) {
            expect(req.body.luker_plain_text_tools).toBeUndefined();
            expect(req.body.tools).toBeUndefined();
            expect(req.body.tool_choice).toBeUndefined();
        }
        const round2Messages = runRequests[2].body.messages || [];
        expect(round2Messages.some(m => m.role === 'user' && String(m.content || '').includes('High tide at Oakhaven: 19:25'))).toBe(true);

        // Open Request Inspector via UI and inspect the 3 newest streaming rows.
        await page.locator('#user-settings-button .drawer-toggle').click();
        await page.waitForFunction(() => {
            const el = document.getElementById('user-settings-block');
            return el && !el.classList.contains('closedDrawer');
        }, { timeout: 5_000 });
        await page.locator('#request_inspector_button').click();
        await page.waitForFunction(() => document.querySelectorAll('.ri-table tbody tr.ri-row').length >= 3, { timeout: 15_000 });

        // Row 1 (second newest) = streaming retry Attempt 2 (parsed).
        await page.locator('.ri-table tbody tr.ri-row').nth(1).click();
        await expect(page.locator('.ri-detail')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-status-parsed')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-tool-call-name')).toHaveText('luker_web_search');
        await expect(page.locator('.ri-pt-call-region .ri-tool-call-args')).toContainText('Oakhaven');

        const responseSection = page.locator('.ri-detail-body .ri-detail-section').first();
        const childOrder = await responseSection.evaluate((sec) => {
            return Array.from(sec.children)
                .filter(el => el.tagName !== 'H4')
                .map(el => {
                    if (el.classList.contains('ri-reasoning')) return 'reasoning';
                    if (el.classList.contains('ri-response-body')) return 'text';
                    if (el.classList.contains('ri-pt-call-region')) return 'pt_call';
                    return el.className;
                });
        });
        expect(childOrder).toEqual(['reasoning', 'text', 'pt_call']);
        await expect(responseSection.locator('.ri-response-body')).toHaveText('Re-checking the tide table.');

        // Toggle raw view on and verify trigger + XML preserved while preamble + reasoning remain intact.
        await page.locator('.ri-pt-call-region .ri-pt-raw-toggle').click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-text')).toContainText(observedTrigger);
        await expect(page.locator('.ri-pt-call-region .ri-pt-raw-text')).toContainText('Oakhaven');
        await expect(responseSection.locator('.ri-response-body')).toHaveText('Re-checking the tide table.');
        await expect(responseSection.locator('.ri-reasoning')).toBeVisible();

        // Jump to Attempt 1 via Retry Of button and verify preserved parse failure.
        await page.locator('.ri-jump-entry').first().click();
        await expect(page.locator('.ri-pt-call-region .ri-pt-status-failed')).toBeVisible();
        await expect(page.locator('.ri-pt-call-region .ri-pt-error-msg')).toContainText('not valid JSON');
    });
});
