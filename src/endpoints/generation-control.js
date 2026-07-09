import express from 'express';
import {
    getTaskByRequestId,
    failGenerationJob,
    getActiveGenerationJobsForRequest,
} from './backends/luker-generation.js';

/**
 * Router for out-of-band control over in-flight generation jobs. Mounted
 * at `/api/generation` behind the full auth stack.
 *
 *   - `POST /:request_id/abort`  cancel an in-flight generation. Called by
 *                                the ws-delivery fetch proxy when the caller
 *                                aborts an `AbortSignal`.
 *   - `GET  /active`             list jobs still generating for the current
 *                                chat (`avatar_url` + `file_name` in query
 *                                params). Called on page load to reattach
 *                                to any job that survived a reload.
 */
export const generationControlRouter = express.Router();

generationControlRouter.post('/:request_id/abort', (req, res) => {
    const requestId = String(req.params.request_id || '');
    if (!requestId) {
        return res.status(400).json({ error: 'missing_request_id' });
    }
    const ownerHandle = req.user?.profile?.handle || '';
    let job;
    try {
        job = getTaskByRequestId(requestId, ownerHandle);
    } catch (err) {
        return res.status(403).json({ error: 'forbidden' });
    }
    if (!job) {
        return res.status(404).json({ error: 'not_found' });
    }
    if (job.abortController) {
        try { job.abortController.abort('client abort'); } catch { /* already aborted */ }
    }
    failGenerationJob(job, 'aborted by client');
    return res.json({ aborted: true });
});

generationControlRouter.get('/active', (req, res) => {
    // persist_target shape: `{ avatar_url, file_name }`. Any other query
    // params are ignored by getPersistChatKey. When neither is present the
    // helper returns [] (no chat key = no jobs).
    const persistTarget = (req.query && typeof req.query === 'object') ? req.query : null;
    const jobs = getActiveGenerationJobsForRequest(req, persistTarget);
    return res.json({ jobs });
});
