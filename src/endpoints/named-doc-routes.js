import { getNamedDocRepo } from '../storage/index.js';
import { sendJsonResource, sendResourceReadError } from '../http-resource-cache.js';

/**
 * Adds the common directory/body reads for a named-document collection.
 */
export function registerNamedDocReadRoutes(router, bucket) {
    router.get('/list', async (request, response) => {
        try {
            const entries = await getNamedDocRepo().list(request.user.profile.handle, bucket);
            const names = entries
                .map(entry => entry?.key?.name)
                .filter(name => typeof name === 'string' && name.length > 0)
                .sort((a, b) => a.localeCompare(b));
            return sendJsonResource(request, response, {
                resource: `${bucket}:list`,
                value: { names },
            });
        } catch (error) {
            console.error(`Error reading ${bucket} directory:`, error);
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource: `${bucket}:list`,
                detail: 'Failed to read the collection directory.',
                status: 500,
            });
        }
    });

    router.get('/get', async (request, response) => {
        const name = String(request.query?.name || '');
        if (!name) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource: bucket,
                detail: 'Expected a document name.',
                status: 400,
            });
        }
        try {
            const handle = request.user.profile.handle;
            const entries = await getNamedDocRepo().list(handle, bucket);
            if (!entries.some(entry => entry?.key?.name === name)) {
                return sendResourceReadError(response, {
                    code: 'not_found',
                    resource: `${bucket}:${name}`,
                    detail: 'Document does not exist.',
                    status: 404,
                });
            }
            const doc = await getNamedDocRepo().get(handle, bucket, name);
            if (doc == null) {
                return sendResourceReadError(response, {
                    code: 'invalid_resource',
                    resource: `${bucket}:${name}`,
                    detail: 'Document is not valid JSON.',
                    status: 422,
                });
            }
            return sendJsonResource(request, response, {
                resource: `${bucket}:${name}`,
                value: doc,
            });
        } catch (error) {
            console.error(`Error reading ${bucket} document:`, error);
            return sendResourceReadError(response, {
                code: 'read_failed',
                resource: `${bucket}:${name}`,
                detail: 'Failed to read the document.',
                status: 500,
            });
        }
    });
}
