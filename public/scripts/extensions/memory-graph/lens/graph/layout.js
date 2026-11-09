// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deterministic layouts (pure functions, no DOM):
//   - forceLayout: seeded force-directed "network" view
//   - chronoLayout: story spine — events left→right by time, summaries
//     stacked above, entities packed into bands around the spine.
// Determinism keeps positions stable across live refreshes.

import { compareTimeline } from '../model.js';
import { hashString } from '../../../lens-shared/util.js';

export function nodeRadius(node) {
    if (node.type === 'event') return node.isRollup ? 15 + Math.min(6, node.depth * 2) : 11;
    const degreeBoost = Math.min(20, Math.sqrt(node.degree || 0) * 5);
    return 16 + degreeBoost;
}

function seededPoint(id, spread) {
    const h1 = hashString(id);
    const h2 = hashString(`${id}#`);
    const angle = (h1 / 0xffffffff) * Math.PI * 2;
    const radius = Math.sqrt(h2 / 0xffffffff) * spread;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * @param {Array} nodes normalized model nodes
 * @param {Array} edges normalized model edges (both endpoints in `nodes`)
 * @param {{ initial?: Map<string,{x:number,y:number}>, iterations?: number }} options
 * @returns {Map<string, {x:number, y:number}>}
 */
export function forceLayout(nodes, edges, { initial = null, iterations = 280, aspect = 1 } = {}) {
    const n = nodes.length;
    const out = new Map();
    if (!n) return out;
    const k = 74;
    const spread = Math.sqrt(n) * k * 0.9;
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const rs = new Float64Array(n);
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    const springs = [];
    const linked = new Map();
    for (const edge of edges) {
        const a = index.get(edge.from);
        const b = index.get(edge.to);
        if (a === undefined || b === undefined) continue;
        springs.push([a, b, edge.internal ? 0.55 : 1, edge.internal ? k * 0.8 : k]);
        push(linked, edge.from, edge.to);
        push(linked, edge.to, edge.from);
    }

    // Seed positions: cached ones are kept; nodes that appear during a live
    // refresh start next to an already-placed neighbour instead of a random
    // far-away spot, so the existing picture barely moves.
    let fresh = 0;
    nodes.forEach((node, i) => {
        let start = initial?.get(node.id);
        if (!start && initial?.size) {
            const anchorId = (linked.get(node.id) || []).find(id => initial.has(id));
            const jitter = seededPoint(node.id, k * 0.8);
            if (anchorId) {
                const anchor = initial.get(anchorId);
                start = { x: anchor.x + jitter.x, y: anchor.y + jitter.y };
            } else {
                start = jitter;
            }
            fresh++;
        }
        start = start || seededPoint(node.id, spread);
        xs[i] = start.x;
        ys[i] = start.y;
        rs[i] = nodeRadius(node);
    });

    const ratio = Math.min(2.4, Math.max(0.42, Number(aspect) || 1));
    const gravityX = 0.035 / Math.sqrt(ratio);
    const gravityY = 0.035 * Math.sqrt(ratio);
    // Warm start when most nodes already have positions.
    const warm = Boolean(initial?.size) && fresh <= Math.max(3, n * 0.25);
    let temperature = warm ? k * 0.6 : spread * 0.25;
    const total = warm ? Math.round(iterations * 0.45) : iterations;
    const cooling = Math.pow(0.6 / Math.max(1, temperature), 1 / Math.max(1, total));

    for (let iter = 0; iter < total; iter++) {
        dx.fill(0);
        dy.fill(0);
        // Repulsion (all pairs; n is capped upstream).
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let ddx = xs[i] - xs[j];
                let ddy = ys[i] - ys[j];
                let dist2 = ddx * ddx + ddy * ddy;
                if (dist2 < 0.01) {
                    ddx = ((i * 7 + j) % 5) - 2 || 1;
                    ddy = ((i + j * 3) % 5) - 2 || 1;
                    dist2 = ddx * ddx + ddy * ddy;
                }
                if (dist2 > 360000) continue;
                const dist = Math.sqrt(dist2);
                const minGap = rs[i] + rs[j] + 18;
                let force = (k * k) / dist;
                if (dist < minGap) force += (minGap - dist) * 4;
                const fx = (ddx / dist) * force;
                const fy = (ddy / dist) * force;
                dx[i] += fx; dy[i] += fy;
                dx[j] -= fx; dy[j] -= fy;
            }
        }
        // Springs.
        for (const [a, b, weight, rest] of springs) {
            const ddx = xs[a] - xs[b];
            const ddy = ys[a] - ys[b];
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
            const force = ((dist - rest) * (dist / k)) * weight * 0.5;
            const fx = (ddx / dist) * force;
            const fy = (ddy / dist) * force;
            dx[a] -= fx; dy[a] -= fy;
            dx[b] += fx; dy[b] += fy;
        }
        // Gravity keeps disconnected islands close; anisotropic so the
        // result roughly matches the canvas aspect ratio.
        for (let i = 0; i < n; i++) {
            dx[i] -= xs[i] * gravityX;
            dy[i] -= ys[i] * gravityY;
            const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
            if (len > 0) {
                const step = Math.min(len, temperature);
                xs[i] += (dx[i] / len) * step;
                ys[i] += (dy[i] / len) * step;
            }
        }
        temperature *= cooling;
    }

    nodes.forEach((node, i) => {
        out.set(node.id, { x: Math.round(xs[i] * 10) / 10, y: Math.round(ys[i] * 10) / 10 });
    });
    return out;
}

const BAND_ORDER = ['character_sheet', 'location_state'];

/**
 * @param {Array} nodes normalized model nodes (already filtered)
 * @param {Array} edges visible edges
 * @returns {Map<string, {x:number, y:number}>}
 */
export function chronoLayout(nodes, edges) {
    const out = new Map();
    if (!nodes.length) return out;
    const colGap = 76;
    const rowGap = 96;
    const bandGap = 120;
    const rowHeight = 58;
    const minSpacing = 112;

    const events = nodes.filter(node => node.type === 'event').sort(compareTimeline);
    const leaves = events.filter(node => !node.isRollup);
    const rollups = events.filter(node => node.isRollup).sort((a, b) => a.depth - b.depth || compareTimeline(a, b));
    const ids = new Set(nodes.map(node => node.id));

    // Floor → x interpolation for anything we cannot anchor directly.
    const anchors = leaves.map((node, i) => ({ seq: node.seqTo, x: i * colGap }));
    const xForSeq = (seq) => {
        if (!anchors.length) return 0;
        if (seq <= anchors[0].seq) return anchors[0].x;
        for (let i = 1; i < anchors.length; i++) {
            if (seq <= anchors[i].seq) {
                const a = anchors[i - 1];
                const b = anchors[i];
                const span = b.seq - a.seq || 1;
                return a.x + ((seq - a.seq) / span) * (b.x - a.x);
            }
        }
        return anchors[anchors.length - 1].x;
    };

    leaves.forEach((node, i) => out.set(node.id, { x: i * colGap, y: 0 }));
    let maxDepth = 0;
    for (const node of rollups) {
        const childXs = node.childrenIds.filter(id => out.has(id)).map(id => out.get(id).x);
        const x = childXs.length ? childXs.reduce((s, v) => s + v, 0) / childXs.length : xForSeq(node.seqTo);
        const depth = Math.max(1, node.depth);
        maxDepth = Math.max(maxDepth, depth);
        out.set(node.id, { x, y: -depth * rowGap });
    }

    // Entities: anchor at the mean x of the events they touch.
    const eventXs = new Map();
    for (const edge of edges) {
        if (edge.internal) continue;
        const a = out.get(edge.from);
        const b = out.get(edge.to);
        if (a && !out.has(edge.to) && ids.has(edge.to)) push(eventXs, edge.to, a.x);
        if (b && !out.has(edge.from) && ids.has(edge.from)) push(eventXs, edge.from, b.x);
    }
    const others = nodes.filter(node => node.type !== 'event');
    const bandIndex = (type) => {
        const i = BAND_ORDER.indexOf(type);
        return i >= 0 ? i : BAND_ORDER.length;
    };
    const bands = new Map();
    for (const node of others) {
        // Entities enter the spine at their first appearance.
        const xsForNode = eventXs.get(node.id);
        const x = xsForNode?.length ? Math.min(...xsForNode) : xForSeq(node.seqTo);
        const key = node.type === 'thread' ? 'above' : `below:${bandIndex(node.type)}`;
        if (!bands.has(key)) bands.set(key, []);
        bands.get(key).push({ node, x });
    }

    // Rows are as tall as their largest node plus room for the label.
    const rowExtent = (row) => Math.max(...row.map(({ node }) => nodeRadius(node))) * 2 + 30;
    let cursorBelow = bandGap * 0.75;
    const belowKeys = [...bands.keys()].filter(key => key.startsWith('below:')).sort();
    for (const key of belowKeys) {
        for (const row of packRows(bands.get(key), minSpacing)) {
            const extent = Math.max(rowHeight, rowExtent(row));
            const y = cursorBelow + extent / 2;
            row.forEach(({ node, x }) => out.set(node.id, { x, y }));
            cursorBelow += extent;
        }
        cursorBelow += bandGap * 0.35;
    }
    if (bands.has('above')) {
        let cursorAbove = -(maxDepth + 1) * rowGap + 20;
        for (const row of packRows(bands.get('above'), minSpacing)) {
            const extent = Math.max(rowHeight, rowExtent(row));
            row.forEach(({ node, x }) => out.set(node.id, { x, y: cursorAbove - extent / 2 }));
            cursorAbove -= extent;
        }
    }
    return out;
}

function push(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

/**
 * Greedy interval packing: each item keeps its x, rows avoid overlap.
 * Spacing grows with node size so large hubs don't collide with neighbours.
 */
function packRows(items, spacing) {
    const rows = [];
    const ends = [];
    const widthOf = (item) => Math.max(spacing, nodeRadius(item.node) * 2 + 40);
    for (const item of [...items].sort((a, b) => a.x - b.x || a.node.id.localeCompare(b.node.id))) {
        const need = widthOf(item);
        let row = ends.findIndex(end => item.x - end >= need);
        if (row < 0) {
            row = rows.length;
            rows.push([]);
            ends.push(-Infinity);
        }
        rows[row].push(item);
        ends[row] = item.x;
    }
    return rows;
}
