import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { setAdditionalHeadersByType } from '../additional-headers.js';
import { TEXTGEN_TYPES } from '../constants.js';
import { trimV1 } from '../util.js';
import { attachInspectionEndpoint } from '../request-inspector.js';

/**
 * Gets the vector for the given text from VLLM
 * @param {string[]} texts - The array of texts to get the vectors for
 * @param {string} apiUrl - The API URL
 * @param {string} model - The model to use
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {object} [sourceSettings] - Resolved source settings; may include `secretId`, `reverseProxy`, `proxyPassword`
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getVllmBatchVector(texts, apiUrl, model, directories, sourceSettings = null, request = null) {
    const settings = sourceSettings || {};
    const reverseProxy = typeof settings.reverseProxy === 'string' ? settings.reverseProxy.trim() : '';
    const proxyPassword = typeof settings.proxyPassword === 'string' ? settings.proxyPassword : '';
    const secretId = typeof settings.secretId === 'string' && settings.secretId.trim()
        ? settings.secretId.trim()
        : null;

    const baseUrl = reverseProxy || apiUrl;
    const url = new URL(urlJoin(trimV1(baseUrl), '/v1/embeddings'));

    const headers = {};
    if (reverseProxy && proxyPassword) {
        headers['Authorization'] = `Bearer ${proxyPassword}`;
    } else {
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.VLLM, baseUrl, directories, secretId);
    }

    const body = { input: texts, model };
    const authForFingerprint = headers['Authorization'] || '';
    if (request) attachInspectionEndpoint(request, url.toString(), String(authForFingerprint), body);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`VLLM: Failed to get vector for text: ${response.statusText} ${responseText}`);
    }

    /** @type {any} */
    const data = await response.json();

    if (!Array.isArray(data?.data)) {
        throw new Error('API response was not an array');
    }

    // Sort data by x.index to ensure the order is correct
    data.data.sort((a, b) => a.index - b.index);

    const vectors = data.data.map(x => x.embedding);
    return vectors;
}

/**
 * Gets the vector for the given text from VLLM
 * @param {string} text - The text to get the vector for
 * @param {string} apiUrl - The API URL
 * @param {string} model - The model to use
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {object} [sourceSettings] - Resolved source settings
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getVllmVector(text, apiUrl, model, directories, sourceSettings = null, request = null) {
    const vectors = await getVllmBatchVector([text], apiUrl, model, directories, sourceSettings, request);
    return vectors[0];
}
