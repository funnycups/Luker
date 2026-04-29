import express from 'express';

import { getImages } from '../util.js';
import { getCharactersSnapshot } from './characters.js';
import { getGroupsSnapshot } from './groups.js';
import { SecretManager } from './secrets.js';
import { buildSettingsResponse } from './settings.js';

export const router = express.Router();

router.post('/bootstrap', async (request, response) => {
    try {
        const directories = request.user.directories;
        const charactersPromise = getCharactersSnapshot(directories, { useShallowCharacters: true });
        const groups = getGroupsSnapshot(directories);
        const settings = buildSettingsResponse(request, {
            includePresetContents: false,
            includeQuickReplyPresets: false,
        });
        const avatars = getImages(directories.avatars);
        // Bootstrap needs the full masked secret metadata so the client can
        // render the key manager without an extra shape conversion step.
        const secret_state = new SecretManager(directories).getSecretState();
        const characters = await charactersPromise;

        return response.send({
            settings,
            characters,
            groups,
            avatars,
            secret_state,
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
