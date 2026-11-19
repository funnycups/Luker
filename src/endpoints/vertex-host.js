// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

/**
 * Vertex AI API hostnames by location.
 *
 * https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations
 *
 * `global` and an empty location use the un-prefixed host. `us` and `eu` are
 * multi-regions: they have dedicated `aiplatform.{location}.rep.googleapis.com`
 * hosts, and the `{location}-aiplatform.googleapis.com` template only applies
 * to single regions.
 *
 * @param {string} region Vertex AI location
 * @returns {string} Host without a trailing slash
 */
export function getVertexApiHost(region) {
    const trimmed = String(region || '').trim();

    if (!trimmed || trimmed === 'global') {
        return 'https://aiplatform.googleapis.com';
    }

    if (trimmed === 'us' || trimmed === 'eu') {
        return `https://aiplatform.${trimmed}.rep.googleapis.com`;
    }

    return `https://${trimmed}-aiplatform.googleapis.com`;
}
