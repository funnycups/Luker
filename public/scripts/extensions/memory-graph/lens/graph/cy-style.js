// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cytoscape stylesheet built from the active CSS theme tokens, so the canvas
// follows the light/dark switch without hard-coded colors.

import { typeVisual } from '../model.js';

const TONES = ['event', 'character', 'location', 'thread', 'rule', 'extra1', 'extra2', 'extra3', 'extra4'];

export function readTokens(root) {
    const css = getComputedStyle(root);
    const get = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const tones = {};
    for (const tone of TONES) tones[tone] = get(`--ml-tone-${tone}`, '#8b93a7');
    return {
        tones,
        canvas: get('--ml-canvas', '#0b0d12'),
        text: get('--ml-text', '#e7e9ee'),
        textMuted: get('--ml-text-muted', '#9aa1b2'),
        edge: get('--ml-edge', 'rgba(150,160,180,0.35)'),
        edgeBond: get('--ml-edge-bond', '#5fb7a5'),
        edgeConflict: get('--ml-edge-conflict', '#e0736a'),
        edgeHierarchy: get('--ml-edge-hierarchy', 'rgba(150,160,180,0.25)'),
        accent: get('--ml-accent', '#7c8cff'),
        recalled: get('--ml-recalled', '#f2b84b'),
        pinned: get('--ml-pinned', '#9a8cff'),
        font: get('--ml-font', 'system-ui, sans-serif'),
    };
}

export function buildStylesheet(tokens, { compact = false } = {}) {
    const fontSize = compact ? 11 : 12;
    const rules = [
        {
            selector: 'node',
            style: {
                width: 'data(size)',
                height: 'data(size)',
                shape: 'data(shape)',
                'background-color': 'data(color)',
                'background-opacity': 0.92,
                'border-width': 1.5,
                'border-color': tokens.canvas,
                label: 'data(label)',
                color: tokens.text,
                'font-family': tokens.font,
                'font-size': fontSize,
                'font-weight': 500,
                'text-valign': 'bottom',
                'text-halign': 'center',
                'text-margin-y': 6,
                'text-wrap': 'ellipsis',
                'text-max-width': compact ? 84 : 120,
                'text-background-color': tokens.canvas,
                'text-background-opacity': 0.72,
                'text-background-padding': 2,
                'text-background-shape': 'roundrectangle',
                'min-zoomed-font-size': 6,
                'transition-property': 'opacity, border-width, border-color, underlay-opacity',
                'transition-duration': 160,
                'underlay-opacity': 0,
                'underlay-shape': 'ellipse',
            },
        },
        {
            selector: 'node[kind = "event"]',
            style: {
                'font-size': fontSize - 1,
                color: tokens.textMuted,
                'text-max-width': compact ? 72 : 96,
                'corner-radius': 4,
            },
        },
        { selector: 'node[?rollup]', style: { 'border-width': 2, 'border-color': tokens.tones.event, 'background-opacity': 0.35, color: tokens.text } },
        { selector: 'node[?archived]', style: { opacity: 0.38, 'border-style': 'dashed' } },
        {
            selector: 'node[ctx = "recalled"]',
            style: { 'underlay-color': tokens.recalled, 'underlay-opacity': 0.38, 'underlay-padding': 7, 'border-color': tokens.recalled, 'border-width': 2.5 },
        },
        {
            selector: 'node[ctx = "pinned"]',
            style: { 'underlay-color': tokens.pinned, 'underlay-opacity': 0.26, 'underlay-padding': 5, 'border-color': tokens.pinned, 'border-width': 2 },
        },
        {
            selector: 'edge',
            style: {
                width: 1.2,
                'line-color': tokens.edge,
                'curve-style': 'bezier',
                'target-arrow-shape': 'none',
                'arrow-scale': 0.7,
                opacity: 0.9,
                label: '',
                'font-family': tokens.font,
                'font-size': 10,
                'min-zoomed-font-size': 8,
                color: tokens.textMuted,
                'text-background-color': tokens.canvas,
                'text-background-opacity': 0.85,
                'text-background-padding': 2,
                'text-rotation': 'autorotate',
                'transition-property': 'opacity, line-color, width',
                'transition-duration': 160,
            },
        },
        { selector: 'edge[?directed]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': tokens.edge } },
        { selector: 'edge[category = "bond"]', style: { 'line-color': tokens.edgeBond, 'target-arrow-color': tokens.edgeBond, width: 1.8 } },
        { selector: 'edge[category = "conflict"]', style: { 'line-color': tokens.edgeConflict, 'target-arrow-color': tokens.edgeConflict, width: 1.8, 'line-style': 'dashed', 'line-dash-pattern': [6, 4] } },
        { selector: 'edge[category = "hierarchy"]', style: { 'line-color': tokens.edgeHierarchy, width: 1, 'line-style': 'dotted', 'target-arrow-shape': 'none', 'curve-style': 'straight' } },
        { selector: 'edge.ml-faint', style: { opacity: 0.22, width: 1, 'target-arrow-shape': 'none', 'curve-style': 'straight' } },
        // Interaction states (classes toggled by the view).
        { selector: '.ml-dim', style: { opacity: 0.12, 'text-opacity': 0 } },
        { selector: 'edge.ml-dim', style: { opacity: 0.05 } },
        { selector: 'node.ml-hover', style: { 'border-color': tokens.text, 'border-width': 2 } },
        { selector: 'edge.ml-near', style: { opacity: 1, width: 2.2, label: 'data(label)', 'z-index': 9 } },
        { selector: 'node.ml-near', style: { opacity: 1, 'text-opacity': 1, color: tokens.text } },
        {
            selector: 'node:selected',
            style: {
                'border-color': tokens.accent,
                'border-width': 3,
                'underlay-color': tokens.accent,
                'underlay-opacity': 0.3,
                'underlay-padding': 9,
                color: tokens.text,
                'z-index': 10,
            },
        },
        { selector: 'node.ml-match', style: { 'border-color': tokens.accent, 'border-width': 2.5 } },
        { selector: 'node:active, edge:active', style: { 'overlay-opacity': 0 } },
    ];
    return rules;
}

export function colorForNode(tokens, node) {
    return tokens.tones[typeVisual(node.type).tone] || tokens.tones.extra1;
}
