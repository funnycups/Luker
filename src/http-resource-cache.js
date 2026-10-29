import crypto from 'node:crypto';

/**
 * Builds the private, revalidated representation shared by account-scoped GET resources.
 *
 * The validator is derived from the current bytes and the account. It is a
 * representation identifier, not a stored revision.
 */
export function createPrivateRepresentation({ account, resource, text, contentType = 'application/json; charset=utf-8' }) {
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify([String(account), String(resource), String(text)]))
        .digest('hex');
    return {
        account: String(account),
        resource: String(resource),
        text: String(text),
        contentType,
        etag: `W/"${digest}"`,
    };
}

/**
 * Sends a representation only to its authenticated account and lets Express
 * answer matching conditional requests with 304.
 */
export function sendPrivateRepresentation(request, response, representation) {
    const authenticated = String(request.user?.profile?.handle || '');
    const requested = String(request.query?.account || '');
    if (!authenticated || requested !== authenticated || representation.account !== authenticated) {
        return sendResourceReadError(response, {
            code: 'forbidden',
            resource: representation.resource,
            detail: 'Resource account does not match the authenticated account.',
            status: 403,
        });
    }

    // no-cache requires validation before each reuse; max-age=1 is the
    // positive freshness bound Chromium needs in order to retain the entry.
    response.set('Cache-Control', 'private, no-cache, max-age=1');
    response.set('Content-Type', representation.contentType);
    response.set('ETag', representation.etag);
    return response.send(representation.text);
}

/**
 * Serializes a JSON value as an account-scoped private representation.
 */
export function sendJsonResource(request, response, { resource, value }) {
    const representation = createPrivateRepresentation({
        account: request.user?.profile?.handle || '',
        resource,
        text: JSON.stringify(value),
        contentType: 'application/json; charset=utf-8',
    });
    return sendPrivateRepresentation(request, response, representation);
}

/**
 * Sends a non-cacheable resource failure with a stable machine-readable code.
 */
export function sendResourceReadError(response, { code, resource, detail, status = 400 }) {
    response.set('Cache-Control', 'no-store');
    return response.status(status).send({
        code,
        resource,
        ...(detail ? { detail } : {}),
    });
}
