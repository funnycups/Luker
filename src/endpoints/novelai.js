import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';
import express from 'express';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { readAllChunks, trimTrailingSlash } from '../util.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { dispatchNovelAI } from '../luker-dispatch/providers/novelai.js';
import { dispatchSdNovelImage, importNovelVibeFile } from '../luker-dispatch/providers/sd/novel-image.js';

const API_NOVELAI = 'https://api.novelai.net';
const IMAGE_NOVELAI = 'https://image.novelai.net';

export const router = express.Router();

router.post('/status', async function (req, res) {
    if (!req.body) return res.sendStatus(400);
    const api_key_novel = readSecret(req.user.directories, SECRET_KEYS.NOVEL);

    if (!api_key_novel) {
        console.warn('NovelAI Access Token is missing.');
        return res.sendStatus(400);
    }

    try {
        const baseHost = trimTrailingSlash(String(req.body.novel_url || IMAGE_NOVELAI).trim()) || IMAGE_NOVELAI;
        const response = await fetch(baseHost + '/user/subscription', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + api_key_novel,
            },
        });

        if (response.ok) {
            const data = await response.json();
            return res.send(data);
        } else if (response.status == 401) {
            console.error('NovelAI Access Token is incorrect.');
            return res.send({ error: true });
        } else {
            console.warn('NovelAI returned an error:', response.statusText);
            return res.send({ error: true });
        }
    } catch (error) {
        console.error(error);
        return res.send({ error: true });
    }
});

router.post('/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'novelai',
    select: () => dispatchNovelAI,
}));

router.post('/generate-image', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/novel',
    select: () => dispatchSdNovelImage,
}));

router.post('/import-vibe', async (req, res) => {
    try {
        const imported = await importNovelVibeFile({
            directories: req.user?.directories,
            fileName: req.body?.fileName,
            content: req.body?.content,
        });
        return res.json(imported);
    } catch (error) {
        console.error('NovelAI import-vibe failed:', error);
        return res.status(400).send(String(error?.message || error));
    }
});

router.post('/generate-voice', async (request, response) => {
    const token = readSecret(request.user.directories, SECRET_KEYS.NOVEL);

    if (!token) {
        console.error('NovelAI Access Token is missing.');
        return response.sendStatus(400);
    }

    const text = request.body.text;
    const voice = request.body.voice;

    if (!text || !voice) {
        return response.sendStatus(400);
    }

    try {
        const url = `${API_NOVELAI}/ai/generate-voice?text=${encodeURIComponent(text)}&voice=-1&seed=${encodeURIComponent(voice)}&opus=false&version=v2`;
        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'audio/mpeg',
            },
        });

        if (!result.ok) {
            const errorText = await result.text();
            console.error('NovelAI returned an error.', result.statusText, errorText);
            return response.sendStatus(500);
        }

        const chunks = await readAllChunks(result.body);
        const buffer = Buffer.concat(chunks.map(chunk => new Uint8Array(chunk)));
        response.setHeader('Content-Type', 'audio/mpeg');
        return response.send(buffer);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
