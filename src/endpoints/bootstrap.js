import express from 'express';

import { getConfigValue, getImages } from '../util.js';
import { getCharactersSnapshot } from './characters.js';
import { getGroupsSnapshot } from './groups.js';
import { SecretManager } from './secrets.js';
import { buildSettingsResponse } from './settings.js';

export const router = express.Router();

router.get('/bootstrap/metadata', (request, response) => {
    try {
        response.set('Cache-Control', 'no-store');
        return response.send({
            account: request.user.profile.handle,
            enable_extensions: !!getConfigValue('extensions.enabled', true, 'boolean'),
            enable_extensions_auto_update: !!getConfigValue('extensions.autoUpdate', true, 'boolean'),
            enable_accounts: !!getConfigValue('enableUserAccounts', false, 'boolean'),
            secret_state: new SecretManager(request.user.directories).getSecretState(),
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/bootstrap', async (request, response) => {
    try {
        const directories = request.user.directories;
        const handle = request.user.profile.handle;
        const includeSettings = request.body?.includeSettings !== false;
        const charactersPromise = getCharactersSnapshot(directories, { useShallowCharacters: true, handle });
        const groupsPromise = getGroupsSnapshot(handle);
        const settings = includeSettings
            ? await buildSettingsResponse(request, {
                includePresetContents: false,
                includeQuickReplyPresets: false,
            })
            : null;
        const avatars = getImages(directories.avatars);
        // Bootstrap needs the full masked secret metadata so the client can
        // render the key manager without an extra shape conversion step.
        const secret_state = new SecretManager(directories).getSecretState();
        const characters = await charactersPromise;
        const groups = await groupsPromise;

        return response.send({
            ...(settings ? { settings } : {}),
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
