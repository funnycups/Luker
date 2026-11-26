import express from 'express';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { getNamedDocRepo } from '../storage/index.js';
import { assertSafeRepoName } from '../storage/name-validation.js';
import { sendJsonResource, sendResourceReadError } from '../http-resource-cache.js';
import {
    getBuiltinTheme,
    isBuiltinThemeName,
    listBuiltinThemeNames,
    stripInternalThemeFields,
} from '../themes/builtin-themes.js';
import { ensureLegacyThemesMigrated } from '../themes/theme-migration.js';

export const router = express.Router();

router.get('/list', async (request, response) => {
    try {
        const handle = request.user.profile.handle;
        await ensureLegacyThemesMigrated(handle);
        const entries = await getNamedDocRepo().list(handle, 'themes');
        const builtinNames = listBuiltinThemeNames();
        const nameSet = new Set(builtinNames);
        for (const entry of entries) {
            const name = entry?.key?.name;
            if (typeof name === 'string' && name.length > 0) {
                nameSet.add(name);
            }
        }
        const names = [...nameSet].sort((a, b) => a.localeCompare(b));
        return sendJsonResource(request, response, {
            resource: 'themes:list',
            value: { names, builtin: builtinNames },
        });
    } catch (error) {
        console.error('Error reading themes directory:', error);
        return sendResourceReadError(response, {
            code: 'read_failed',
            resource: 'themes:list',
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
            resource: 'themes',
            detail: 'Expected a document name.',
            status: 400,
        });
    }
    try {
        const builtinTheme = getBuiltinTheme(name);
        if (builtinTheme) {
            return sendJsonResource(request, response, {
                resource: `themes:builtin:${name}`,
                value: builtinTheme,
            });
        }
        const handle = request.user.profile.handle;
        await ensureLegacyThemesMigrated(handle);
        assertSafeRepoName(name, 'Theme name');
        const result = await getNamedDocRepo().read(handle, 'themes', name);
        if (!result.exists) {
            return sendResourceReadError(response, {
                code: 'not_found',
                resource: `themes:${name}`,
                detail: 'Document does not exist.',
                status: 404,
            });
        }
        if (!result.valid) {
            return sendResourceReadError(response, {
                code: 'invalid_resource',
                resource: `themes:${name}`,
                detail: result.detail || 'Document is not valid JSON.',
                status: 422,
            });
        }
        return sendJsonResource(request, response, {
            resource: `themes:${name}`,
            value: result.value,
            cacheEntry: result.cacheEntry,
        });
    } catch (error) {
        if (error instanceof InvalidArgumentError) {
            return sendResourceReadError(response, {
                code: 'invalid_args',
                resource: `themes:${name}`,
                detail: error.message,
                status: 400,
            });
        }
        console.error('Error reading themes document:', error);
        return sendResourceReadError(response, {
            code: 'read_failed',
            resource: `themes:${name}`,
            detail: 'Failed to read the document.',
            status: 500,
        });
    }
});

router.post('/save', async (request, response) => {
    if (!request.body || !request.body.name) return response.sendStatus(400);
    let safeName;
    try {
        safeName = assertSafeRepoName(request.body.name);
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return response.status(400).send({ error: err.message });
        }
        throw err;
    }
    if (isBuiltinThemeName(safeName)) {
        return response.status(403).send({
            error: 'Built-in themes are read-only and cannot be overwritten.',
            code: 'builtin_theme_readonly',
        });
    }
    try {
        const doc = stripInternalThemeFields(request.body);
        await getNamedDocRepo().save(request.user.profile.handle, 'themes', safeName, doc);
        return response.sendStatus(200);
    } catch (err) {
        console.error('Error saving theme:', err);
        return response.sendStatus(500);
    }
});

router.post('/patch', async (request, response) => {
    const rawName = request.body?.name;
    const patch = request.body?.patch;
    if (!rawName || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return response.status(400).send({ error: 'Expected theme name and patch object.' });
    }
    let safeName;
    try {
        safeName = assertSafeRepoName(rawName);
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return response.status(400).send({ error: err.message });
        }
        throw err;
    }
    if (isBuiltinThemeName(safeName)) {
        return response.status(403).send({
            error: 'Built-in themes are read-only and cannot be modified.',
            code: 'builtin_theme_readonly',
        });
    }
    try {
        const handle = request.user.profile.handle;
        const repo = getNamedDocRepo();
        const existing = await repo.get(handle, 'themes', safeName);
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
            return response.status(404).send({ error: 'Theme not found.', code: 'not_found' });
        }
        const sanitizedPatch = stripInternalThemeFields(patch);
        delete sanitizedPatch.name;
        const updated = { ...stripInternalThemeFields(existing) };
        for (const [key, value] of Object.entries(sanitizedPatch)) {
            if (value === null || value === undefined) {
                delete updated[key];
            } else {
                updated[key] = value;
            }
        }
        if (typeof updated.name !== 'string' || !updated.name) {
            updated.name = safeName;
        }
        await repo.save(handle, 'themes', safeName, updated);
        return response.status(200).send({ ok: true, theme: updated });
    } catch (err) {
        console.error('Error patching theme:', err);
        return response.sendStatus(500);
    }
});

router.post('/delete', async (request, response) => {
    if (!request.body || !request.body.name) return response.sendStatus(400);
    let safeName;
    try {
        safeName = assertSafeRepoName(request.body.name);
    } catch (err) {
        if (err instanceof InvalidArgumentError) {
            return response.status(400).send({ error: err.message });
        }
        throw err;
    }
    if (isBuiltinThemeName(safeName)) {
        return response.status(403).send({
            error: 'Built-in themes are read-only and cannot be deleted.',
            code: 'builtin_theme_readonly',
        });
    }
    try {
        await getNamedDocRepo().delete(request.user.profile.handle, 'themes', safeName, { strict: true });
        return response.sendStatus(200);
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('Theme file not found:', safeName);
            return response.sendStatus(404);
        }
        console.error('Error deleting theme:', err);
        return response.sendStatus(500);
    }
});
