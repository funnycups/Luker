// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end verification of Claude `pause_turn` server-tool continuation
// (both non-streaming and streaming) and safe source citation rendering +
// persistence across page reload.

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, closeAnyOpenTopSettingsDrawer, selectCharacterByName, sendMessageAndAwaitReply } from '../_lib/page.js';

function startScriptedAnthropicUpstream() {
    const requests = [];
    const handlers = [];

    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url?.includes('/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                data: [{
                    id: 'claude-opus-4-7',
                    display_name: 'Claude Opus 4.7',
                    type: 'model',
                }],
            }));
            return;
        }
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let body = null;
            try { body = JSON.parse(rawBody); } catch { /* ignore */ }
            const record = { url: req.url, method: req.method, headers: req.headers, body };
            requests.push(record);

            const handler = handlers.shift();
            if (!handler) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: `msg_default_${requests.length}`,
                    type: 'message',
                    role: 'assistant',
                    model: body?.model || 'claude-opus-4-7',
                    content: [{ type: 'text', text: 'Default Anthropic reply.' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 10, output_tokens: 5 },
                }));
                return;
            }

            const reply = handler({ body, record });
            if (Array.isArray(reply.sseEvents)) {
                res.writeHead(reply.status || 200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                    'connection': 'keep-alive',
                });
                (async () => {
                    for (const ev of reply.sseEvents) {
                        res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
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

function configureClaudeBackend({ dataRoot, baseURL }) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.main_api = 'openai';
    s.firstRun = false;
    s.power_user = { ...(s.power_user || {}), auto_connect: true };
    s.oai_settings = {
        ...(s.oai_settings || {}),
        chat_completion_source: 'claude',
        claude_model: 'claude-opus-4-7',
        openai_model: 'claude-opus-4-7',
        base_url: baseURL,
        reverse_proxy: '',
        stream_openai: false,
        show_thoughts: true,
        enable_web_search: true,
        custom_prompt_post_processing: '',
        continue_prefill: false,
    };
    s.extension_settings = s.extension_settings || {};
    s.extension_settings.memory_graph = { ...(s.extension_settings.memory_graph || {}), enabled: false };
    writeFileSync(settingsPath, JSON.stringify(s, null, 4));

    const secretsPath = resolve(dataRoot, 'default-user', 'secrets.json');
    let secrets = {};
    try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { /* ignore */ }
    secrets.api_key_claude = 'sk-ant-local-e2e-key';
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 4));
}

let server;
let upstream;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    upstream = await startScriptedAnthropicUpstream();
    server = await startServer({ scope, batchKey: 'extensions', scenarioId: '107-claude-pause-citations' });
    markOnboarded({ dataRoot: server.dataRoot });
    configureClaudeBackend({ dataRoot: server.dataRoot, baseURL: upstream.baseURL });
    await server.restart();
});

test.afterAll(async () => {
    await upstream?.stop();
});

async function configureClaudePromptControlsViaUi(page, { stream, assistantPrefill, postHistoryInstruction } = {}) {
    const panel = page.locator('#left-nav-panel');
    if (await panel.evaluate(el => el.classList.contains('closedDrawer'))) {
        await page.locator('#ai-config-button > .drawer-toggle > .drawer-icon').click();
        await expect(panel).toHaveClass(/\bopenDrawer\b/, { timeout: 5_000 });
    }
    const ensureVisible = async (locator) => {
        if (!(await locator.isVisible())) {
            const drawer = panel.locator('.inline-drawer', { has: locator }).first();
            await drawer.locator('> .inline-drawer-toggle').click();
            await expect(locator).toBeVisible({ timeout: 5_000 });
        }
    };
    if (typeof stream === 'boolean') {
        const streamCheckbox = page.locator('#stream_toggle');
        await ensureVisible(streamCheckbox);
        if (stream) await streamCheckbox.check();
        else await streamCheckbox.uncheck();
    }
    const webSearchCheckbox = page.locator('#openai_enable_web_search');
    await ensureVisible(webSearchCheckbox);
    await webSearchCheckbox.check();
    const showThoughtsCheckbox = page.locator('#openai_show_thoughts');
    await ensureVisible(showThoughtsCheckbox);
    await showThoughtsCheckbox.check();
    if (typeof assistantPrefill === 'string') {
        const prefillArea = page.locator('#claude_assistant_prefill');
        await ensureVisible(prefillArea);
        await prefillArea.fill(assistantPrefill);
    }
    if (typeof postHistoryInstruction === 'string') {
        const jbArea = page.locator('#jailbreak_prompt_quick_edit_textarea');
        await ensureVisible(jbArea);
        await jbArea.fill(postHistoryInstruction);
    }
    await closeAnyOpenTopSettingsDrawer(page);
}

test.describe('Claude pause_turn server-tool continuation and source citations UI', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(() => {
        upstream.clearHandlers();
    });

    test('non-streaming pause_turn preserves assistant content blocks, renders safe citations, and survives reload', async ({ page }) => {
        const reqStart = upstream.requests.length;

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 });

        await configureClaudePromptControlsViaUi(page, {
            stream: false,
            assistantPrefill: 'Prefill should be suppressed on pause_turn',
        });

        const pausedContentBlocks = [
            {
                type: 'thinking',
                thinking: 'Checking the coastal lighthouse registry.',
                signature: 'sig_nonstream_pause_01',
            },
            {
                type: 'server_tool_use',
                id: 'srvtoolu_01NS',
                name: 'web_search',
                input: { query: 'Bryn headland lighthouse lantern' },
            },
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_01NS',
                content: [{
                    type: 'web_search_result',
                    url: 'https://harbor.example.org/bryn-lighthouse',
                    title: 'Bryn Lighthouse Almanac',
                    encrypted_content: 'enc_payload_01',
                }],
            },
        ];

        // Round 1: pause_turn with empty prose + server_tool_use + web_search_tool_result.
        upstream.enqueue(() => ({
            status: 200,
            payload: {
                id: 'msg_ns_round1',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-7',
                content: pausedContentBlocks,
                stop_reason: 'pause_turn',
                usage: {
                    input_tokens: 120,
                    output_tokens: 45,
                    server_tool_use: { web_search_requests: 1 },
                },
            },
        }));

        // Round 2: end_turn with final prose + one valid https citation + one javascript: citation.
        upstream.enqueue(() => ({
            status: 200,
            payload: {
                id: 'msg_ns_round2',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-7',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'Summarizing the verified beacon record.',
                        signature: 'sig_nonstream_final_02',
                    },
                    {
                        type: 'text',
                        text: 'The Bryn headland lantern burns with a twin-wick brass lamp.',
                        citations: [
                            {
                                type: 'web_search_result_location',
                                url: 'https://harbor.example.org/bryn-lighthouse',
                                title: 'Bryn Lighthouse Almanac',
                                cited_text: 'Twin-wick brass lamp installed in 1894.',
                            },
                            {
                                type: 'web_search_result_location',
                                url: 'javascript:alert(1)',
                                title: 'Unsafe Script Source',
                                cited_text: 'Attempted script link.',
                            },
                        ],
                    },
                ],
                stop_reason: 'end_turn',
                usage: { input_tokens: 180, output_tokens: 32 },
            },
        }));

        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, 'What kind of lamp burns at the Bryn headland lighthouse?');

        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            const last = ctx.chat[ctx.chat.length - 1];
            return ctx.chat.length === targetLen + 2
                && !last?.is_user
                && typeof last?.mes === 'string'
                && last.mes.includes('twin-wick brass lamp')
                && last?.extra?.finish_reason === 'stop';
        }, chatLenBefore, { timeout: 60_000 });

        // Verify upstream received 2 requests and Round 2 preserved the exact assistant
        // content blocks without role flipping or prefill injection.
        const runRequests = upstream.requests.slice(reqStart);
        expect(runRequests).toHaveLength(2);
        const round2Messages = runRequests[1].body.messages || [];
        const trailingMsg = round2Messages[round2Messages.length - 1];
        expect(trailingMsg.role).toBe('assistant');
        expect(trailingMsg.content).toEqual(pausedContentBlocks);

        // Verify single assistant bubble, clean prose (no leading stray space),
        // and safe citation rendering.
        const domCheck = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const lastMsg = ctx.chat[ctx.chat.length - 1];
            const mesEl = document.querySelector(`#chat .mes[mesid="${ctx.chat.length - 1}"]`);
            const details = mesEl?.querySelector('.mes_citations_wrapper details.mes_citations');
            const links = Array.from(details?.querySelectorAll('a.mes_citation_link') || []).map(a => ({
                href: a.getAttribute('href'),
                target: a.getAttribute('target'),
                rel: a.getAttribute('rel'),
                text: a.textContent,
            }));
            const plainLabels = Array.from(details?.querySelectorAll('span.mes_citation_label') || []).map(s => s.textContent);
            const allAnchors = Array.from(mesEl?.querySelectorAll('.mes_citations_wrapper a') || []).map(a => a.getAttribute('href'));
            return {
                mes: lastMsg.mes,
                hasDetails: Boolean(details),
                summaryText: details?.querySelector('.mes_citations_summary')?.textContent || '',
                links,
                plainLabels,
                allAnchors,
            };
        });

        expect(domCheck.mes).toBe('The Bryn headland lantern burns with a twin-wick brass lamp.');
        expect(domCheck.hasDetails).toBe(true);
        expect(domCheck.summaryText).toContain('(2)');
        expect(domCheck.links).toEqual([{
            href: 'https://harbor.example.org/bryn-lighthouse',
            target: '_blank',
            rel: 'noopener noreferrer',
            text: 'Bryn Lighthouse Almanac',
        }]);
        expect(domCheck.plainLabels).toEqual(['Unsafe Script Source']);
        expect(domCheck.allAnchors.some(href => String(href || '').toLowerCase().startsWith('javascript:'))).toBe(false);

        // Reload the page, reopen the character chat from disk, and confirm persisted
        // citations render cleanly from saved chat history.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');
        await expect(page.locator('#chat .mes .mes_citations_wrapper details.mes_citations').last()).toBeVisible({ timeout: 20_000 });
        const afterReload = await page.evaluate(() => {
            const details = document.querySelector('#chat .mes:last-child .mes_citations_wrapper details.mes_citations');
            return {
                linkHref: details?.querySelector('a.mes_citation_link')?.getAttribute('href') || '',
                plainLabel: details?.querySelector('span.mes_citation_label')?.textContent || '',
                mesText: document.querySelector('#chat .mes:last-child .mes_text')?.textContent || '',
            };
        });
        expect(afterReload.mesText).toContain('twin-wick brass lamp');
        expect(afterReload.linkHref).toBe('https://harbor.example.org/bryn-lighthouse');
        expect(afterReload.plainLabel).toBe('Unsafe Script Source');
    });

    test('streaming pause_turn preserves assistant blocks across continuation and renders citations_delta', async ({ page }) => {
        const reqStart = upstream.requests.length;

        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Seraphina');

        await page.waitForFunction(() => {
            const ctx = window.Luker.getContext();
            return Array.isArray(ctx.chat) && ctx.chat.length >= 1;
        }, { timeout: 10_000 });

        await configureClaudePromptControlsViaUi(page, {
            stream: true,
            assistantPrefill: 'Suppressed streaming prefill',
            postHistoryInstruction: 'Keep replies grounded in verified coastal charts.',
        });

        // Round 1 (streaming): thinking + server_tool_use + web_search_tool_result -> stop_reason: pause_turn
        upstream.enqueue(() => ({
            status: 200,
            sseEvents: [
                {
                    event: 'message_start',
                    data: {
                        type: 'message_start',
                        message: {
                            id: 'msg_st_round1',
                            type: 'message',
                            role: 'assistant',
                            model: 'claude-opus-4-7',
                            content: [],
                            stop_reason: null,
                            usage: { input_tokens: 100, output_tokens: 0 },
                        },
                    },
                },
                { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Searching harbor tides.' } } },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_stream_pause_01' } } },
                { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
                {
                    event: 'content_block_start',
                    data: {
                        type: 'content_block_start',
                        index: 1,
                        content_block: { type: 'server_tool_use', id: 'srvtoolu_01ST', name: 'web_search', input: {} },
                    },
                },
                {
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index: 1,
                        delta: { type: 'input_json_delta', partial_json: '{"query":"Bryn reef 19-day cycle"}' },
                    },
                },
                { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
                {
                    event: 'content_block_start',
                    data: {
                        type: 'content_block_start',
                        index: 2,
                        content_block: {
                            type: 'web_search_tool_result',
                            tool_use_id: 'srvtoolu_01ST',
                            content: [{
                                type: 'web_search_result',
                                url: 'https://charts.example.org/bryn-reef',
                                title: 'Bryn Reef Hydrography',
                                encrypted_content: 'enc_reef_02',
                            }],
                        },
                    },
                },
                { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
                {
                    event: 'message_delta',
                    data: {
                        type: 'message_delta',
                        delta: { stop_reason: 'pause_turn', stop_sequence: null },
                        usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } },
                    },
                },
                { event: 'message_stop', data: { type: 'message_stop' } },
            ],
        }));

        // Round 2 (streaming): thinking + text + citations_delta -> stop_reason: end_turn
        upstream.enqueue(() => ({
            status: 200,
            sseEvents: [
                {
                    event: 'message_start',
                    data: {
                        type: 'message_start',
                        message: {
                            id: 'msg_st_round2',
                            type: 'message',
                            role: 'assistant',
                            model: 'claude-opus-4-7',
                            content: [],
                            stop_reason: null,
                            usage: { input_tokens: 160, output_tokens: 0 },
                        },
                    },
                },
                { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Drafting the concise answer.' } } },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_stream_final_02' } } },
                { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
                { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'The Bryn reef shifts ' } } },
                {
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index: 1,
                        delta: {
                            type: 'citations_delta',
                            citation: {
                                type: 'web_search_result_location',
                                url: 'https://charts.example.org/bryn-reef',
                                title: 'Bryn Reef Hydrography',
                                cited_text: 'Bryn shoals migrate on a nineteen-day lunar cycle.',
                            },
                        },
                    },
                },
                { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'on a nineteen-day cycle.' } } },
                { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
                {
                    event: 'message_delta',
                    data: {
                        type: 'message_delta',
                        delta: { stop_reason: 'end_turn', stop_sequence: null },
                        usage: { output_tokens: 28 },
                    },
                },
                { event: 'message_stop', data: { type: 'message_stop' } },
            ],
        }));

        const chatLenBefore = await page.evaluate(() => window.Luker.getContext().chat.length);
        await sendMessageAndAwaitReply(page, 'How often does the Bryn reef shift?');

        await page.waitForFunction((targetLen) => {
            const ctx = window.Luker.getContext();
            const last = ctx.chat[ctx.chat.length - 1];
            return ctx.chat.length === targetLen + 2
                && !last?.is_user
                && typeof last?.mes === 'string'
                && last.mes.includes('nineteen-day cycle')
                && last?.extra?.finish_reason === 'stop';
        }, chatLenBefore, { timeout: 60_000 });

        const runRequests = upstream.requests.slice(reqStart);
        expect(runRequests).toHaveLength(2);
        expect(runRequests[0].body.stream).toBe(true);
        expect(runRequests[1].body.stream).toBe(true);
        const round2Messages = runRequests[1].body.messages || [];
        const trailingMsg = round2Messages[round2Messages.length - 1];
        expect(trailingMsg.role).toBe('assistant');
        expect(Array.isArray(trailingMsg.content)).toBe(true);
        expect(trailingMsg.content.map(b => b.type)).toEqual(['thinking', 'server_tool_use', 'web_search_tool_result']);
        expect(trailingMsg.content[0].signature).toBe('sig_stream_pause_01');
        expect(trailingMsg.content[1].input).toEqual({ query: 'Bryn reef 19-day cycle' });

        const domCheck = await page.evaluate(() => {
            const ctx = window.Luker.getContext();
            const lastMsg = ctx.chat[ctx.chat.length - 1];
            const mesEl = document.querySelector(`#chat .mes[mesid="${ctx.chat.length - 1}"]`);
            const link = mesEl?.querySelector('.mes_citations_wrapper a.mes_citation_link');
            return {
                mes: lastMsg.mes,
                linkHref: link?.getAttribute('href') || '',
                linkText: link?.textContent || '',
                excerpt: mesEl?.querySelector('.mes_citations_wrapper .mes_citation_excerpt')?.textContent || '',
            };
        });
        expect(domCheck.mes).toBe('The Bryn reef shifts on a nineteen-day cycle.');
        expect(domCheck.linkHref).toBe('https://charts.example.org/bryn-reef');
        expect(domCheck.linkText).toBe('Bryn Reef Hydrography');
        expect(domCheck.excerpt).toContain('nineteen-day lunar cycle');
    });
});
