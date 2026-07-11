// SPDX-License-Identifier: AGPL-3.0-or-later
import fetch from 'node-fetch';
import { readSecret } from '../endpoints/secrets.js';
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
            read(key, { secretId } = {}) {
                return readSecret(request.user?.directories, key, secretId);
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
            fail(err) { failInspection(request, err); },
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
