import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';
import { attachInspectionEndpoint } from '../request-inspector.js';

const DEFAULT_COHERE_URL = 'https://api.cohere.ai/v2';

/**
 * Gets the vector for the given text batch from Cohere.
 * @param {string[]} texts - The array of texts to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {object} [sourceSettings] - Resolved source settings; may include `reverseProxy`, `proxyPassword`, `secretId`
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getCohereBatchVector(texts, isQuery, directories, model, sourceSettings = null, request = null) {
    const settings = sourceSettings || {};
    const reverseProxy = typeof settings.reverseProxy === 'string' ? settings.reverseProxy.trim() : '';
    const proxyPassword = typeof settings.proxyPassword === 'string' ? settings.proxyPassword : '';
    const secretId = typeof settings.secretId === 'string' && settings.secretId.trim()
        ? settings.secretId.trim()
        : null;

    const key = reverseProxy
        ? proxyPassword
        : readSecret(directories, SECRET_KEYS.COHERE, secretId);

    if (!key) {
        console.warn('No API key found');
        throw new Error('No API key found');
    }

    const baseUrl = (reverseProxy || DEFAULT_COHERE_URL).replace(/\/+$/, '');
    const embedUrl = `${baseUrl}/embed`;
    const body = {
        texts: texts,
        model: model,
        embedding_types: ['float'],
        input_type: isQuery ? 'search_query' : 'search_document',
        truncate: 'END',
    };

    if (request) attachInspectionEndpoint(request, embedUrl, key, body);

    const response = await fetch(embedUrl, {
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
    if (!Array.isArray(data?.embeddings?.float)) {
        console.warn('API response was not an array');
        throw new Error('API response was not an array');
    }

    return data.embeddings.float;
}

/**
 * Gets the vector for the given text from Cohere.
 * @param {string} text - The text to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {object} [sourceSettings] - Resolved source settings
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getCohereVector(text, isQuery, directories, model, sourceSettings = null, request = null) {
    const vectors = await getCohereBatchVector([text], isQuery, directories, model, sourceSettings, request);
    return vectors[0];
}
