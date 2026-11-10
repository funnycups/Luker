// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Shared request overrides for every chat-completion provider. The
// Additional Parameters dialog exposes include-body / exclude-body /
// include-headers for all sources; each dispatch calls
// applyAdditionalParameters immediately before the upstream request so the
// overrides behave the same regardless of the provider's wire format.

import { excludeKeysByYaml, mergeNestedObjectWithYaml, mergeObjectWithYaml } from '../../../util.js';

/**
 * Merge the user's additional body parameters and headers into an upstream
 * request. Include runs first, exclude second (exclude wins), headers last
 * so an override can replace the provider auth header.
 *
 * @param {object} requestBody Request body about to be serialized.
 * @param {object} headers Request headers about to be sent.
 * @param {object} body Frontend request body carrying the custom_* fields.
 * @param {{ nestedBodyKey?: string }} [options] Gemini nests generation
 *   parameters under generationConfig; merging that one key keeps the
 *   generated sampling and token fields when the user adds a nested
 *   parameter.
 * @returns {void}
 */
export function applyAdditionalParameters(requestBody, headers, body, { nestedBodyKey = '' } = {}) {
    if (nestedBodyKey) {
        mergeNestedObjectWithYaml(requestBody, body?.custom_include_body, nestedBodyKey);
    } else {
        mergeObjectWithYaml(requestBody, body?.custom_include_body);
    }
    excludeKeysByYaml(requestBody, body?.custom_exclude_body);
    mergeObjectWithYaml(headers, body?.custom_include_headers);
}
