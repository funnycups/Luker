import express from 'express';
import { getNamedDocRepo } from '../storage/index.js';

export const router = express.Router();

router.post('/save', async (request, response) => {
    if (!request.body || !request.body.name) return response.sendStatus(400);
    try {
        await getNamedDocRepo().save(request.user.profile.handle, 'quickReplies', request.body.name, request.body);
        return response.sendStatus(200);
    } catch (err) {
        console.error('Error saving quick-reply preset:', err);
        return response.sendStatus(500);
    }
});

router.post('/delete', async (request, response) => {
    if (!request.body || !request.body.name) return response.sendStatus(400);
    try {
        await getNamedDocRepo().delete(request.user.profile.handle, 'quickReplies', request.body.name);
        return response.sendStatus(200);
    } catch (err) {
        console.error('Error deleting quick-reply preset:', err);
        return response.sendStatus(500);
    }
});
