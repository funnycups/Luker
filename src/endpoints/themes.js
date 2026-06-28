import express from 'express';
import { InvalidArgumentError, NotFoundError } from '../storage/errors.js';
import { getNamedDocRepo } from '../storage/index.js';
import { assertSafeRepoName } from '../storage/name-validation.js';

export const router = express.Router();

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
    try {
        await getNamedDocRepo().save(request.user.profile.handle, 'themes', safeName, request.body);
        return response.sendStatus(200);
    } catch (err) {
        console.error('Error saving theme:', err);
        return response.sendStatus(500);
    }
});

router.post('/delete', async (request, response) => {
    if (!request.body || !request.body.name) return response.sendStatus(400);
    try {
        await getNamedDocRepo().delete(request.user.profile.handle, 'themes', request.body.name, { strict: true });
        return response.sendStatus(200);
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('Theme file not found:', request.body.name);
            return response.sendStatus(404);
        }
        console.error('Error deleting theme:', err);
        return response.sendStatus(500);
    }
});
