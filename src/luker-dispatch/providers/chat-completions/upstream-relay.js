// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { dispatchLog as console } from '../../logging.js';
import { pipeResponseBodyToEmit } from '../../response-stream.js';
import { getConfigValue } from '../../../util.js';

/**
 * Resolve Anthropic prompt-caching settings from request body overrides with
 * config.yaml defaults.
 * @param {object} body
 * @returns {{ cacheTTL: '1h' | '5m', enableSystemPromptCache: boolean, cachingAtDepth: number }}
 */
export function resolveClaudeCacheConfig(body) {
    const sysFromBody = body?.claude_enable_system_prompt_cache;
    const depthFromBody = body?.claude_caching_at_depth;
    const ttlFromBody = body?.claude_extended_ttl;

    const enableSystemPromptCache = typeof sysFromBody === 'boolean'
        ? sysFromBody
        : getConfigValue('claude.enableSystemPromptCache', false, 'boolean');

    const useExtendedTtl = typeof ttlFromBody === 'boolean'
        ? ttlFromBody
        : getConfigValue('claude.extendedTTL', false, 'boolean');
    const cacheTTL = useExtendedTtl ? '1h' : '5m';

    const depthRaw = typeof depthFromBody === 'number'
        ? depthFromBody
        : getConfigValue('claude.cachingAtDepth', -1, 'number');
    const cachingAtDepth = Number.isInteger(depthRaw) && depthRaw >= 0 ? depthRaw : -1;

    return { cacheTTL, enableSystemPromptCache, cachingAtDepth };
}

/**
 * Emit a structured, non-retryable HTTP 400 capability-conflict response and
 * record it on the request inspector.
 * @param {object} ctx DispatchContext
 * @param {Error & { conflictCode?: string }} conflict
 * @param {string} label
 */
export function emitCapabilityConflict(ctx, conflict, label) {
    console.warn(`${label} request capability conflict: ${conflict.message}`);
    const errBody = JSON.stringify({
        error: {
            type: 'capability_conflict',
            code: conflict.conflictCode,
            message: conflict.message,
            non_retryable: true,
        },
    });
    ctx.emit.head({ status: 400, headers: { 'content-type': 'application/json' } });
    ctx.emit.chunk(new TextEncoder().encode(errBody));
    ctx.emit.end();
    ctx.inspection.fail(conflict, 400);
}

/**
 * Relay an upstream fetch response through the dispatch event bus, preserving
 * native upstream wire bytes and handling non-2xx error bodies uniformly for
 * both streaming and non-streaming requests.
 * @param {object} ctx DispatchContext
 * @param {import('node-fetch').Response} resp
 * @param {{
 *   label: string,
 *   stream?: boolean,
 *   completeInspection?: boolean,
 *   logResponse?: ((parsed: any) => void) | null,
 * }} options
 * @returns {Promise<void>}
 */
export async function relayUpstreamResponse(ctx, resp, {
    label,
    stream = false,
    completeInspection = false,
    logResponse = null,
}) {
    // Synchronize the effective upstream streaming mode before emitting head so
    // runner content-type normalization, job accumulation, and Request Inspector
    // match what was actually sent upstream (e.g. providers that force stream=false).
    ctx.setStreamMode?.(Boolean(stream));

    // Architectural contract: every dispatch emits a single head frame
    // immediately after the upstream fetch resolves, regardless of status, so
    // WS delivery releases the client's headPromise.
    ctx.emit.head({ status: resp.status, headers: resp.headers });

    if (!resp.ok) {
        let errText = '';
        try { errText = await resp.text(); } catch { /* body already consumed */ }
        console.warn(`${label} returned error: ${resp.status} ${resp.statusText} ${errText}`);
        const msg = `${label} upstream ${resp.status}: ${errText}`;
        ctx.inspection.fail(new Error(msg), resp?.status ?? 502);
        if (errText) {
            ctx.emit.chunk(new TextEncoder().encode(errText));
        }
        ctx.emit.end();
        return;
    }

    if (stream) {
        await pipeResponseBodyToEmit(resp, ctx);
        return;
    }

    if (completeInspection) {
        const rawText = await resp.text();
        ctx.emit.chunk(new TextEncoder().encode(rawText));
        ctx.emit.end();
        try {
            const parsed = JSON.parse(rawText);
            if (typeof logResponse === 'function') {
                logResponse(parsed);
            } else {
                console.debug(`${label} response:`, parsed);
            }
            ctx.inspection.complete(parsed, parsed);
        } catch {
            // Leave entry running so runner's strict JSON parse-error path
            // records ProtocolParseError + rawDiagnostic.
        }
        return;
    }

    const buf = await resp.arrayBuffer();
    try {
        const parsed = JSON.parse(new TextDecoder().decode(buf));
        if (typeof logResponse === 'function') {
            logResponse(parsed);
        } else {
            console.debug(`${label} response:`, parsed);
        }
    } catch { /* non-JSON body — skip debug log */ }
    ctx.emit.chunk(new Uint8Array(buf));
    ctx.emit.end();
}

/**
 * Standard catch-block handler for chat-completions providers: marks aborted
 * requests as `aborted` instead of `error` in the Request Inspector before
 * forwarding the error event.
 * @param {object} ctx DispatchContext
 * @param {unknown} err
 * @param {string} label
 */
export function handleProviderDispatchError(ctx, err, label) {
    const isAbort = err?.name === 'AbortError' || Boolean(ctx.signal?.aborted);
    if (isAbort) {
        try { ctx.inspection.abort?.(); } catch { /* inspection best-effort */ }
    } else {
        try { ctx.inspection.fail(err, 500); } catch { /* inspection best-effort */ }
        console.error(`Error communicating with ${label}:`, err);
    }
    ctx.emit.error(err);
}
