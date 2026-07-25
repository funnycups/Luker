import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { attachInspectionEndpoint } from '../request-inspector.js';

const SOURCES = {
    'nomicai': {
        secretKey: SECRET_KEYS.NOMICAI,
        url: 'https://api-atlas.nomic.ai/v1/embedding/text',
        model: 'nomic-embed-text-v1.5',
    },
};

/**
 * Gets the vector for the given text batch from NomicAI.
 * @param {string[]} texts - The array of texts to get the vector for
 * @param {string} source - The source of the vector
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {object} [sourceSettings] - Resolved source settings; may include `reverseProxy`, `proxyPassword`, `secretId`
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getNomicAIBatchVector(texts, source, directories, sourceSettings = null, request = null) {
    const config = SOURCES[source];

    if (!config) {
        console.error('Unknown source', source);
        throw new Error('Unknown source');
    }

    const settings = sourceSettings || {};
    const reverseProxy = typeof settings.reverseProxy === 'string' ? settings.reverseProxy.trim() : '';
    const proxyPassword = typeof settings.proxyPassword === 'string' ? settings.proxyPassword : '';
    const secretId = typeof settings.secretId === 'string' && settings.secretId.trim()
        ? settings.secretId.trim()
        : null;

    const key = reverseProxy
        ? proxyPassword
        : readSecret(directories, config.secretKey, secretId);

    if (!key) {
        console.warn('No API key found');
        throw new Error('No API key found');
    }

    const url = reverseProxy
        ? reverseProxy.replace(/\/+$/, '')
        : config.url;

    const body = {
        texts: texts,
        model: config.model,
    };

    if (request) attachInspectionEndpoint(request, url, key, body);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();
        console.warn('API request failed', response.statusText, text);
        throw new Error('API request failed');
    }

    /** @type {any} */
    const data = await response.json();
    if (!Array.isArray(data?.embeddings)) {
        console.warn('API response was not an array');
        throw new Error('API response was not an array');
    }

    return data.embeddings;
}

/**
 * Gets the vector for the given text from NomicAI.
 * @param {string} text - The text to get the vector for
 * @param {string} source - The source of the vector
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {object} [sourceSettings] - Resolved source settings
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getNomicAIVector(text, source, directories, sourceSettings = null, request = null) {
    const vectors = await getNomicAIBatchVector([text], source, directories, sourceSettings, request);
    return vectors[0];
}
