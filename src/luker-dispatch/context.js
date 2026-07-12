// SPDX-License-Identifier: AGPL-3.0-or-later
import fetch from 'node-fetch';
import { readSecret, getRequestedSecretId } from '../endpoints/secrets.js';
import {
    createGenerationJob,
    appendGenerationEvent,
    getJobFromRequest,
} from '../endpoints/backends/luker-generation.js';
import {
    startInspection,
    attachInspectionEndpoint,
    completeInspection,
    completeInspectionFromStream,
    failInspection,
    startImageInspection,
    completeImageInspection,
    failImageInspection,
    abortInspection,
} from '../request-inspector.js';

export function createDispatchContext({ request, task, abortController, onEmit }) {
    let terminal = false;

    function safeEmit(event) {
        if (terminal) return;
        if (event.kind === 'end' || event.kind === 'error') {
            terminal = true;
        }
        try { onEmit(event); }
        catch (error) { console.warn('[Dispatch] onEmit threw', error); }
    }

    return {
        body: request.body,
        user: {
            handle: request.user?.profile?.handle,
            directories: request.user?.directories,
            profile: request.user?.profile,
        },
        signal: abortController.signal,
        fetch,

        secrets: {
            // Mirror legacy readProviderSecret(request, key) semantics:
            //   - if body.secret_id is set AND resolves to a stored secret,
            //     use it (connection profile / preset picked a specific
            //     credential slot)
            //   - otherwise fall back to the active secret for the key
            // Callers passing an explicit `secretId` opt into a raw lookup
            // (no fallback to active), matching legacy
            // readSecret(dirs, key, id) callers (MINIMAX, POLLINATIONS,
            // WORKERS_AI in chat-completions.js).
            //
            // BEFORE this fix, ctx.secrets.read(KEY) called readSecret
            // without an id and always returned the active secret —
            // ignoring body.secret_id — so users who selected a non-active
            // connection profile got authenticated against the wrong key.
            read(key, opts) {
                const directories = request.user?.directories;
                if (opts && Object.prototype.hasOwnProperty.call(opts, 'secretId')) {
                    return readSecret(directories, key, opts.secretId);
                }
                const secretId = getRequestedSecretId(request);
                if (secretId) {
                    const requested = readSecret(directories, key, secretId);
                    if (requested) return requested;
                }
                return readSecret(directories, key);
            },
        },

        generation: {
            startJob({ persist_target } = {}) {
                const job = createGenerationJob(request, {
                    job_id: task.id,
                    persist_target: persist_target || null,
                });
                return job;
            },
            appendEvent(job, rawData) {
                appendGenerationEvent(job, rawData);
            },
            hasActiveKeepAliveJob() {
                return Boolean(getJobFromRequest(request));
            },
        },

        inspection: {
            start() { startInspection(request); },
            attach(url, apiKey, wirePayload) { attachInspectionEndpoint(request, url, apiKey, wirePayload); },
            complete(payload, rawApiResponse) { completeInspection(request, payload, rawApiResponse); },
            completeFromStream(events, accumulatedText) { completeInspectionFromStream(request, events, accumulatedText); },
            fail(err, httpStatus) {
                const msg = err && err.message ? err.message : String(err || '');
                failInspection(request, msg, httpStatus);
            },
            startImage(meta) { startImageInspection(request, meta); },
            completeImage(resultMeta) { completeImageInspection(request, resultMeta); },
            failImage(err, httpStatus) {
                const msg = err && err.message ? err.message : String(err || '');
                failImageInspection(request, msg, httpStatus);
            },
            abort() { abortInspection(request); },
        },

        emit: {
            head({ status, headers }) { safeEmit({ kind: 'head', data: { status, headers } }); },
            chunk(bytes) { safeEmit({ kind: 'chunk', data: bytes }); },
            end() { safeEmit({ kind: 'end', data: null }); },
            error(err) { safeEmit({ kind: 'error', data: { message: String(err?.message || err) } }); },
        },
    };
}
