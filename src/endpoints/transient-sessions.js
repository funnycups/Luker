// SPDX-License-Identifier: AGPL-3.0-or-later

import express from 'express';
import {
    assertTransientMediaRouteRead,
    closeTransientSessionForRequest,
    trackTransientOperation,
    TRANSIENT_SESSION_HEADER,
} from '../transient-sessions.js';

export const router = express.Router();

export function guardTransientMediaRead(request, response, next) {
    try {
        // Express already decoded this parameter once. The downstream file
        // route runs `decodeURIComponent(request.params[0])` without splitting
        // on `?`/`#`; authorize that exact resolved path.
        const session = assertTransientMediaRouteRead(request, request.params[0]);
        if (!session) return next();
        response.set('Cache-Control', 'no-store');
        const finished = new Promise(resolve => {
            const settle = () => {
                response.removeListener('finish', settle);
                response.removeListener('close', settle);
                resolve();
            };
            response.once('finish', settle);
            response.once('close', settle);
        });
        trackTransientOperation(session, finished, { abort: () => response.destroy() });
        return next();
    } catch (error) {
        console.error('Cannot read temporary media:', error);
        return response.status(error.status || 500).json({
            error: 'Failed to read the temporary image.',
            code: error.code || 'TRANSIENT_MEDIA_READ_FAILED',
            details: error.message,
        });
    }
}

router.post('/close', async (request, response) => {
    if (!request.get(TRANSIENT_SESSION_HEADER)) {
        return response.status(400).json({ error: 'A temporary media session header is required.' });
    }
    try {
        await closeTransientSessionForRequest(request);
        return response.json({ ok: true });
    } catch (error) {
        console.error('Cannot close temporary media session:', error);
        return response.status(error.status || 500).json({
            error: 'Failed to close the temporary media session.',
            code: error.code || 'TRANSIENT_CLEANUP_FAILED',
            details: error.message,
        });
    }
});
