// tests/e2e/memorygraph/_runner-helpers.js
//
// Shared pieces of the memory-graph runner specs (#69 onward): tool names,
// mock-request filters, seed-graph files and read-only store access. The
// settings-panel gestures live in ../_lib/ui-mg-varops.js (setMgSettings,
// configureMg, importMgGraph, fillMgGraph); the helpers here build on them. Every state
// change goes through Memory Lens Settings; page.evaluate is used only to
// read the in-browser memory store.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fillMgGraph } from '../_lib/ui-mg-varops.js';

export const ROUTE_TOOL = 'luker_rpg_recall_plan';
export const FINALIZE_TOOL = 'luker_rpg_recall_finalize';
export const CRAWL_INSPECT_TOOL = 'luker_rpg_extract_crawl_inspect';
export const EXTRACT_EVENT_TOOL = 'luker_rpg_extract_event_create';

export const FILL_DONE_STATUS = /^(Memory graph incremental fill completed\.|记忆图增量补全完成。|記憶圖譜增量補全完成。)$/;
export const RECALL_CANCELLED_STATUS = /Memory recall cancelled by user\.|记忆召回已由用户终止。|記憶召回已由使用者終止。/;

// character_sheet / location_state are not always-inject types in the
// default schema, so all four seeds become recall route candidates.
export const RECALL_SEED_RECORDS = [
    {
        type: 'character_sheet',
        title: 'Maelis Brine-Ward',
        fields: {
            title: 'Maelis Brine-Ward',
            identity: 'Harbor pilot who steers skiffs across the kelp shelf at slack water.',
            traits: 'Unhurried, exact with soundings, distrusts painted buoys.',
        },
    },
    {
        type: 'character_sheet',
        title: 'Corran Saltreach',
        fields: {
            title: 'Corran Saltreach',
            identity: 'Customs clerk who keeps the cargo manifests behind the shutters.',
            traits: 'Fussy about ink, generous with tea.',
        },
    },
    {
        type: 'location_state',
        title: 'Bryn headland watchpost',
        fields: {
            title: 'Bryn headland watchpost',
            state: 'Lantern trimmed; night watch active.',
        },
    },
    {
        type: 'location_state',
        title: 'Kelp shelf channel',
        fields: {
            title: 'Kelp shelf channel',
            state: 'Marker buoys drifted a full cable east after the storm.',
        },
    },
];

export function toolNamesOf(body) {
    return (Array.isArray(body?.tools) ? body.tools : [])
        .map(tool => String(tool?.function?.name || ''))
        .filter(Boolean);
}

export function chatCompletionRecords(mock, fromIndex = 0) {
    return mock.requests
        .slice(fromIndex)
        .filter(record => String(record.url || '').endsWith('/chat/completions'));
}

export function recordsWithTool(mock, toolName, fromIndex = 0) {
    return chatCompletionRecords(mock, fromIndex).filter(record => toolNamesOf(record.body).includes(toolName));
}

export function userPromptOf(body) {
    return (Array.isArray(body?.messages) ? body.messages : [])
        .filter(message => message?.role === 'user')
        .map(message => String(message.content ?? ''))
        .join('\n');
}

// Fixture data preparation before the page loads: MG starts disabled so
// turns sent before the test enables it through the UI never trigger
// extraction.
export function disableMemoryGraphInSettingsFile(dataRoot) {
    const settingsPath = resolve(dataRoot, 'default-user', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.extension_settings = settings.extension_settings || {};
    settings.extension_settings.memory_graph = {
        ...(settings.extension_settings.memory_graph || {}),
        enabled: false,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

/**
 * Write a graph-store JSON accepted by the Graph tab Import button. Node
 * ids are `n_1`..`n_N` in record order, each bound to seq = its index + 1.
 *
 * @returns {string} absolute path of the written file
 */
export async function writeSeedGraphFile(scope, records, prefix) {
    const { path: dir } = await scope.directory(prefix);
    const filePath = resolve(dir, 'seed.json');
    const nodes = {};
    records.forEach((record, index) => {
        const seq = index + 1;
        nodes[`n_${seq}`] = {
            id: `n_${seq}`,
            type: record.type,
            level: 'semantic',
            title: record.title,
            parentId: '',
            childrenIds: [],
            fields: record.fields,
            seqTo: seq,
        };
    });
    writeFileSync(filePath, JSON.stringify({
        version: 2,
        nodeSeq: records.length,
        seqCounter: records.length,
        appliedSeqTo: records.length,
        loggedSeqTo: records.length,
        nodes,
        edges: [],
    }, null, 2));
    return filePath;
}

export async function clickFillGraph(page, { closeAfter = false } = {}) {
    await fillMgGraph(page, { closeAfter });
}

export async function readMemoryGraphState(page) {
    return await page.evaluate(async () => {
        const ctx = window.Luker.getContext();
        const main = await import('/scripts/extensions/memory-graph/main.js');
        const store = await main.ensureMemoryStoreLoaded(ctx);
        const nodes = Object.values(store?.nodes || {}).map(node => ({
            id: String(node?.id || ''),
            type: String(node?.type || ''),
            title: String(node?.title || ''),
            archived: Boolean(node?.archived),
            fields: node?.fields && typeof node.fields === 'object' ? structuredClone(node.fields) : {},
        }));
        return {
            nodes,
            lastRecallTrace: Array.isArray(store?.lastRecallTrace) ? structuredClone(store.lastRecallTrace) : [],
        };
    });
}

export function memoryGraphStatus(page) {
    return page.locator('.wbench .mlens .ml-settings-status').first();
}
