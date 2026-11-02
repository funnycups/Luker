import express from 'express';
import { randomBytes } from 'node:crypto';
import { prepareS3Backend, prepareS3Unlock } from '../sync/backends/s3/setup.js';
import { assertSafeBackendId, readRegistry, createS3BackendEntry, patchS3BackendEntry, sanitizeRegistryForClient, setDeviceLabel, resolveDeviceLabel } from '../sync/state.js';
import { syncError } from '../sync/errors.js';
import { defaultUserStore, ownerFromUser, syncService } from '../sync/sync-service.js';
import { statusForSyncCode } from './sync-backends.js';

const invalid = () => { throw syncError('S3_SETTINGS_INVALID', 'S3_SETTINGS_INVALID'); };
function check(body, fields) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(field => !fields.includes(field))) invalid();
}
function inputOf(body, create) {
    check(body, ['label', 'categories', 's3', 'passphrase']);
    if (body.s3 !== undefined) check(body.s3, ['endpoint', 'region', 'bucket', 'prefix', 'forcePathStyle', 'stripIfMatchQuotes', 'accessKeyId', 'secretAccessKey']);
    if (create && (typeof body.label !== 'string' || !Array.isArray(body.categories) || !body.categories.length || !body.s3)) invalid();
    return { ...body.s3, ...Object.fromEntries(['label', 'categories', 'passphrase'].filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]])) };
}

export function createS3Router({ userStore = defaultUserStore, network } = {}) {
    const router = express.Router();
    function ownerOf(request, response) {
        if (!request.user?.profile?.handle || !request.user?.directories?.root) {
            response.status(401).json({ error: 'Auth required' }); return null;
        }
        const owner = ownerFromUser(request.user, userStore); syncService.rememberOwner(owner); return owner;
    }
    function sendError(response, error) {
        const code = typeof error?.code === 'string' ? error.code : 'SYNC_FAILED';
        // All public failures use a code, never arbitrary provider/error payloads.
        response.status(statusForSyncCode(code)).json({ ok: false, code, error: code });
    }
    async function previousOf(owner, backendId) {
        assertSafeBackendId(backendId);
        const entry = (await readRegistry({ userRoot: owner.userRoot })).backends[backendId];
        if (!entry) throw syncError('UNKNOWN_BACKEND', 'UNKNOWN_BACKEND');
        if (entry.kind !== 's3') throw syncError('BACKEND_KIND_MISMATCH', 'BACKEND_KIND_MISMATCH');
        return { ...entry, backendId };
    }
    async function sendBackend(response, owner, backendId, status = 200) {
        const registry = await readRegistry({ userRoot: owner.userRoot });
        response.status(status).json({ backendId, backend: sanitizeRegistryForClient(registry).backends[backendId] });
    }
    function trigger(owner, id) {
        syncService.trigger(owner, id, 'manual').catch(() => {});
    }
    router.post('/backends/s3', express.json(), async (request, response) => {
        const owner = ownerOf(request, response); if (!owner) return;
        try {
            const input = inputOf(request.body, true);
            const prepared = await prepareS3Backend({ owner, input, network });
            const backendId = `s3-${randomBytes(16).toString('hex')}`;
            await createS3BackendEntry({ userRoot: owner.userRoot, backendId, label: input.label, categories: input.categories, s3: prepared.s3 });
            await sendBackend(response, owner, backendId, 201);
            trigger(owner, backendId);
        } catch (error) { sendError(response, error); }
    });
    router.post('/backends/:id/s3', express.json(), async (request, response) => {
        const owner = ownerOf(request, response); if (!owner) return;
        try {
            const input = inputOf(request.body, false);
            const backendId = String(request.params.id);
            const identity = syncService.captureBackendIdentity(owner, backendId);
            const previous = await previousOf(owner, backendId);
            const prepared = await prepareS3Backend({ owner, input, previous, network });
            identity.assertAlive();
            await syncService.withBackendMaintenance(owner, backendId, (_registry, commit) => patchS3BackendEntry({
                userRoot: owner.userRoot, backendId, expectedS3: prepared.expectedS3, s3Patch: prepared.s3,
                label: input.label, categories: input.categories, assertAlive: () => { identity.assertAlive(); commit.assertAlive(); },
            }));
            await sendBackend(response, owner, backendId);
            trigger(owner, backendId);
        } catch (error) { sendError(response, error); }
    });
    router.post('/backends/:id/unlock', express.json(), async (request, response) => {
        const owner = ownerOf(request, response); if (!owner) return;
        try {
            check(request.body, ['passphrase']);
            const backendId = String(request.params.id);
            const identity = syncService.captureBackendIdentity(owner, backendId);
            const previous = await previousOf(owner, backendId);
            const prepared = await prepareS3Unlock({ owner, previous, passphrase: request.body.passphrase, network });
            identity.assertAlive();
            await syncService.withBackendMaintenance(owner, backendId, (_registry, commit) => patchS3BackendEntry({
                userRoot: owner.userRoot, backendId, expectedS3: prepared.expectedS3, s3Patch: { derivedKey: prepared.derivedKey },
                assertAlive: () => { identity.assertAlive(); commit.assertAlive(); },
            }));
            await sendBackend(response, owner, backendId);
            trigger(owner, backendId);
        } catch (error) { sendError(response, error); }
    });
    router.post('/device', express.json(), async (request, response) => {
        const owner = ownerOf(request, response); if (!owner) return;
        try {
            check(request.body, ['label']);
            const label = await setDeviceLabel({ userRoot: owner.userRoot, label: request.body.label });
            response.json({ device: { label, resolvedLabel: resolveDeviceLabel(await readRegistry({ userRoot: owner.userRoot }), owner) } });
        } catch (error) { sendError(response, error); }
    });
    return router;
}
