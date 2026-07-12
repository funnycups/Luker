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

export function createDispatchContext({ request, task, abortController, onEmit, onCloseHandlers }) {
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
        // Explicit abort trigger. Runner owns the AbortController; dispatch
        // code that needs to fire abort as a side effect (comfy /interrupt
        // → stop local polling) goes through this instead of receiving the
        // controller directly. Kept a no-op-safe method call so tests that
        // stub ctx don't need to reproduce the whole abort lifecycle.
        abort() {
            try { abortController.abort(); } catch { /* ignore */ }
        },
        fetch,

        // Register a callback that fires when the underlying HTTP request
        // socket closes (client disconnected — tab close, network drop,
        // explicit browser cancel, or an abort routed through the runner).
        //
        // The runner does NOT default-bind close→abort so that the
        // generation-job survives disconnect and can be reclaimed by
        // GET /api/generation/active. Dispatches that hold external
        // resources whose only stop channel is the client connection
        // (ComfyUI's /interrupt, etc.) opt in here to preserve legacy
        // shutdown semantics.
        //
        // Returns a disposer so the dispatch can drop the handler after a
        // successful settle (avoids firing side effects on a normal close
        // that races the response tail).
        onRequestClose(callback) {
            if (typeof callback !== 'function') return () => {};
            if (!onCloseHandlers) return () => {};
            onCloseHandlers.add(callback);
            return () => { onCloseHandlers.delete(callback); };
        },

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
            // Runner-only escape hatch: append a chunk AFTER the dispatch has
            // already emitted a terminal `end`/`error`. Legacy behavior
            // appended a `data: {"luker":{...}}\n\n` trailer frame to the tail
            // of every streaming chat/text response so the frontend
            // (openai.js:4316 / kai-settings.js / nai-settings.js /
            // textgen-settings.js / script.js) could learn the server-side
            // `generation_id` + `persisted` flag from the stream itself.
            //
            // Refactor's `safeEmit` locks the terminal state on the first
            // `end`/`error` and drops every subsequent emit — including the
            // runner's trailer. This bypass exists so the runner can still
            // append the trailer without introducing an ordering coupling
            // (dispatch must emit chunks first, then runner appends trailer,
            // then real terminal fires). Bypass is NOT exposed to dispatches
            // and does NOT reopen the terminal flag: the next `emit.end` /
            // `emit.error` after a trailer is still a no-op.
            trailer(bytes) {
                try { onEmit({ kind: 'chunk', data: bytes }); }
                catch (error) { console.warn('[Dispatch] onEmit threw (trailer)', error); }
            },
        },
    };
}
