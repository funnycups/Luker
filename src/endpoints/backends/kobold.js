import fs from 'node:fs';
import express from 'express';
import fetch from 'node-fetch';

import { setAdditionalHeaders, setAdditionalHeadersByType } from '../../additional-headers.js';
import { TEXTGEN_TYPES } from '../../constants.js';
import { runLukerDispatch } from '../../luker-dispatch/runner.js';
import { dispatchKobold } from '../../luker-dispatch/providers/kobold.js';

export const router = express.Router();

/**
 * Kobold `/generate` — delegates to {@link dispatchKobold} via
 * {@link runLukerDispatch}. Legacy inline handler (localhost rewrite +
 * sampler-bag body pickBy + streaming vs `/v1/generate` fetch + can_abort
 * side-channel POST + 403/503 retry + `{detail:{msg}}` error reshape) now
 * lives in src/luker-dispatch/providers/kobold.js.
 */
router.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'kobold',
    select: () => dispatchKobold,
}));

router.post('/status', async function (request, response) {
    if (!request.body) return response.sendStatus(400);
    let api_server = request.body.api_server;
    if (api_server.indexOf('localhost') != -1) {
        api_server = api_server.replace('localhost', '127.0.0.1');
    }

    const args = {
        headers: { 'Content-Type': 'application/json' },
    };

    setAdditionalHeaders(request, args, api_server);

    const result = {};

    /** @type {any} */
    const [koboldUnitedResponse, koboldExtraResponse, koboldModelResponse] = await Promise.all([
        // We catch errors both from the response not having a successful HTTP status and from JSON parsing failing

        // Kobold United API version
        fetch(`${api_server}/v1/info/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ result: '0.0.0' })),

        // KoboldCpp version
        fetch(`${api_server}/extra/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ version: '0.0' })),

        // Current model
        fetch(`${api_server}/v1/model`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => null),
    ]);

    result.koboldUnitedVersion = koboldUnitedResponse.result;
    result.koboldCppVersion = koboldExtraResponse.result;
    result.model = !koboldModelResponse || koboldModelResponse.result === 'ReadOnly' ?
        'no_connection' :
        koboldModelResponse.result;

    response.send(result);
});

router.post('/transcribe-audio', async function (request, response) {
    try {
        const server = request.body.server;

        if (!server) {
            console.error('Server is not set');
            return response.sendStatus(400);
        }

        if (!request.file) {
            console.error('No audio file found');
            return response.sendStatus(400);
        }

        console.debug('Transcribing audio with KoboldCpp', server);

        const fileBase64 = fs.readFileSync(request.file.path).toString('base64');
        fs.unlinkSync(request.file.path);

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const url = new URL(server);
        url.pathname = '/api/extra/transcribe';

        const result = await fetch(url, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                prompt: '',
                audio_data: fileBase64,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            console.error('KoboldCpp request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('KoboldCpp transcription response', data);
        return response.json(data);
    } catch (error) {
        console.error('KoboldCpp transcription failed', error);
        response.status(500).send('Internal server error');
    }
});

router.post('/embed', async function (request, response) {
    try {
        const { server, items } = request.body;

        if (!server) {
            console.warn('KoboldCpp URL is not set');
            return response.sendStatus(400);
        }

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const embeddingsUrl = new URL(server);
        embeddingsUrl.pathname = '/api/extra/embeddings';

        const embeddingsResult = await fetch(embeddingsUrl, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                input: items,
            }),
        });

        /** @type {any} */
        const data = await embeddingsResult.json();

        if (!Array.isArray(data?.data)) {
            console.warn('KoboldCpp API response was not an array');
            return response.sendStatus(500);
        }

        const model = data.model || 'unknown';
        const embeddings = data.data.map(x => Array.isArray(x) ? x[0] : x).sort((a, b) => a.index - b.index).map(x => x.embedding);
        return response.json({ model, embeddings });
    } catch (error) {
        console.error('KoboldCpp embedding failed', error);
        response.status(500).send('Internal server error');
    }
});
