// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Pure helpers rendering the extraction request from its template.
 *
 * The extraction prompt is one editable template carrying the fixed text and
 * two markers. `{{nodes}}` receives the active types' rules, `{{edges}}`
 * receives the edge rules; each block carries its own program-generated
 * heading, so a block with no content leaves nothing behind, heading included.
 * The template's fixed text holds the role statement, the scope isolation, the
 * output contract, the prohibition list and the thought block.
 *
 * Lives outside main.js so unit tests can import without dragging the whole
 * SillyTavern script.js / lib.js runtime in.
 */

import { i18n, i18nFormat } from './i18n.js';
import { requireStoredPrompt } from '../../lib/prompt-values.js';

export const NODES_BLOCK_MARKER = '{{nodes}}';
export const EDGES_BLOCK_MARKER = '{{edges}}';

/**
 * Render the extraction template, replacing each marker it carries with its
 * block. Splitting on the marker rather than matching a regular expression
 * keeps metacharacters in the template text literal. An empty block replaces
 * its marker with nothing, and a marker the template does not carry inserts
 * nothing.
 *
 * @param {string} template
 * @param {{ nodesBlock?: string, edgesBlock?: string }} [blocks]
 * @returns {string}
 */
export function renderExtractionTemplate(template, { nodesBlock = '', edgesBlock = '' } = {}) {
    return String(template ?? '')
        .split(NODES_BLOCK_MARKER).join(String(nodesBlock ?? ''))
        .split(EDGES_BLOCK_MARKER).join(String(edgesBlock ?? ''));
}

/**
 * Read a stored prompt at the execution boundary.
 */
export function readStoredPrompt(value, label) {
    return requireStoredPrompt(value, i18nFormat('${0}: Fill in the prompt or reset it to the default.', i18n(label)));
}

/**
 * Resolve stored template settings into the template text and the edge rules.
 *
 * @param {{ extractTemplate?: string, extractEdgeRules?: string }} settings
 * @returns {{ template: string, edgeRules: string }}
 */
export function resolveExtractionTemplate(settings = {}) {
    return {
        template: readStoredPrompt(settings?.extractTemplate, 'Extraction Template'),
        edgeRules: readStoredPrompt(settings?.extractEdgeRules, 'Edge Rules'),
    };
}
