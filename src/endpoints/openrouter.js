import express from 'express';
import fetch from 'node-fetch';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { runLukerDispatch } from '../luker-dispatch/runner.js';
import { dispatchSdOpenrouterImage } from '../luker-dispatch/providers/sd/openrouter-image.js';
import { normalizeModelsUrl, resolveSdSecret } from '../luker-dispatch/providers/sd/sd-auth.js';
import { createProxyBoundFetch, createRequestProxyAgent } from '../request-proxy.js';

export const router = express.Router();
const API_OPENROUTER = 'https://openrouter.ai/api/v1';

router.post('/models/providers', async (req, res) => {
    try {
        const { model } = req.body;
        const response = await fetch(`${API_OPENROUTER}/models/${model}/endpoints`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const endpoints = data?.data?.endpoints || [];
        const providerNames = endpoints.map(e => e.provider_name);

        return res.json(providerNames);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

/**
 * Fetches and filters models from OpenRouter API based on modality criteria.
 * @param {string} endpoint - The API endpoint to fetch from
 * @param {string} inputModality - Required input modality
 * @param {string} outputModality - Required output modality
 * @param {((model: any) => any) | null} [mapFn=null] - Optional mapping function to transform the results
 * @returns {Promise<any[]>} Filtered and/or mapped models
 */
async function fetchModelsByModality(endpoint, inputModality, outputModality, mapFn = null) {
    const response = await fetch(`${API_OPENROUTER}${endpoint}?output_modalities=${encodeURIComponent(outputModality)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
        console.warn('OpenRouter API request failed', response.statusText);
        return [];
    }

    /** @type {any} */
    const data = await response.json();

    if (!Array.isArray(data?.data)) {
        console.warn('OpenRouter API response was not an array');
        return [];
    }

    const filtered = data.data
        .filter(m => Array.isArray(m?.architecture?.input_modalities))
        .filter(m => m.architecture.input_modalities.includes(inputModality))
        .filter(m => Array.isArray(m?.architecture?.output_modalities))
        .filter(m => m.architecture.output_modalities.includes(outputModality))
        .sort((a, b) => a?.id && b?.id ? a.id.localeCompare(b.id) : 0);

    return typeof mapFn === 'function' ? filtered.map(mapFn) : filtered;
}

router.post('/models/multimodal', async (_req, res) => {
    try {
        const models = await fetchModelsByModality('/models', 'image', 'text', m => m.id);
        return res.json(models);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/models/embedding', async (_req, res) => {
    try {
        const models = await fetchModelsByModality('/models', 'text', 'embeddings', m => ({ id: m.id, name: m.name }));
        return res.json(models);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/models/image', async (req, res) => {
    try {
        const customBase = String(req.body?.api_url || '').trim();
        const key = resolveSdSecret({ body: req.body, user: req.user }, [SECRET_KEYS.OPENROUTER], { allowEmpty: true });
        if (!customBase && !req.body?.network_proxy && !key) {
            const models = await fetchModelsByModality('/models', 'text', 'image', m => ({ value: m.id, text: m.name || m.id }));
            return res.json(models);
        }
        const proxyFetch = createProxyBoundFetch(fetch, createRequestProxyAgent(req.body?.network_proxy));
        const modelsBase = normalizeModelsUrl(customBase || API_OPENROUTER);
        const url = `${modelsBase}?output_modalities=${encodeURIComponent('image')}`;
        const headers = { 'Accept': 'application/json' };
        if (key) {
            headers['Authorization'] = `Bearer ${key}`;
        }
        const response = await proxyFetch(url, { method: 'GET', headers });
        if (!response.ok) {
            console.warn('OpenRouter API request failed', response.statusText);
            return res.json([]);
        }
        /** @type {any} */
        const data = await response.json();
        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }
        const filtered = data.data
            .filter(m => !Array.isArray(m?.architecture?.output_modalities) || m.architecture.output_modalities.includes('image'))
            .sort((a, b) => a?.id && b?.id ? a.id.localeCompare(b.id) : 0)
            .map(m => ({ value: m.id, text: m.name || m.id }));
        return res.json(filtered);
    } catch (error) {
        console.error(error);
        return res.status(400).json({ error: String(error?.message || error) });
    }
});

router.post('/credits', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.OPENROUTER);

        if (!key) {
            console.warn('OpenRouter API key not found');
            return res.sendStatus(400);
        }

        const response = await fetch(`${API_OPENROUTER}/credits`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            console.warn('OpenRouter credits request failed', response.statusText);
            return res.sendStatus(500);
        }

        /** @type {any} */
        const data = await response.json();
        const totalCredits = data.data?.total_credits ?? 0;
        const totalUsage = data.data?.total_usage ?? 0;
        const remaining = totalCredits - totalUsage;

        return res.json({ remaining, total_credits: totalCredits, total_usage: totalUsage });
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.post('/image/generate', (req, res) => runLukerDispatch(req, res, {
    endpoint: 'sd/openrouter',
    select: () => dispatchSdOpenrouterImage,
}));
