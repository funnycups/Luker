import express from 'express';
import { InvalidArgumentError } from '../storage/errors.js';
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
        await getNamedDocRepo().save(request.user.profile.handle, 'movingUI', safeName, request.body);
        return response.sendStatus(200);
    } catch (err) {
        console.error('Error saving movingUI preset:', err);
        return response.sendStatus(500);
    }
});
