// tests/e2e/memorygraph/72-extract-concurrent.e2e.js
//
// #72 — Concurrent extraction runs one round as a node stage and an edge stage.
//
// With the concurrent setting on, a round sends one request per active node
// type, all in flight at once, each carrying only that type's rules and only
// that type's create tool. After every node request settles, one edge request
// carries the round's node list so it can link the nodes the node stage just
// created. Both stages read the round's opening snapshot, and the round
// commits only when both succeed — a failure anywhere discards the round.
//
// The mock routes on `route.toolNames`: a request carrying the link tool
// answers with one link between the two node ids it reads out of
// <round_nodes>, and a request carrying a type create tool answers with one
// create for that type. The peak concurrent chat requests the mock served
// proves the node requests overlapped. Unit tests stay out of the prompt body,
// so the request shape is pinned here, through the real Fill Graph button.

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { startMockLLM } from '../_lib/mockLLM.js';
import { bootstrapCustomBackend, appendConnectionProfile, markOnboarded } from '../_lib/fixtures.js';
import { disableTagImportPopup, writeEmbeddedCharacter } from '../character/_helpers.js';
import {
    awaitMainUI,
    selectCharacterByName,
} from '../_lib/page.js';
import { fillMgGraph, setMgSettings } from '../_lib/ui-mg-varops.js';
import { DEFAULT_EXTRACT_TEMPLATE } from '../../../public/scripts/extensions/memory-graph/default-prompts.js';
import {
    EDGES_BLOCK_HEADING,
    NODES_BLOCK_HEADING,
} from '../../../public/scripts/extensions/memory-graph/extraction-schedule.js';

const DONE_TOOL = 'luker_rpg_extract_done';
const LINK_TOOL = 'luker_rpg_extract_link_upsert';
const CREATE_TOOL_RE = /^luker_rpg_extract_[a-z0-9_]+_create$/;
const DEFAULT_TYPES = ['event', 'character_sheet', 'location_state', 'thread'];
const EVENT_SUMMARY = '时间：测试；并发节点阶段。';
const RETRY_TOAST_RE = /retrying|正在重试|正在重試/;

// One create per default active type. The event type's node-stage create tool
// carries no links property, so no links are supplied for it.
const CREATE_ARGS = {
    event: { summary: EVENT_SUMMARY },
    character_sheet: { title: 'Ash', identity: '布林海角的常驻制图员。' },
    location_state: { title: 'Bryn headland watchpost', state: '夜间执勤。' },
    thread: { title: '取回航海图', status: 'active', note: '布林海角的航海图尚未取回。' },
};

// The terminal done call is unique to the one-shot extraction request, so it
// identifies an extraction round without depending on the tool under test.
function extractionRequests(mock) {
    return mock.requests.filter((r) => {
        const tools = Array.isArray(r.body?.tools) ? r.body.tools : [];
        return tools.some((t) => t?.function?.name === DONE_TOOL);
    });
}

function toolNamesOf(request) {
    const tools = Array.isArray(request?.body?.tools) ? request.body.tools : [];
    return tools.map((t) => String(t?.function?.name || ''));
}

// A node-stage request carries type create tools and no link tool; an edge-stage
// request carries the link tool and no type create tool. The split is what the
// concurrent round introduces — a one-shot request carries both, so it lands in
// neither set.
function nodeStageRequests(mock) {
    return extractionRequests(mock).filter((r) => {
        const names = toolNamesOf(r);
        return names.some((name) => CREATE_TOOL_RE.test(name)) && !names.includes(LINK_TOOL);
    });
}

function edgeStageRequests(mock) {
    return extractionRequests(mock).filter((r) => {
        const names = toolNamesOf(r);
        return names.includes(LINK_TOOL) && !names.some((name) => CREATE_TOOL_RE.test(name));
    });
}

function messageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
    }
    return '';
}

function systemMessagesOf(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    return messages
        .filter((message) => message?.role === 'system')
        .map((message) => messageText(message.content));
}

function userTextOf(request) {
    const messages = Array.isArray(request?.body?.messages) ? request.body.messages : [];
    return messages
        .filter((message) => message?.role === 'user')
        .map((message) => messageText(message.content))
        .join('\n');
}

// The opening line of the shipped template: its first non-empty line, skipping
// the marker lines the program replaces before the request leaves. Reading it
// off the constant keeps the system-message lookup pinned to the shipped text.
function openingLine(text) {
    return String(text)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.includes('{{')) || '';
}

function extractionSystemMessage(request) {
    const templateLine = openingLine(DEFAULT_EXTRACT_TEMPLATE);
    return systemMessagesOf(request).find((text) => text.includes(templateLine)) || '';
}

function roundNodesFromUserText(text) {
    const match = /<round_nodes>\s*([\s\S]*?)\s*<\/round_nodes>/.exec(String(text || ''));
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
}

// Route every extraction request by the tools it carries. The edge request
// reads the two new node ids out of <round_nodes> and links them by id, which
// pins both "links between nodes this round created" and "endpoints are ids,
// not refs". `failEdge` answers the edge request with null forever, so the mock
// queue serves it and the edge stage can never satisfy the tool contract.
function installConcurrentRouter(mock, { failEdge = false } = {}) {
    mock.scriptCompletion((req) => {
        const names = req.toolNames || [];
        if (names.includes(LINK_TOOL)) {
            if (failEdge) return null;
            const round = roundNodesFromUserText((req.userMessages || []).join('\n'));
            const ids = (Array.isArray(round?.created) ? round.created : [])
                .map((row) => String(row?.id || ''))
                .filter(Boolean);
            const [sourceId, targetId] = ids;
            if (!sourceId || !targetId) {
                return { toolCalls: [{ name: DONE_TOOL, arguments: {} }] };
            }
            return { toolCalls: [
                { name: LINK_TOOL, arguments: { source_node_id: sourceId, links: [{ target_node_id: targetId, relation: 'related' }] } },
                { name: DONE_TOOL, arguments: {} },
            ] };
        }
        const createName = names.find((name) => CREATE_TOOL_RE.test(name));
        if (!createName) return null;
        const typeId = createName.slice('luker_rpg_extract_'.length, -'_create'.length);
        const args = CREATE_ARGS[typeId];
        if (!args) return null;
        return { toolCalls: [
            { name: createName, arguments: args },
            { name: DONE_TOOL, arguments: {} },
        ] };
    });
}

async function enableConcurrentAndFill(page) {
    await setMgSettings(page, {
        enabled: true,
        autoExtractionEnabled: true,
        autoCompressionEnabled: false,
        extractConcurrent: true,
    });
    await fillMgGraph(page, { closeAfter: true });
}

// Record every distinct toast text the DOM ever renders. The in-round progress
// updates the live extraction toast, so observing the rendered text keeps the
// assertion on the real user-visible surface.
async function installToastObserver(page) {
    await page.evaluate(() => {
        window.__stageToastTexts = [];
        const scan = () => {
            for (const el of document.querySelectorAll('.toast-message')) {
                const text = el.textContent || '';
                if (text && !window.__stageToastTexts.includes(text)) {
                    window.__stageToastTexts.push(text);
                }
            }
        };
        scan();
        new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
}

async function readGraphNodes(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const session = await mg?.openSession?.(ctx);
        if (!session) return [];
        return session.listVisibleCandidates({}).map((n) => ({
            id: String(n?.id || ''),
            type: String(n?.type || ''),
            title: String(n?.title || ''),
            summary: String(n?.fields?.summary || ''),
        }));
    });
}

// Read the round's two new nodes back through the session read surface and ask
// for the edge between them, with the two ids pinned as the visible set.
async function readRoundEdge(page) {
    return page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const mg = ctx.getExtensionApi?.('memory-graph');
        const session = await mg?.openSession?.(ctx);
        if (!session) return { error: 'no session' };
        const nodes = session.listVisibleCandidates({});
        const eventNode = nodes.find((n) => n.type === 'event');
        const characterNode = nodes.find((n) => n.type === 'character_sheet');
        if (!eventNode || !characterNode) {
            return { error: 'missing nodes', types: nodes.map((n) => n.type) };
        }
        const summary = session.getEdgeSummary(eventNode.id, { visibleNodeIds: [eventNode.id, characterNode.id] });
        return {
            eventId: String(eventNode.id),
            characterId: String(characterNode.id),
            relations: summary.relations.map((r) => r.relation),
            neighborIds: summary.sample_neighbors.map((n) => n.id),
        };
    });
}

async function waitForExtractionQuiescence(mock, { stableMs = 2500, timeoutMs = 120_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
        const count = extractionRequests(mock).length;
        if (count !== lastCount) {
            lastCount = count;
            lastChangeAt = Date.now();
        }
        if (count > 0 && Date.now() - lastChangeAt >= stableMs) {
            return count;
        }
        await new Promise((resolve) => { setTimeout(resolve, 250); });
    }
    throw new Error(`extraction did not quiesce within ${timeoutMs}ms (last request count = ${lastCount})`);
}

test.describe('#72 — a concurrent round runs a node stage and an edge stage', () => {
    let server, mock;

    test.beforeAll(async () => {
        // A little latency keeps the in-flight node requests overlapping and
        // makes the intermediate toast states observable.
        mock = await startMockLLM({ latencyMs: 250, scriptedReplies: [] });
        server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-concurrent' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        installConcurrentRouter(mock);
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(180_000);

    test('each active type gets its own request and the edge request links the new nodes', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        await installToastObserver(page);
        await enableConcurrentAndFill(page);

        await expect.poll(() => extractionRequests(mock).length, {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);
        await waitForExtractionQuiescence(mock);

        const nodes = nodeStageRequests(mock);
        const edges = edgeStageRequests(mock);

        // Exactly one edge request, and each default active type in exactly one
        // node request.
        expect(edges, 'exactly one edge request per round').toHaveLength(1);
        for (const typeId of DEFAULT_TYPES) {
            const tool = `luker_rpg_extract_${typeId}_create`;
            expect(
                nodes.filter((r) => toolNamesOf(r).includes(tool)),
                `type ${typeId} must be requested exactly once`,
            ).toHaveLength(1);
        }

        // Node requests: no link tool, node rules only, no round node list.
        for (const request of nodes) {
            expect(toolNamesOf(request)).not.toContain(LINK_TOOL);
            const system = extractionSystemMessage(request);
            expect(system, 'a node request must carry the node rules').toContain(NODES_BLOCK_HEADING);
            expect(system, 'a node request must not carry the edge rules').not.toContain(EDGES_BLOCK_HEADING);
            expect(userTextOf(request)).not.toContain('<round_nodes>');
        }

        // The edge request: link tool only, edge rules only, carries the round
        // node list.
        const edgeRequest = edges[0];
        const edgeSystem = extractionSystemMessage(edgeRequest);
        expect(edgeSystem, 'the edge request must carry the edge rules').toContain(EDGES_BLOCK_HEADING);
        expect(edgeSystem, 'the edge request must not carry the node rules').not.toContain(NODES_BLOCK_HEADING);
        expect(userTextOf(edgeRequest)).toContain('<round_nodes>');
        expect(
            toolNamesOf(edgeRequest).some((name) => CREATE_TOOL_RE.test(name)),
            'the edge request must not carry a type create tool',
        ).toBe(false);

        // The node requests were in flight together.
        expect(
            mock.getMaxConcurrentChatRequests(),
            'the node requests must overlap in flight',
        ).toBeGreaterThan(1);

        // The round committed: the mocked event summary is visible in the graph.
        await expect.poll(async () => (await readGraphNodes(page)).some((n) => n.summary === EVENT_SUMMARY), {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBe(true);

        // The edge landed between the two nodes the node stage created.
        const edge = await readRoundEdge(page);
        expect(edge.error, 'the round nodes must be readable').toBeUndefined();
        expect(edge.relations, 'the edge relation must be related').toContain('related');
        expect(edge.neighborIds, 'the edge must reach the other round node').toContain(edge.characterId);

        // In-round progress reached the toast: a node-stage text with
        // done/total, and an edge-stage text.
        const toastTexts = await page.evaluate(() => window.__stageToastTexts.slice());
        expect(
            toastTexts.some((text) => /(Node stage|节点阶段|節點階段)\s+\d+\/\d+/.test(text)),
            'a node-stage toast with done/total must appear',
        ).toBe(true);
        expect(
            toastTexts.some((text) => /(Edge stage|边阶段|邊階段)/.test(text)),
            'an edge-stage toast must appear',
        ).toBe(true);
    });
});

test.describe('#72 — a failed edge stage discards the round', () => {
    let server, mock;

    test.beforeAll(async () => {
        mock = await startMockLLM({ scriptedReplies: [] });
        server = await startServer({ batchKey: 'memorygraph', scenarioId: 'extract-concurrent-edge-fail' });
        markOnboarded({ dataRoot: server.dataRoot });
        bootstrapCustomBackend({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        appendConnectionProfile({ dataRoot: server.dataRoot, baseURL: mock.baseURL });
        disableTagImportPopup({ dataRoot: server.dataRoot });
        writeEmbeddedCharacter({ dataRoot: server.dataRoot });
        installConcurrentRouter(mock, { failEdge: true });
    });

    test.afterAll(async () => {
        await tearDownServer(server);
        await mock?.stop();
    });

    test.setTimeout(240_000);

    test('the nodes the node stage created never reach the graph', async ({ page }) => {
        await awaitMainUI(page, server.baseURL);
        await selectCharacterByName(page, 'Ash the Cartographer');
        await page.waitForFunction(() => document.querySelectorAll('#chat .mes').length >= 1, null, { timeout: 30_000 });

        await installToastObserver(page);
        await enableConcurrentAndFill(page);

        // The edge request fired, and its failure surfaced as a retry toast.
        await expect.poll(() => edgeStageRequests(mock).length, {
            timeout: 120_000,
            intervals: [200, 300, 500, 1000],
        }).toBeGreaterThanOrEqual(1);
        await expect.poll(
            () => page.evaluate((source) => {
                const pattern = new RegExp(source);
                return window.__stageToastTexts.some((text) => pattern.test(text));
            }, RETRY_TOAST_RE.source),
            { timeout: 120_000, intervals: [200, 300, 500, 1000] },
        ).toBe(true);

        await waitForExtractionQuiescence(mock);

        // The round was retried to exhaustion, then discarded: no node the node
        // stage created survived into the graph.
        const graph = await readGraphNodes(page);
        expect(
            graph.some((n) => n.summary === EVENT_SUMMARY),
            'the failed round must not leave the event node in the graph',
        ).toBe(false);
        expect(
            graph.some((n) => n.type === 'character_sheet' && n.title === 'Ash'),
            'the failed round must not leave the character node in the graph',
        ).toBe(false);
    });
});
