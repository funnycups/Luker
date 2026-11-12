import express from 'express';

import {
    InvalidArgumentError,
    PatchMissingParentError,
    PatchTestFailedError,
    StorageReadOnlyError,
    UnsupportedPatchOpError,
} from '../storage/errors.js';
import { getNamedDocRepo } from '../storage/index.js';
import { assertSafeRepoName, assertSafeRepoNameShape } from '../storage/name-validation.js';
import { sendJsonResource, sendResourceReadError } from '../http-resource-cache.js';

const GLOBAL_STATE_BUCKET = 'globalStates';

export const router = express.Router();

export function normalizeGlobalStateNamespace(raw, { requireLengthBound = false } = {}) {
    if (typeof raw !== 'string') {
        return '';
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return '';
    }
    if (
        trimmed.includes('/')
        || trimmed.includes('\\')
        || trimmed.includes('..')
        || trimmed.includes('\0')
        || trimmed.startsWith('.')
    ) {
        return '';
    }
    try {
        const validate = requireLengthBound ? assertSafeRepoName : assertSafeRepoNameShape;
        return validate(trimmed, { field: 'namespace' });
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return '';
        }
        throw err;
    }
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapStatePatchError(error, response) {
    if (error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
        return response.status(409).send({
            error: 'Global state patch conflict.',
            code: error.code,
        });
    }
    if (error instanceof UnsupportedPatchOpError || error instanceof InvalidArgumentError) {
        return response.status(400).send({
            error: error.message || 'Invalid global state patch payload.',
        });
    }
    return null;
}

router.get('/get', async function (request, response) {
    const namespace = normalizeGlobalStateNamespace(request.query?.namespace);
    const resource = `global-state:${namespace}`;
    if (!namespace) {
        return sendResourceReadError(response, {
            code: 'invalid_args',
            resource,
            detail: 'Expected a state namespace.',
            status: 400,
        });
    }
    try {
        const data = await getNamedDocRepo().get(request.user.profile.handle, GLOBAL_STATE_BUCKET, namespace);
        return sendJsonResource(request, response, {
            resource,
            value: { ok: true, data: data ?? null },
        });
    } catch (error) {
        console.error('Error reading global state:', error);
        return sendResourceReadError(response, {
            code: 'read_failed',
            resource,
            detail: 'Failed to read global state.',
            status: 500,
        });
    }
});

router.post('/get', async function (request, response) {
    try {
        const namespace = normalizeGlobalStateNamespace(request.body?.namespace);
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const data = await getNamedDocRepo().get(request.user.profile.handle, GLOBAL_STATE_BUCKET, namespace);
        return response.send({ ok: true, data: data ?? null });
    } catch (error) {
        console.error('Error reading global state:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/get-batch', async function (request, response) {
    try {
        const rawNamespaces = request.body?.namespaces;
        if (!Array.isArray(rawNamespaces) || rawNamespaces.length === 0) {
            return response.status(400).send({ error: 'Expected body.namespaces to be a non-empty array of strings.' });
        }

        const seen = new Set();
        const namespaces = [];
        for (const raw of rawNamespaces) {
            const ns = normalizeGlobalStateNamespace(raw);
            if (!ns) {
                return response.status(400).send({ error: 'Invalid namespace in body.namespaces.' });
            }
            if (!seen.has(ns)) {
                seen.add(ns);
                namespaces.push(ns);
            }
        }

        const handle = request.user.profile.handle;
        const repo = getNamedDocRepo();
        const data = {};
        for (const ns of namespaces) {
            const doc = await repo.get(handle, GLOBAL_STATE_BUCKET, ns);
            data[ns] = doc ?? null;
        }
        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading global state batch:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/set', async function (request, response, next) {
    try {
        const namespace = normalizeGlobalStateNamespace(request.body?.namespace, { requireLengthBound: true });
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        const data = request.body?.data;
        if (!isPlainObject(data)) {
            return response.status(400).send({ error: 'Expected body.data object.' });
        }

        await getNamedDocRepo().save(request.user.profile.handle, GLOBAL_STATE_BUCKET, namespace, data);
        return response.send({ ok: true });
    } catch (error) {
        if (error instanceof StorageReadOnlyError) {
            return next(error);
        }
        if (error instanceof InvalidArgumentError) {
            return response.status(400).send({ error: error.message });
        }
        console.error('Error writing global state:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/patch', async function (request, response, next) {
    try {
        const namespace = normalizeGlobalStateNamespace(request.body?.namespace, { requireLengthBound: true });
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        let operations;
        if (request.body?.operations !== undefined) {
            if (!Array.isArray(request.body.operations) || request.body.operations.length === 0) {
                return response.status(400).send({ error: 'Expected body.operations to be a non-empty array.' });
            }
            operations = request.body.operations;
        } else if (isPlainObject(request.body?.operation)) {
            operations = [request.body.operation];
        } else {
            return response.status(400).send({ error: 'No state patch operations found. Expected body.operations or body.operation.' });
        }

        const result = await getNamedDocRepo().patch(
            request.user.profile.handle,
            GLOBAL_STATE_BUCKET,
            namespace,
            operations,
        );
        return response.send({
            ok: true,
            applied: result.applied,
            created: result.created,
        });
    } catch (error) {
        if (error instanceof StorageReadOnlyError) {
            return next(error);
        }
        const mapped = mapStatePatchError(error, response);
        if (mapped) {
            return mapped;
        }
        console.error('Error patching global state:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/delete', async function (request, response, next) {
    try {
        const namespace = normalizeGlobalStateNamespace(request.body?.namespace);
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const deleted = await getNamedDocRepo().delete(request.user.profile.handle, GLOBAL_STATE_BUCKET, namespace);
        return response.send({ ok: true, deleted });
    } catch (error) {
        if (error instanceof StorageReadOnlyError) {
            return next(error);
        }
        console.error('Error deleting global state:', error);
        return response.status(500).send({ error: true });
    }
});
