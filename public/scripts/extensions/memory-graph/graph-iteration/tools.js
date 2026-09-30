// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Graph-iteration tool catalog + executors.
 *
 * Fixed tool schemas (no per-type/per-id enums) keep the tool payload byte-
 * stable across turns for prompt caching. Reads run against the staged view
 * (the working clone reflects live + uncommitted proposals); writes mutate
 * the working clone through the shared write-api, so every executor inherits
 * the native extraction semantics (latestOnly upsert/merge/archive, event
 * never merges, edge dedupe, symmetric canonicalization) instead of
 * inventing a parallel editor model.
 *
 * Error contract (shared with the four sibling studios):
 *   throw new GraphToolError(tool, code, detail, hint?) with code in
 *   { not_found, invalid_args, multiple_matches, not_allowed, unknown_tool }.
 * Explicit noops return { ok: true, changed: false, note }.
 */

import { readFieldsByPaths } from '../../../iteration-library/read-fields-helper.js';
import { canonicalFromStore } from './canonical.js';

const NODE_ID_HINT = 'use mg_graph_search_nodes or mg_graph_list_nodes to find the right node id';

export const GRAPH_READ_TOOL_NAMES = new Set([
    'mg_graph_read_fields',
    'mg_graph_list_nodes',
    'mg_graph_search_nodes',
    'mg_graph_node_detail',
    'mg_graph_neighbors',
    'mg_graph_schema',
    'mg_graph_read_chat',
]);

export const GRAPH_WRITE_TOOL_NAMES = new Set([
    'mg_graph_create_node',
    'mg_graph_edit_node',
    'mg_graph_delete_node',
    'mg_graph_merge_nodes',
    'mg_graph_upsert_links',
    'mg_graph_edit_link',
    'mg_graph_delete_link',
]);

export function isGraphReadTool(name) {
    return GRAPH_READ_TOOL_NAMES.has(String(name || ''));
}

export function isGraphWriteTool(name) {
    return GRAPH_WRITE_TOOL_NAMES.has(String(name || ''));
}

export class GraphToolError extends Error {
    constructor(tool, code, detail, hint = '') {
        super(`${tool}: ${code} — ${detail}`);
        this.name = 'GraphToolError';
        this.code = code;
        this.detail = String(detail || '');
        this.hint = String(hint || '');
        this.envelope = {
            ok: false,
            error: code,
            detail: this.detail,
            ...(this.hint ? { hint: this.hint } : {}),
        };
    }
}

export const GRAPH_TOOL_DEFS = [
    {
        type: 'function',
        function: {
            name: 'mg_graph_read_fields',
            description: 'Read arbitrary paths from the staged graph document. Node docs live under nodes.<id> (fields under nodes.<id>.fields.<column>); links under links.<from>␟<type>␟<to>. Returns { [path]: value, missing_paths }.',
            parameters: {
                type: 'object',
                properties: { paths: { type: 'array', items: { type: 'string' }, description: 'lodash-style paths, e.g. "nodes.n_3.fields.status"' } },
                required: ['paths'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_list_nodes',
            description: 'Enumerate compact node rows (id, type, title, seqTo, archived, summary), optionally filtered by type. Archived nodes are hidden unless include_archived is true.',
            parameters: {
                type: 'object',
                properties: {
                    types: { type: 'array', items: { type: 'string' } },
                    include_archived: { type: 'boolean' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_search_nodes',
            description: 'Find nodes by text. keyword mode matches title and field text; semantic mode uses the vector index (falls back with not_allowed when no embedding profile is configured).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    mode: { type: 'string', enum: ['keyword', 'semantic'] },
                    types: { type: 'array', items: { type: 'string' } },
                    k: { type: 'number', description: 'semantic hit count (default 20)' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_node_detail',
            description: 'Full node fields plus an edge summary (degree, relations, outgoing/incoming lists).',
            parameters: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_neighbors',
            description: 'Expand the neighborhood around a node across links (and child edges by default).',
            parameters: {
                type: 'object',
                properties: {
                    node_id: { type: 'string' },
                    hops: { type: 'number' },
                    relations: { type: 'array', items: { type: 'string' } },
                    include_children: { type: 'boolean' },
                },
                required: ['node_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_schema',
            description: 'List the active node-type schema (ids, columns, required/primary-key columns, latestOnly, alwaysInject).',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_read_chat',
            description: 'Read the raw chat messages for an assistant-turn range (1-based assistant seqs, matching node seqTo watermarks).',
            parameters: {
                type: 'object',
                properties: { from_assistant_seq: { type: 'number' }, to_assistant_seq: { type: 'number' } },
                required: ['from_assistant_seq', 'to_assistant_seq'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_create_node',
            description: 'Create or update a node with native upsert semantics: latestOnly types merge into an existing match and archive other matches; event nodes always create a new entry with an automatic summary title. Returns { id, action, title, archived_losers? }.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string' },
                    title: { type: 'string' },
                    fields: { type: 'object' },
                    summary: { type: 'string' },
                    links: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                target_node_id: { type: 'string' },
                                relation: { type: 'string' },
                                direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                            },
                            required: ['target_node_id', 'relation'],
                        },
                    },
                },
                required: ['type'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_edit_node',
            description: 'Patch a node in place: title, fields (set/clear), or type. seqTo watermarks are preserved. Archived nodes are refused unless archived:false is passed.',
            parameters: {
                type: 'object',
                properties: {
                    node_id: { type: 'string' },
                    title: { type: 'string' },
                    set_fields: { type: 'object' },
                    clear_fields: { type: 'array', items: { type: 'string' } },
                    type: { type: 'string' },
                    archived: { type: 'boolean' },
                },
                required: ['node_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_delete_node',
            description: 'Delete a node and its incident edges. Nodes with children are refused unless recursive:true (which removes the whole subtree).',
            parameters: {
                type: 'object',
                properties: { node_id: { type: 'string' }, recursive: { type: 'boolean' } },
                required: ['node_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_merge_nodes',
            description: 'Fold duplicates into one survivor: writes merged fields on the survivor and archives each loser with its edges rewritten to the survivor (deduped, self-loops dropped). Losers are archived, never physically deleted.',
            parameters: {
                type: 'object',
                properties: {
                    survivor_id: { type: 'string' },
                    loser_ids: { type: 'array', items: { type: 'string' } },
                    fields: { type: 'object' },
                    summary: { type: 'string' },
                },
                required: ['survivor_id', 'loser_ids'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_upsert_links',
            description: 'Add directed links from a source node. Duplicate triples are deduped; symmetric relations collapse to one canonical edge. Reports the real added edge count.',
            parameters: {
                type: 'object',
                properties: {
                    source_node_id: { type: 'string' },
                    links: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                target_node_id: { type: 'string' },
                                relation: { type: 'string' },
                                direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                            },
                            required: ['target_node_id', 'relation'],
                        },
                    },
                },
                required: ['source_node_id', 'links'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_edit_link',
            description: 'Rewrite an existing link relation in place (old relation removed, new relation added preserving direction).',
            parameters: {
                type: 'object',
                properties: {
                    source_node_id: { type: 'string' },
                    target_node_id: { type: 'string' },
                    relation: { type: 'string' },
                    new_relation: { type: 'string' },
                },
                required: ['source_node_id', 'target_node_id', 'relation', 'new_relation'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mg_graph_delete_link',
            description: 'Delete a link addressed by (source, target, relation). direction defaults to outgoing; pass bidirectional for extraction-style edge pairs.',
            parameters: {
                type: 'object',
                properties: {
                    source_node_id: { type: 'string' },
                    target_node_id: { type: 'string' },
                    relation: { type: 'string' },
                    direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                },
                required: ['source_node_id', 'target_node_id', 'relation'],
            },
        },
    },
];

function requireString(value, field, tool) {
    const text = String(value ?? '').trim();
    if (!text) throw new GraphToolError(tool, 'invalid_args', `${field} is required`);
    return text;
}

function normalizeRelation(value, tool) {
    const relation = String(value ?? 'related').trim().toLowerCase() || 'related';
    if (!/^[a-z0-9_:-]+$/.test(relation)) {
        throw new GraphToolError(tool, 'invalid_args', `relation "${relation}" contains unsupported characters`);
    }
    return relation;
}

function normalizeFields(value, tool) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new GraphToolError(tool, 'invalid_args', 'fields must be an object');
    }
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (raw === undefined) continue;
        out[String(key)] = raw;
    }
    return out;
}

function normalizeDirection(value, tool, fallback = 'outgoing') {
    const direction = String(value ?? fallback).trim().toLowerCase();
    if (!['outgoing', 'incoming', 'bidirectional'].includes(direction)) {
        throw new GraphToolError(tool, 'invalid_args', 'direction must be outgoing/incoming/bidirectional');
    }
    return direction;
}

function nodeRow(node) {
    const summary = String(node?.fields?.summary ?? '');
    return {
        id: String(node.id),
        type: String(node.type || ''),
        title: String(node.title || ''),
        seqTo: Number(node.seqTo ?? 0),
        archived: Boolean(node.archived),
        ...(summary ? { summary } : {}),
    };
}

function normalizeTypeFilter(value) {
    return Array.isArray(value)
        ? value.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : null;
}

function schemaHasType(type, env) {
    return schemaSpecs(env).some((spec) => String(spec?.id || '').toLowerCase() === String(type).toLowerCase());
}

function schemaSpecs(env) {
    const schema = typeof env?.deps?.getEffectiveNodeTypeSchema === 'function'
        ? env.deps.getEffectiveNodeTypeSchema(env.context, env.settings)
        : [];
    return Array.isArray(schema) ? schema : [];
}

function collectArchived(store) {
    const out = new Set();
    for (const [id, node] of Object.entries(store?.nodes || {})) {
        if (node?.archived) out.add(id);
    }
    return out;
}

function hasEdge(store, from, to, type) {
    return (store?.edges || []).some((e) => e && e.from === from && e.to === to && e.type === type);
}

function normalizeLinkSpecs(rawLinks, env, tool) {
    const links = [];
    for (const raw of Array.isArray(rawLinks) ? rawLinks : []) {
        const targetId = String(raw?.target_node_id || '').trim();
        if (!targetId) throw new GraphToolError(tool, 'invalid_args', 'each link requires target_node_id');
        const target = env.working?.nodes?.[targetId];
        if (!target) throw new GraphToolError(tool, 'not_found', `link target ${targetId} does not exist`, NODE_ID_HINT);
        if (target.archived) throw new GraphToolError(tool, 'not_allowed', `link target ${targetId} is archived`);
        links.push({
            targetNodeId: targetId,
            relation: normalizeRelation(raw?.relation, tool),
            direction: normalizeDirection(raw?.direction, tool, 'outgoing'),
        });
    }
    return links;
}

function execReadFields(args, env) {
    if (!Array.isArray(args?.paths)) {
        throw new GraphToolError('mg_graph_read_fields', 'invalid_args', 'paths must be an array');
    }
    const doc = canonicalFromStore(env.working);
    return readFieldsByPaths(doc, args.paths);
}

function execListNodes(args, env) {
    const types = normalizeTypeFilter(args?.types);
    const includeArchived = Boolean(args?.include_archived);
    const rows = [];
    for (const node of Object.values(env.working?.nodes || {})) {
        if (!includeArchived && node.archived) continue;
        if (types && !types.includes(String(node.type || '').toLowerCase())) continue;
        rows.push(nodeRow(node));
    }
    rows.sort((a, b) => (a.seqTo - b.seqTo) || a.id.localeCompare(b.id));
    return { nodes: rows, total: rows.length };
}

async function execSearchNodes(args, env) {
    const tool = 'mg_graph_search_nodes';
    const query = requireString(args?.query, 'query', tool);
    const mode = String(args?.mode || 'keyword').trim().toLowerCase();
    const types = normalizeTypeFilter(args?.types);
    if (mode === 'semantic') {
        if (typeof env.deps?.searchSimilarNodes !== 'function') {
            throw new GraphToolError(tool, 'not_allowed', 'semantic search is unavailable in this context', 'use mode:"keyword"');
        }
        let hits;
        try {
            // 20 mirrors `searchGraphSimilarNodes`' own default when no
            // caller override is given; `k` stays adjustable per call and no
            // downstream cap clamps it.
            hits = await env.deps.searchSimilarNodes(query, { topK: Number(args?.k) || 20 });
        } catch (err) {
            throw new GraphToolError(tool, 'not_allowed', String(err?.message || err), 'no embedding profile configured — use mode:"keyword"');
        }
        const rows = [];
        for (const hit of hits || []) {
            const node = env.working?.nodes?.[hit.nodeId];
            if (!node || node.archived) continue;
            if (types && !types.includes(String(node.type || '').toLowerCase())) continue;
            rows.push({ ...nodeRow(node), score: Number(hit.score) || 0 });
        }
        return { mode: 'semantic', matches: rows };
    }
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    for (const node of Object.values(env.working?.nodes || {})) {
        if (node.archived) continue;
        if (types && !types.includes(String(node.type || '').toLowerCase())) continue;
        const title = String(node.title || '').toLowerCase();
        const fieldText = JSON.stringify(node.fields || {}).toLowerCase();
        let score = 0;
        for (const token of tokens) {
            if (title.includes(token)) score += 2;
            if (fieldText.includes(token)) score += 1;
        }
        if (score > 0) rows.push({ ...nodeRow(node), score });
    }
    rows.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    return { mode: 'keyword', matches: rows };
}

function execNodeDetail(args, env) {
    const tool = 'mg_graph_node_detail';
    const nodeId = requireString(args?.node_id, 'node_id', tool);
    const node = env.working?.nodes?.[nodeId];
    if (!node) throw new GraphToolError(tool, 'not_found', `node ${nodeId} does not exist`, NODE_ID_HINT);
    const outgoing = [];
    const incoming = [];
    const relations = new Set();
    for (const edge of env.working.edges || []) {
        if (!edge) continue;
        if (edge.from === nodeId) { outgoing.push({ to: edge.to, type: edge.type }); relations.add(edge.type); }
        if (edge.to === nodeId) { incoming.push({ from: edge.from, type: edge.type }); relations.add(edge.type); }
    }
    return {
        node: {
            ...nodeRow(node),
            fields: node.fields || {},
            parentId: node.parentId || '',
            childrenIds: [...(node.childrenIds || [])],
        },
        edges: { degree: outgoing.length + incoming.length, relations: [...relations].sort(), outgoing, incoming },
    };
}

function execNeighbors(args, env) {
    const tool = 'mg_graph_neighbors';
    const nodeId = requireString(args?.node_id, 'node_id', tool);
    if (!env.working?.nodes?.[nodeId]) throw new GraphToolError(tool, 'not_found', `node ${nodeId} does not exist`, NODE_ID_HINT);
    const hops = Math.max(1, Math.floor(Number(args?.hops) || 1));
    const relations = normalizeTypeFilter(args?.relations);
    const includeChildren = args?.include_children !== false;
    const visited = new Set([nodeId]);
    const results = [];
    let frontier = [nodeId];
    for (let depth = 1; depth <= hops; depth += 1) {
        const next = [];
        for (const current of frontier) {
            for (const edge of env.working.edges || []) {
                if (!edge || (relations && !relations.includes(String(edge.type).toLowerCase()))) continue;
                const neighbor = edge.from === current ? edge.to : (edge.to === current ? edge.from : null);
                if (!neighbor || visited.has(neighbor) || !env.working.nodes?.[neighbor]) continue;
                const node = env.working.nodes[neighbor];
                visited.add(neighbor);
                next.push(neighbor);
                results.push({ id: neighbor, type: node.type, title: node.title, archived: Boolean(node.archived), via: { from: current, relation: edge.type }, depth });
            }
            if (includeChildren) {
                const currentNode = env.working.nodes[current];
                for (const childId of currentNode?.childrenIds || []) {
                    if (visited.has(childId) || !env.working.nodes?.[childId]) continue;
                    const child = env.working.nodes[childId];
                    visited.add(childId);
                    next.push(childId);
                    results.push({ id: childId, type: child.type, title: child.title, archived: Boolean(child.archived), via: { from: current, relation: 'contains' }, depth });
                }
            }
        }
        frontier = next;
        if (frontier.length === 0) break;
    }
    return { neighbors: results };
}

function execSchema(_args, env) {
    return {
        types: schemaSpecs(env).map((spec) => ({
            id: String(spec?.id || ''),
            label: String(spec?.label || ''),
            tableName: String(spec?.tableName || ''),
            tableColumns: Array.isArray(spec?.tableColumns) ? [...spec.tableColumns] : [],
            requiredColumns: Array.isArray(spec?.requiredColumns) ? [...spec.requiredColumns] : [],
            primaryKeyColumns: Array.isArray(spec?.primaryKeyColumns) ? [...spec.primaryKeyColumns] : [],
            latestOnly: Boolean(spec?.latestOnly),
            alwaysInject: Boolean(spec?.alwaysInject),
        })),
    };
}

async function execReadChat(args, env) {
    const tool = 'mg_graph_read_chat';
    if (typeof env.deps?.readChatRange !== 'function') {
        throw new GraphToolError(tool, 'not_allowed', 'chat reading is unavailable in this context');
    }
    const from = Math.max(1, Math.floor(Number(args?.from_assistant_seq) || 1));
    const to = Math.max(from, Math.floor(Number(args?.to_assistant_seq) || from));
    const messages = await env.deps.readChatRange(from, to);
    return { from_assistant_seq: from, to_assistant_seq: to, messages: Array.isArray(messages) ? messages : [] };
}

async function execCreateNode(args, env) {
    const tool = 'mg_graph_create_node';
    const type = requireString(args?.type, 'type', tool).toLowerCase();
    if (!schemaHasType(type, env)) {
        throw new GraphToolError(tool, 'invalid_args', `type "${type}" is not in the active schema`, 'call mg_graph_schema for the legal type ids');
    }
    const title = String(args?.title ?? '').trim();
    const fields = normalizeFields(args?.fields, tool);
    const summary = String(args?.summary ?? '').trim();
    if (summary) fields.summary = summary;
    const links = normalizeLinkSpecs(args?.links, env, tool);
    const store = env.working;
    const beforeIds = new Set(Object.keys(store.nodes || {}));
    const beforeArchived = collectArchived(store);
    let res;
    try {
        res = await env.writeApi.createNode({ type, title, fields, ...(links.length ? { links } : {}) });
    } catch (err) {
        throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
    }
    const node = store.nodes?.[res.id];
    if (!node) throw new GraphToolError(tool, 'not_allowed', 'created node could not be resolved');
    const created = !beforeIds.has(res.id);
    const archivedLosers = [...collectArchived(store)].filter((id) => !beforeArchived.has(id));
    const actualTitle = String(node.title || '');
    const payload = {
        ok: true,
        id: res.id,
        action: created ? 'created' : 'updated',
        title: actualTitle,
        changed: true,
        ...(archivedLosers.length ? { archived_losers: archivedLosers } : {}),
    };
    if (title && actualTitle !== title) {
        payload.note = `stored title is "${actualTitle}" — event nodes receive an automatic summary title`;
    }
    return payload;
}

async function execEditNode(args, env) {
    const tool = 'mg_graph_edit_node';
    const nodeId = requireString(args?.node_id, 'node_id', tool);
    const store = env.working;
    const node = store.nodes?.[nodeId];
    if (!node) throw new GraphToolError(tool, 'not_found', `node ${nodeId} does not exist`, NODE_ID_HINT);
    const wantsUnarchive = args?.archived === false;
    if (node.archived && !wantsUnarchive) {
        throw new GraphToolError(tool, 'not_allowed', `node ${nodeId} is archived`, 'pass archived:false to unarchive and edit it');
    }
    const nextType = args?.type !== undefined ? String(args.type).trim().toLowerCase() : '';
    if (nextType && !schemaHasType(nextType, env)) {
        throw new GraphToolError(tool, 'invalid_args', `type "${nextType}" is not in the active schema`, 'call mg_graph_schema for the legal type ids');
    }
    let changed = false;
    if (wantsUnarchive && node.archived) {
        node.archived = false;
        changed = true;
    }
    if (nextType && nextType !== String(node.type || '').toLowerCase()) {
        node.type = nextType;
        changed = true;
    }
    const setFields = normalizeFields(args?.set_fields, tool);
    const clearFields = Array.isArray(args?.clear_fields)
        ? args.clear_fields.map((k) => String(k).trim()).filter(Boolean)
        : [];
    const hasTitle = args?.title !== undefined;
    if (Object.keys(setFields).length > 0 || clearFields.length > 0 || hasTitle) {
        let res;
        try {
            res = await env.writeApi.editNode({
                id: nodeId,
                setFields,
                clearFields,
                ...(hasTitle ? { title: String(args.title ?? '') } : {}),
            });
        } catch (err) {
            throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
        }
        if (res?.ok === false) {
            throw new GraphToolError(tool, 'not_allowed', String(res?.error?.message || res?.error?.code || 'edit rejected'));
        }
        if (res?.changed) changed = true;
    }
    if (!changed) return { ok: true, changed: false, note: 'values already match' };
    return { ok: true, changed: true, id: nodeId };
}

async function execDeleteNode(args, env) {
    const tool = 'mg_graph_delete_node';
    const nodeId = requireString(args?.node_id, 'node_id', tool);
    const node = env.working?.nodes?.[nodeId];
    if (!node) throw new GraphToolError(tool, 'not_found', `node ${nodeId} does not exist`, NODE_ID_HINT);
    const children = (node.childrenIds || []).filter((id) => env.working.nodes?.[id]);
    const recursive = Boolean(args?.recursive);
    if (children.length > 0 && !recursive) {
        throw new GraphToolError(
            tool,
            'not_allowed',
            `node ${nodeId} still has ${children.length} child node(s): ${children.join(', ')}`,
            'use mg_graph_merge_nodes to fold them into another node, or pass recursive:true to delete the whole subtree',
        );
    }
    const beforeCount = Object.keys(env.working.nodes).length;
    let res;
    try {
        res = await env.writeApi.deleteNode({ id: nodeId });
    } catch (err) {
        throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
    }
    if (res?.ok === false) throw new GraphToolError(tool, 'not_found', String(res?.error?.message || nodeId));
    return { ok: true, changed: true, deleted: nodeId, removed_nodes: beforeCount - Object.keys(env.working.nodes).length };
}

async function execMergeNodes(args, env) {
    const tool = 'mg_graph_merge_nodes';
    const survivorId = requireString(args?.survivor_id, 'survivor_id', tool);
    const store = env.working;
    const survivor = store.nodes?.[survivorId];
    if (!survivor) throw new GraphToolError(tool, 'not_found', `survivor ${survivorId} does not exist`, NODE_ID_HINT);
    if (survivor.archived) throw new GraphToolError(tool, 'not_allowed', `survivor ${survivorId} is archived`, 'unarchive it or pick a live survivor');
    const loserIds = [...new Set(
        (Array.isArray(args?.loser_ids) ? args.loser_ids : [])
            .map((id) => String(id || '').trim())
            .filter(Boolean),
    )].filter((id) => id !== survivorId);
    if (loserIds.length === 0) {
        throw new GraphToolError(tool, 'invalid_args', 'loser_ids must contain at least one id different from survivor_id');
    }
    for (const id of loserIds) {
        if (!store.nodes?.[id]) throw new GraphToolError(tool, 'not_found', `loser ${id} does not exist`, NODE_ID_HINT);
    }
    const setFields = normalizeFields(args?.fields, tool);
    const summary = String(args?.summary ?? '').trim();
    if (summary) setFields.summary = summary;
    const hasFields = Object.keys(setFields).length > 0;
    let fieldsChanged = false;
    if (hasFields) {
        let res;
        try {
            res = await env.writeApi.editNode({ id: survivorId, setFields });
        } catch (err) {
            throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
        }
        if (res?.ok === false) {
            throw new GraphToolError(tool, 'not_allowed', String(res?.error?.message || res?.error?.code || 'edit rejected'));
        }
        fieldsChanged = res?.changed === true;
    }
    const archived = [];
    for (const id of loserIds) {
        if (store.nodes[id].archived) continue;
        try {
            const res = await env.writeApi.archiveNode({ id, replacementId: survivorId });
            if (res && res.ok === false) {
                throw new Error(String(res.error?.message || `archive failed for ${id}`));
            }
        } catch (err) {
            throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
        }
        archived.push(id);
    }
    const changed = archived.length > 0 || (hasFields && fieldsChanged);
    const payload = {
        ok: true,
        changed,
        survivor_id: survivorId,
        archived_losers: archived,
    };
    if (!changed) {
        const reasons = [];
        if (archived.length === 0) reasons.push('all loser nodes were already archived');
        if (hasFields && !fieldsChanged) reasons.push('supplied fields already match the survivor');
        payload.note = reasons.join('; ');
    }
    return payload;
}

async function execUpsertLinks(args, env) {
    const tool = 'mg_graph_upsert_links';
    const sourceId = requireString(args?.source_node_id, 'source_node_id', tool);
    const source = env.working?.nodes?.[sourceId];
    if (!source) throw new GraphToolError(tool, 'not_found', `source ${sourceId} does not exist`, NODE_ID_HINT);
    if (source.archived) throw new GraphToolError(tool, 'not_allowed', `source ${sourceId} is archived`);
    if (!Array.isArray(args?.links) || args.links.length === 0) {
        throw new GraphToolError(tool, 'invalid_args', 'links must be a non-empty array');
    }
    const links = normalizeLinkSpecs(args.links, env, tool);
    let res;
    try {
        res = await env.writeApi.upsertLinks({ source: { id: sourceId }, links });
    } catch (err) {
        throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
    }
    if (res?.error) throw new GraphToolError(tool, 'not_allowed', String(res.error.message || res.error.code || 'link rejected'));
    if (!res?.applied) return { ok: true, changed: false, note: 'links already exist' };
    return { ok: true, changed: true, added_edges: res.applied };
}

async function execEditLink(args, env) {
    const tool = 'mg_graph_edit_link';
    const sourceId = requireString(args?.source_node_id, 'source_node_id', tool);
    const targetId = requireString(args?.target_node_id, 'target_node_id', tool);
    const relation = normalizeRelation(args?.relation, tool);
    const newRelation = normalizeRelation(args?.new_relation, tool);
    if (relation === newRelation) return { ok: true, changed: false, note: 'relation already matches' };
    const store = env.working;
    const source = store.nodes?.[sourceId];
    if (!source) throw new GraphToolError(tool, 'not_found', `source ${sourceId} does not exist`, NODE_ID_HINT);
    if (source.archived) throw new GraphToolError(tool, 'not_allowed', `source ${sourceId} is archived`);
    const target = store.nodes?.[targetId];
    if (!target) throw new GraphToolError(tool, 'not_found', `target ${targetId} does not exist`, NODE_ID_HINT);
    if (target.archived) throw new GraphToolError(tool, 'not_allowed', `target ${targetId} is archived`);
    const forward = hasEdge(store, sourceId, targetId, relation);
    const backward = hasEdge(store, targetId, sourceId, relation);
    if (!forward && !backward) {
        throw new GraphToolError(tool, 'not_found', `no "${relation}" edge between ${sourceId} and ${targetId}`, 'call mg_graph_node_detail to list the current edges');
    }
    const links = [];
    if (forward) links.push({ targetNodeId: targetId, relation: newRelation, direction: 'outgoing' });
    if (backward) links.push({ targetNodeId: targetId, relation: newRelation, direction: 'incoming' });
    try {
        const added = await env.writeApi.upsertLinks({ source: { id: sourceId }, links });
        if (added?.error) throw new Error(String(added.error.message || added.error.code || 'link rejected'));
        const removed = await env.writeApi.deleteLinks({ source: { id: sourceId }, target: { id: targetId }, relation, direction: 'bidirectional' });
        if (!removed?.removed) throw new Error(`old "${relation}" edge could not be removed`);
    } catch (err) {
        throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
    }
    return { ok: true, changed: true, relation: newRelation };
}

async function execDeleteLink(args, env) {
    const tool = 'mg_graph_delete_link';
    const sourceId = requireString(args?.source_node_id, 'source_node_id', tool);
    const targetId = requireString(args?.target_node_id, 'target_node_id', tool);
    const relation = normalizeRelation(args?.relation, tool);
    const direction = normalizeDirection(args?.direction, tool, 'outgoing');
    const store = env.working;
    let res;
    try {
        res = await env.writeApi.deleteLinks({ source: { id: sourceId }, target: { id: targetId }, relation, direction });
    } catch (err) {
        throw new GraphToolError(tool, 'not_allowed', String(err?.message || err));
    }
    if (!res?.removed) {
        const reverseExists = hasEdge(store, targetId, sourceId, relation);
        if (reverseExists) {
            throw new GraphToolError(
                tool,
                'not_found',
                `no "${relation}" edge from ${sourceId} to ${targetId} — an edge in the opposite direction exists; retry with direction:"bidirectional" or swap source/target`,
                'direction:"bidirectional" removes either orientation',
            );
        }
        throw new GraphToolError(tool, 'not_found', `no "${relation}" edge between ${sourceId} and ${targetId}`, 'call mg_graph_node_detail to list the current edges');
    }
    return { ok: true, changed: true, removed: res.removed };
}

export async function executeGraphReadTool({ name, args } = {}, env = {}) {
    const tool = String(name || '');
    if (!env.working) throw new GraphToolError(tool || 'unknown', 'not_allowed', 'no graph is loaded for this chat');
    switch (tool) {
        case 'mg_graph_read_fields': return execReadFields(args, env);
        case 'mg_graph_list_nodes': return execListNodes(args, env);
        case 'mg_graph_search_nodes': return await execSearchNodes(args, env);
        case 'mg_graph_node_detail': return execNodeDetail(args, env);
        case 'mg_graph_neighbors': return execNeighbors(args, env);
        case 'mg_graph_schema': return execSchema(args, env);
        case 'mg_graph_read_chat': return await execReadChat(args, env);
        default: throw new GraphToolError(tool || 'unknown', 'unknown_tool', `unknown read tool "${tool}"`);
    }
}

export async function executeGraphWriteTool({ name, args } = {}, env = {}) {
    const tool = String(name || '');
    if (!env.working) throw new GraphToolError(tool || 'unknown', 'not_allowed', 'no graph is loaded for this chat');
    if (!env.writeApi) throw new GraphToolError(tool, 'not_allowed', 'write API is unavailable');
    switch (tool) {
        case 'mg_graph_create_node': return await execCreateNode(args, env);
        case 'mg_graph_edit_node': return await execEditNode(args, env);
        case 'mg_graph_delete_node': return await execDeleteNode(args, env);
        case 'mg_graph_merge_nodes': return await execMergeNodes(args, env);
        case 'mg_graph_upsert_links': return await execUpsertLinks(args, env);
        case 'mg_graph_edit_link': return await execEditLink(args, env);
        case 'mg_graph_delete_link': return await execDeleteLink(args, env);
        default: throw new GraphToolError(tool || 'unknown', 'unknown_tool', `unknown write tool "${tool}"`);
    }
}
