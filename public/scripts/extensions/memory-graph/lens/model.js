// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure data layer: normalizes a raw memory-graph snapshot into indexed
// structures, applies filters, parses event summaries and ranks search hits.
// No DOM access — covered by tests/model.test.mjs.

import { i18nFormat, listSeparator } from './i18n.js';

export const INTERNAL_EDGE_TYPES = new Set(['contains', 'semantic_contains']);
export const SYMMETRIC_RELATIONS = new Set(['partner_of', 'family_of', 'allied_with', 'hostile_to']);
export const BOND_RELATIONS = new Set(['partner_of', 'family_of', 'allied_with', 'mentor_of', 'sworn_to', 'debt_owed_to']);
export const CONFLICT_RELATIONS = new Set(['hostile_to', 'deceiving']);
export const KNOWN_TYPE_ORDER = ['event', 'character_sheet', 'location_state', 'thread', 'rule_constraint'];

// Visual identity per node type: palette key (resolved by CSS tokens) + graph shape.
const TYPE_VISUALS = {
    event: { tone: 'event', shape: 'round-rectangle', icon: 'bolt' },
    character_sheet: { tone: 'character', shape: 'ellipse', icon: 'user' },
    location_state: { tone: 'location', shape: 'round-diamond', icon: 'mapPin' },
    thread: { tone: 'thread', shape: 'round-hexagon', icon: 'thread' },
    rule_constraint: { tone: 'rule', shape: 'round-tag', icon: 'doc' },
};
const FALLBACK_TONES = ['extra1', 'extra2', 'extra3', 'extra4'];

export function typeVisual(type) {
    if (TYPE_VISUALS[type]) return TYPE_VISUALS[type];
    let hash = 0;
    for (const ch of String(type)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return { tone: FALLBACK_TONES[hash % FALLBACK_TONES.length], shape: 'round-octagon', icon: 'hexagon' };
}

export function relationCategory(type) {
    if (INTERNAL_EDGE_TYPES.has(type)) return 'hierarchy';
    if (CONFLICT_RELATIONS.has(type)) return 'conflict';
    if (BOND_RELATIONS.has(type)) return 'bond';
    return 'structural';
}

function toArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value[Symbol.iterator] === 'function') return [...value];
    return [];
}

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

function fieldText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join(listSeparator());
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return ''; }
    }
    return String(value);
}

// ---------------------------------------------------------------------------
// Event summary parsing (format documented in memory-graph default prompts)
// ---------------------------------------------------------------------------

const HEADER_PATTERNS = [
    { key: 'time', re: /^(?:时间|時間|time|when)\s*[:：]\s*(.+)$/i },
    { key: 'place', re: /^(?:地点|地點|place|location|where)\s*[:：]\s*(.+)$/i },
];
const SECTION_PATTERNS = [
    { key: 'irreversible', re: /^(?:不可逆|irreversible)\s*[:：]?\s*$/i },
    { key: 'open', re: /^(?:未结|未結|open|unresolved)\s*[:：]?\s*$/i },
    { key: 'quotes', re: /^(?:原文摘录|原文摘錄|quotes?)\s*[:：]?\s*$/i },
];
const BULLET_RE = /^\s*(?:[-*•·]|\d+[.)、])\s+/;
const QUOTE_CHARS = /^["'“”「」『』]+|["'“”「」『』]+$/g;

function parseOpenItem(text) {
    const match = text.match(/^(?:→|->)?\s*thread\s*[:：]?\s*["“「『]?(.+?)["”」』]?\s*$/i);
    if (match) return { text, threadTitle: match[1].trim() };
    return { text: text.replace(/^(?:→|->)\s*/, '') };
}

function parseQuoteItem(text) {
    const match = text.match(/^([^:：“"「]{1,24})[:：]\s*(.+)$/);
    if (match) return { label: match[1].trim(), quote: match[2].trim().replace(QUOTE_CHARS, '') };
    return { label: '', quote: text.replace(QUOTE_CHARS, '') };
}

const FLAT_HEADER = /(?:^|\s)(时间|時間|地点|地點|time|place|location|when|where)\s*[:：]/gi;
const FLAT_SECTION = /\s(不可逆|未结|未結|原文摘录|原文摘錄|irreversible|unresolved|quotes?)\s*[:：]\s*/gi;

/**
 * memory-graph's setNodeSummary() collapses all whitespace, so stored
 * summaries usually arrive on one line. Re-insert line breaks before the
 * known anchors / section headers and bullets so the parser can see the
 * documented structure again.
 */
export function restoreSummaryLayout(text) {
    let value = str(text).replace(/\r\n?/g, '\n');
    if (value.includes('\n')) return value;
    // Header anchors at the start: "time: X place: Y body…"
    value = value.replace(FLAT_HEADER, (match, label, offset) => `${offset > 0 ? '\n' : ''}${label}: `);
    // Sections and their bullets.
    value = value.replace(FLAT_SECTION, (_, label) => `\n\n${label}:\n`);
    value = value.replace(/\s+-\s+(?=\S)/g, '\n- ');
    // The prose body follows the last anchor on the same line; split it off.
    const lines = value.split('\n');
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
        if (HEADER_PATTERNS.some(p => p.re.test(lines[i].trim()))) last = i;
        else if (last >= 0) break;
    }
    if (last >= 0) {
        const match = lines[last].match(/^([^:：]+[:：]\s*)(.*)$/);
        const cut = match && splitAnchorValue(match[2]);
        if (cut) lines.splice(last, 1, `${match[1]}${cut[0]}`, '', cut[1]);
    }
    return lines.join('\n');
}

const SENTENCE_END = /[。！？!?；;，,.]/;
const CJK = /[\u3000-\u9fff]/;

/**
 * Split "<anchor value> <prose…>" that were flattened onto one line.
 * Heuristic: CJK anchor values are a single short token; Latin values are
 * a run of Capitalized words, ending before a "Subject verb" pair.
 * Returns null when no confident split exists (the line is kept whole).
 */
function splitAnchorValue(rest) {
    const words = rest.split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    if (CJK.test(words[0])) {
        if (SENTENCE_END.test(words[0]) || words[0].length > 16) return null;
        return [words[0], words.slice(1).join(' ')];
    }
    let end = 0;
    for (let i = 0; i < Math.min(words.length - 1, 6); i++) {
        const word = words[i];
        const capital = /^[A-Z0-9]/.test(word);
        const connector = i > 0 && /^(of|the|de|la|du|von|van|and|&)$/i.test(word);
        if (!capital && !connector) break;
        end = i + 1;
        if (SENTENCE_END.test(word.slice(-1))) break;
        // "…Glade Seraphina found…": the next capital word starts the sentence.
        const next = words[i + 1] || '';
        const after = words[i + 2] || '';
        if (/^[A-Z]/.test(next) && /^[a-z]/.test(after) && !/^(of|the|and|de|la|du|von|van)$/i.test(after)) break;
    }
    if (end <= 0 || end >= words.length) return null;
    return [words.slice(0, end).join(' ').replace(/[,;.]$/, ''), words.slice(end).join(' ')];
}

export function parseEventSummary(raw) {
    const result = { time: '', place: '', prose: [], irreversible: [], open: [], quotes: [] };
    const lines = restoreSummaryLayout(raw).split('\n');
    let section = null;
    let paragraph = [];
    let headerZone = true;
    const flushParagraph = () => {
        if (paragraph.length) result.prose.push(paragraph.join('\n').trim());
        paragraph = [];
    };
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            if (!section) flushParagraph();
            continue;
        }
        if (headerZone && !section) {
            const header = HEADER_PATTERNS.find(p => p.re.test(line));
            if (header && !result[header.key]) {
                result[header.key] = line.match(header.re)[1].trim();
                continue;
            }
        }
        const sectionMatch = SECTION_PATTERNS.find(p => p.re.test(line));
        if (sectionMatch) {
            flushParagraph();
            section = sectionMatch.key;
            headerZone = false;
            continue;
        }
        headerZone = false;
        if (section) {
            const item = line.replace(BULLET_RE, '').trim();
            if (!item) continue;
            if (section === 'open') result.open.push(parseOpenItem(item));
            else if (section === 'quotes') result.quotes.push(parseQuoteItem(item));
            else result.irreversible.push(item);
            continue;
        }
        paragraph.push(line);
    }
    flushParagraph();
    result.prose = result.prose.filter(Boolean);
    return result;
}

const PLACEHOLDER_TITLE = /^(?:[\w\s-]*\s)?(?:summary|摘要)(?:\s+L\d+)?\s*#?\s*\d+$/i;

export function isPlaceholderTitle(title) {
    return PLACEHOLDER_TITLE.test(str(title).trim());
}

function firstSentence(text, max = 42) {
    const value = str(text).replace(/\s+/g, ' ').trim();
    if (!value) return '';
    const cut = value.split(/(?<=[。！？!?；;])|(?<=\.)\s/)[0] || value;
    return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut;
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/**
 * @param {object} snapshot raw snapshot from a source adapter
 * @returns normalized, indexed model
 */
export function buildModel(snapshot = {}) {
    const nodes = new Map();
    for (const raw of toArray(snapshot.nodes)) {
        if (!raw || !raw.id) continue;
        const type = str(raw.type).trim() || 'unknown';
        if (type === 'recall' || type.startsWith('recall_')) continue;
        const fields = raw.fields && typeof raw.fields === 'object' ? { ...raw.fields } : {};
        const depth = Number.isFinite(Number(raw.semanticDepth)) ? Math.max(0, Math.floor(Number(raw.semanticDepth))) : 0;
        const floorRange = raw.floorRange && Number.isFinite(raw.floorRange.start) && Number.isFinite(raw.floorRange.end)
            ? { start: raw.floorRange.start, end: raw.floorRange.end }
            : null;
        const node = {
            id: str(raw.id),
            type,
            level: raw.level === 'semantic' ? 'semantic' : 'episodic',
            rawTitle: str(raw.title).trim(),
            fields,
            seqTo: Number.isFinite(Number(raw.seqTo)) ? Number(raw.seqTo) : -1,
            floorRange,
            parentId: str(raw.parentId),
            childrenIds: toArray(raw.childrenIds).map(str).filter(Boolean),
            archived: Boolean(raw.archived),
            depth,
            isRollup: type === 'event' && (Boolean(raw.semanticRollup) || depth > 0),
            parsed: null,
            title: '',
            summaryText: '',
            searchText: '',
            degree: 0,
        };
        node.summaryText = fieldText(fields.summary ?? fields.note ?? fields.state ?? '');
        if (type === 'event') node.parsed = parseEventSummary(node.summaryText);
        // memory-graph auto-names events "Summary 3" / "Event Summary L1 #2";
        // those carry no meaning, so prefer the prose's first sentence.
        const placeholder = type === 'event' && isPlaceholderTitle(node.rawTitle);
        node.title = (placeholder ? '' : node.rawTitle)
            || fieldText(fields.title)
            || (node.parsed ? firstSentence(node.parsed.prose[0] || node.summaryText) : '')
            || firstSentence(node.summaryText)
            || node.rawTitle
            || node.id;
        node.autoTitle = placeholder ? node.rawTitle : '';
        node.searchText = [node.title, node.id, ...Object.values(fields).map(fieldText)].join('\n').toLowerCase();
        nodes.set(node.id, node);
    }

    const edges = [];
    const adjacency = new Map();
    const link = (a, b, edge) => {
        if (!adjacency.has(a)) adjacency.set(a, []);
        adjacency.get(a).push(edge);
    };
    // memory-graph often stores one relation as a mirrored pair (A→B + B→A,
    // e.g. involved_in written from both ends). Collapse any exact reverse
    // duplicate into one edge so it draws once and counts once.
    const seenPairs = new Map();
    toArray(snapshot.edges).forEach((raw, index) => {
        const from = str(raw?.from);
        const to = str(raw?.to);
        if (!from || !to || !nodes.has(from) || !nodes.has(to) || from === to) return;
        const type = str(raw.type).trim() || 'related';
        const forwardKey = `${type}|${from}|${to}`;
        const reverseKey = `${type}|${to}|${from}`;
        if (seenPairs.has(forwardKey)) return;
        if (seenPairs.has(reverseKey)) {
            const existing = seenPairs.get(reverseKey);
            // Mirrored pair on a directed type: the relation is effectively mutual.
            existing.mirrored = true;
            return;
        }
        const edge = {
            key: `e${index}`,
            from,
            to,
            type,
            category: relationCategory(type),
            internal: INTERNAL_EDGE_TYPES.has(type),
            directed: !SYMMETRIC_RELATIONS.has(type),
            mirrored: false,
        };
        seenPairs.set(forwardKey, edge);
        edges.push(edge);
        link(from, to, edge);
        link(to, from, edge);
        if (!edge.internal) {
            nodes.get(from).degree += 1;
            nodes.get(to).degree += 1;
        }
    });

    for (const edge of edges) {
        if (edge.mirrored) edge.directed = false;
    }

    // Rollup hierarchy: trust parentId/childrenIds, but repair one-sided links.
    for (const node of nodes.values()) {
        node.childrenIds = node.childrenIds.filter(id => nodes.has(id));
        for (const childId of node.childrenIds) {
            const child = nodes.get(childId);
            if (!child.parentId) child.parentId = node.id;
        }
        if (node.parentId && !nodes.has(node.parentId)) node.parentId = '';
    }
    for (const node of nodes.values()) {
        if (node.parentId) {
            const parent = nodes.get(node.parentId);
            if (!parent.childrenIds.includes(node.id)) parent.childrenIds.push(node.id);
        }
    }

    const types = new Map();
    for (const node of nodes.values()) {
        types.set(node.type, (types.get(node.type) || 0) + 1);
    }
    const typeList = [...types.keys()].sort((a, b) => {
        const ar = KNOWN_TYPE_ORDER.indexOf(a);
        const br = KNOWN_TYPE_ORDER.indexOf(b);
        return (ar < 0 ? 99 : ar) - (br < 0 ? 99 : br) || a.localeCompare(b);
    });
    const relations = new Map();
    for (const edge of edges) relations.set(edge.type, (relations.get(edge.type) || 0) + 1);

    const injection = {
        recalled: new Set(toArray(snapshot.injection?.recallSelectedIds).map(str)),
        pinned: new Set(toArray(snapshot.injection?.alwaysInjectIds).map(str)),
        candidates: new Set(toArray(snapshot.injection?.visibleIds).map(str)),
    };

    const schemaColumns = new Map();
    const schemaHints = new Map(); // type → { column: instruction for the extractor }
    for (const spec of toArray(snapshot.schema?.types)) {
        const type = str(spec?.type || spec?.id);
        if (!type) continue;
        schemaColumns.set(type, toArray(spec.tableColumns).map(str).filter(Boolean));
        schemaHints.set(type, spec.columnHints && typeof spec.columnHints === 'object' ? { ...spec.columnHints } : {});
    }

    let maxFloor = -1;
    for (const node of nodes.values()) {
        maxFloor = Math.max(maxFloor, node.floorRange?.end ?? -1, node.seqTo);
    }

    return {
        chatKey: str(snapshot.chatKey),
        chatLabel: str(snapshot.chatLabel),
        loadedAt: snapshot.loadedAt || Date.now(),
        nodes,
        edges,
        adjacency,
        typeCounts: types,
        typeList,
        relationCounts: relations,
        injection,
        schemaColumns,
        schemaHints,
        lastRecall: snapshot.lastRecall || null,
        tokens: snapshot.tokens || null,
        maxFloor,
    };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function compareTimeline(a, b) {
    const af = a.floorRange?.start ?? a.seqTo;
    const bf = b.floorRange?.start ?? b.seqTo;
    if (a.seqTo !== b.seqTo) return a.seqTo - b.seqTo;
    if (af !== bf) return af - bf;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.id.localeCompare(b.id);
}

export function contextState(model, id) {
    if (model.injection.recalled.has(id)) return 'recalled';
    if (model.injection.pinned.has(id)) return 'pinned';
    if (model.injection.candidates.has(id)) return 'candidate';
    return '';
}

export function isInContext(model, id) {
    return model.injection.recalled.has(id) || model.injection.pinned.has(id);
}

/** Neighbours of a node, grouped and de-duplicated, excluding hierarchy edges. */
export function neighborsOf(model, id, { includeInternal = false } = {}) {
    const out = [];
    const seen = new Set();
    for (const edge of model.adjacency.get(id) || []) {
        if (edge.internal && !includeInternal) continue;
        const otherId = edge.from === id ? edge.to : edge.from;
        const key = `${edge.type}|${otherId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            edge,
            node: model.nodes.get(otherId),
            direction: !edge.directed ? 'both' : edge.from === id ? 'out' : 'in',
        });
    }
    return out.filter(item => item.node);
}

export function entitiesOfEvent(model, id) {
    const characters = [];
    const locations = [];
    const threads = [];
    for (const { node } of neighborsOf(model, id)) {
        if (node.type === 'character_sheet' && !characters.includes(node)) characters.push(node);
        else if (node.type === 'location_state' && !locations.includes(node)) locations.push(node);
        else if (node.type === 'thread' && !threads.includes(node)) threads.push(node);
    }
    return { characters, locations, threads };
}

export function defaultFilters() {
    return {
        hiddenTypes: new Set(),
        hiddenRelations: new Set(),
        depth: 'all',
        showArchived: false,
        showHierarchy: true,
        onlyContext: false,
        focusEntityId: '',
    };
}

export function isDefaultFilters(filters) {
    return filters.hiddenTypes.size === 0
        && filters.hiddenRelations.size === 0
        && filters.depth === 'all'
        && !filters.showArchived
        && filters.showHierarchy
        && !filters.onlyContext
        && !filters.focusEntityId;
}

export function nodePassesFilters(model, node, filters) {
    if (!node) return false;
    if (filters.hiddenTypes.has(node.type)) return false;
    if (node.archived && !filters.showArchived) return false;
    if (node.type === 'event') {
        if (filters.depth === 'leaf' && node.isRollup) return false;
        if (filters.depth === 'rollup' && !node.isRollup) return false;
    }
    if (filters.onlyContext && !isInContext(model, node.id)) return false;
    return true;
}

/**
 * Visible subgraph for the graph view. Caps the node count (newest first)
 * because huge canvases are neither readable nor fast.
 */
export function visibleSubgraph(model, filters, { maxNodes = 450 } = {}) {
    let list = [...model.nodes.values()].filter(node => nodePassesFilters(model, node, filters));
    let truncated = false;
    if (list.length > maxNodes) {
        list.sort(compareTimeline);
        list = list.slice(-maxNodes);
        truncated = true;
    }
    const ids = new Set(list.map(node => node.id));
    const edges = model.edges.filter(edge => {
        if (!ids.has(edge.from) || !ids.has(edge.to)) return false;
        if (edge.internal) return filters.showHierarchy;
        return !filters.hiddenRelations.has(edge.type);
    });
    return { nodes: list, ids, edges, truncated, total: model.nodes.size };
}

/**
 * Timeline chapters: each top-level rollup becomes a chapter containing its
 * subtree; un-summarized leaves are collected into a trailing loose group.
 */
export function buildChapters(model, filters) {
    const passes = (node) => nodePassesFilters(model, node, { ...filters, depth: 'all', onlyContext: false });
    const focusIds = filters.focusEntityId
        ? new Set(neighborsOf(model, filters.focusEntityId).map(item => item.node.id))
        : null;
    const leafVisible = (node) => {
        if (!passes(node)) return false;
        if (filters.onlyContext && !isInContext(model, node.id)) return false;
        if (focusIds && !focusIds.has(node.id)) return false;
        return true;
    };
    const events = [...model.nodes.values()].filter(node => node.type === 'event');
    const byId = model.nodes;

    const buildTree = (node) => {
        const children = node.childrenIds
            .map(id => byId.get(id))
            .filter(child => child && child.type === 'event')
            .sort(compareTimeline)
            .map(buildTree)
            .filter(Boolean);
        const selfVisible = node.isRollup ? passes(node) : leafVisible(node);
        if (node.isRollup) {
            if (!children.length && !(selfVisible && !focusIds && !filters.onlyContext)) return null;
            return { node, children, leafCount: children.reduce((sum, c) => sum + (c.leafCount || (c.node.isRollup ? 0 : 1)), 0) };
        }
        return selfVisible ? { node, children: [], leafCount: 1 } : null;
    };

    const roots = events.filter(node => !node.parentId || !byId.get(node.parentId) || byId.get(node.parentId).type !== 'event');
    const chapters = [];
    const loose = [];
    for (const root of roots.sort(compareTimeline)) {
        const tree = buildTree(root);
        if (!tree) continue;
        if (root.isRollup) chapters.push(tree);
        else loose.push(tree);
    }
    return { chapters, loose };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function snippetAround(text, needle, radius = 26) {
    const value = str(text).replace(/\s+/g, ' ');
    const index = value.toLowerCase().indexOf(needle);
    if (index < 0) return value.slice(0, radius * 2);
    const start = Math.max(0, index - radius);
    const end = Math.min(value.length, index + needle.length + radius);
    return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

export function searchNodes(model, query, { limit = 30 } = {}) {
    const q = str(query).trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const hits = [];
    for (const node of model.nodes.values()) {
        const title = node.title.toLowerCase();
        let score = 0;
        let ok = true;
        for (const token of tokens) {
            if (!node.searchText.includes(token)) { ok = false; break; }
            if (node.id.toLowerCase() === token) score += 50;
            if (title === token) score += 30;
            else if (title.startsWith(token)) score += 16;
            else if (title.includes(token)) score += 9;
            else score += 2;
        }
        if (!ok) continue;
        if (node.archived) score -= 4;
        score += Math.min(4, node.degree * 0.25);
        if (isInContext(model, node.id)) score += 1;
        const bodySource = node.type === 'event' ? (node.parsed?.prose.join(' ') || node.summaryText) : Object.values(node.fields).map(fieldText).join(' · ');
        hits.push({ node, score, snippet: snippetAround(bodySource, tokens[0]) });
    }
    hits.sort((a, b) => b.score - a.score || b.node.seqTo - a.node.seqTo);
    return hits.slice(0, limit);
}

export function formatFloor(node) {
    if (node.floorRange) {
        const { start, end } = node.floorRange;
        return start === end ? i18nFormat('Floor ${0}', start) : i18nFormat('Floors ${0}–${1}', start, end);
    }
    return node.seqTo >= 0 ? i18nFormat('Turn ${0}', node.seqTo) : '';
}

export { fieldText };
