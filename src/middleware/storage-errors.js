import { StorageReadOnlyError, ConflictError, NotFoundError } from '../storage/errors.js';

/**
 * Express error-handling middleware that maps storage-layer typed errors to
 * clean HTTP responses. Anything it doesn't recognize is passed through to
 * the next error handler (Express's default 500, in production).
 *
 * Mount AFTER every route/router and BEFORE the catch-all 404 handler so
 * thrown/forwarded storage errors land here instead of the generic 500
 * response.
 *
 * Mapping:
 *   - StorageReadOnlyError → 503 { error: 'storage_read_only', message }
 *     Surfaced while a migration holds the source engine frozen. 503 is the
 *     correct "temporary, try again" signal; the error message names the
 *     migration so the client UI / operator can act on it.
 *   - ConflictError       → 409 { error: <code>, details }
 *     Code travels straight through (e.g. 'integrity_mismatch'); details may
 *     be undefined for codes that don't need extra fields.
 *   - NotFoundError       → 404 (no body — keep response minimal)
 *
 * @param {Error} err
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function storageErrorHandler(err, _req, res, next) {
    if (res.headersSent) return next(err);
    if (err instanceof StorageReadOnlyError) {
        return res.status(503).send({ error: 'storage_read_only', message: err.message });
    }
    if (err instanceof ConflictError) {
        return res.status(409).send({ error: err.code, details: err.details });
    }
    if (err instanceof NotFoundError) {
        return res.sendStatus(404);
    }
    return next(err);
}
