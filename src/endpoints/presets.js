import express from 'express';
import sanitize from 'sanitize-filename';

import { NotFoundError, ConflictError, PatchTestFailedError, PatchMissingParentError, UnsupportedPatchOpError } from '../storage/errors.js';
import { applyJsonPatch } from '../storage/repositories/json-patch.js';
import { getPresetRepo } from '../storage/index.js';
import { PRESET_FOLDER_BY_API_ID } from '../storage/repositories/preset-repo.js';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';

export const router = express.Router();

function isValidApiId(apiId) {
    return Object.prototype.hasOwnProperty.call(PRESET_FOLDER_BY_API_ID, apiId);
}

function normalizePresetStateNamespace(namespace) {
    const raw = String(namespace || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    return raw.replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

function presetFolderForApiId(apiId, directories) {
    const dirKey = PRESET_FOLDER_BY_API_ID[apiId];
    if (!dirKey) return null;
    return directories[dirKey] ?? null;
}

function mapPatchError(error, response) {
    if (error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
        return response.status(409).send({
            error: 'Preset patch test conflict.',
            code: 'patch_test_failed',
            details: String(error?.message || ''),
        });
    }
    if (error instanceof UnsupportedPatchOpError) {
        return response.status(400).send({
            error: 'Invalid preset patch payload.',
            code: 'patch_payload_invalid',
            details: String(error?.message || ''),
        });
    }
    return null;
}

function mapStatePatchError(error, response) {
    if (error instanceof PatchTestFailedError || error instanceof PatchMissingParentError) {
        return response.status(409).send({ error: 'Preset state patch conflict.' });
    }
    if (error instanceof UnsupportedPatchOpError) {
        return response.status(400).send({ error: 'Invalid preset state patch payload.' });
    }
    return null;
}

router.post('/save', async function (request, response) {
    const name = sanitize(String(request.body?.name || ''));
    const apiId = request.body?.apiId;
    if (!request.body?.preset || !name) {
        return response.sendStatus(400);
    }
    if (!isValidApiId(apiId)) {
        return response.sendStatus(400);
    }

    try {
        const handle = request.user.profile.handle;
        await getPresetRepo().save(handle, apiId, name, request.body.preset);
        return response.send({ name });
    } catch (error) {
        console.error('Error saving preset:', error);
        return response.sendStatus(500);
    }
});

router.post('/state/get', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!isValidApiId(apiId) || !name) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const handle = request.user.profile.handle;
        const data = await getPresetRepo().getState(handle, apiId, name, namespace);
        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/get-batch', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        if (!isValidApiId(apiId) || !name) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }

        const namespaces = [...new Set((Array.isArray(request.body?.namespaces) ? request.body.namespaces : [])
            .map((ns) => normalizePresetStateNamespace(ns))
            .filter(Boolean))];
        if (!namespaces.length) {
            return response.status(400).send({ error: 'Expected body.namespaces array.' });
        }

        const handle = request.user.profile.handle;
        const repo = getPresetRepo();
        const data = {};
        for (const ns of namespaces) {
            data[ns] = await repo.getState(handle, apiId, name, ns);
        }

        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/patch', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!isValidApiId(apiId) || !name) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (request.body?.operation && typeof request.body.operation === 'object' ? [request.body.operation] : []);
        if (operations.length === 0) {
            return response.status(400).send({ error: 'No preset state patch operations found. Expected body.operations or body.operation.' });
        }

        const handle = request.user.profile.handle;
        const repo = getPresetRepo();
        const existing = await repo.getState(handle, apiId, name, namespace);
        const seed = existing ?? {};

        let next;
        try {
            next = applyJsonPatch(seed, operations);
        } catch (error) {
            const mapped = mapStatePatchError(error, response);
            if (mapped) {
                return mapped;
            }
            throw error;
        }

        await repo.setState(handle, apiId, name, namespace, next);
        return response.send({
            ok: true,
            applied: operations.length,
            created: existing == null,
        });
    } catch (error) {
        console.error('Error patching preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!isValidApiId(apiId) || !name) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }

        const handle = request.user.profile.handle;
        const deleted = await getPresetRepo().deleteState(handle, apiId, name, namespace);
        return response.send({ ok: true, deleted });
    } catch (error) {
        console.error('Error deleting preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete-all', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        if (!isValidApiId(apiId) || !name) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }

        const handle = request.user.profile.handle;
        const deleted = await getPresetRepo().deleteAllStates(handle, apiId, name);
        return response.send({ ok: true, deleted });
    } catch (error) {
        console.error('Error deleting preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/rename', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const oldName = sanitize(String(request.body?.oldName || ''));
        const newName = sanitize(String(request.body?.newName || ''));
        if (!isValidApiId(apiId) || !oldName || !newName) {
            return response.status(400).send({ error: 'Invalid preset state rename payload.' });
        }
        if (oldName === newName) {
            return response.send({ ok: true, renamed: 0 });
        }

        const handle = request.user.profile.handle;
        const renamed = await getPresetRepo().renameStates(handle, apiId, oldName, newName);
        return response.send({ ok: true, renamed });
    } catch (error) {
        if (error instanceof ConflictError && error.code === 'preset_state_rename_collision') {
            return response.status(409).send({ error: 'Preset state rename collision.' });
        }
        console.error('Error renaming preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/patch', async function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const name = sanitize(String(request.body?.name || ''));
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (request.body?.operation ? [request.body.operation] : []);

        if (!name) {
            return response.status(400).send({ error: 'Preset name is required.' });
        }
        if (!Array.isArray(operations) || operations.length === 0) {
            return response.status(400).send({ error: 'No preset patch operations found. Expected body.operations or body.operation.' });
        }
        if (!isValidApiId(apiId)) {
            return response.sendStatus(400);
        }

        const handle = request.user.profile.handle;
        try {
            await getPresetRepo().patch(handle, apiId, name, operations);
        } catch (error) {
            if (error instanceof NotFoundError) {
                return response.status(404).send({ error: 'Preset file not found.' });
            }
            const mapped = mapPatchError(error, response);
            if (mapped) {
                return mapped;
            }
            throw error;
        }

        return response.send({ result: 'ok', applied: operations.length, name });
    } catch (error) {
        console.error('Error patching preset:', error);
        return response.status(500).send({ error: 'Failed to patch preset.' });
    }
});

router.post('/delete', async function (request, response) {
    const apiId = request.body?.apiId;
    const name = sanitize(String(request.body?.name || ''));
    if (!name) {
        return response.sendStatus(400);
    }
    if (!isValidApiId(apiId)) {
        return response.sendStatus(400);
    }

    try {
        const handle = request.user.profile.handle;
        const repo = getPresetRepo();
        if (!(await repo.exists(handle, apiId, name))) {
            return response.sendStatus(404);
        }
        await repo.delete(handle, apiId, name);
        return response.sendStatus(200);
    } catch (error) {
        console.error('Error deleting preset:', error);
        return response.sendStatus(500);
    }
});

router.post('/restore', function (request, response) {
    try {
        const apiId = request.body.apiId;
        const directories = request.user.directories;
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(directories);

        const folder = presetFolderForApiId(apiId, directories);
        const defaultPreset = folder
            ? defaultPresets.find(p => p.name === name && p.folder === folder)
            : null;

        const result = { isDefault: false, preset: {} };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
        }

        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
