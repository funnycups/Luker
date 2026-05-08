import fetch from 'node-fetch';
import { SECRET_KEYS, readSecret } from '../endpoints/secrets.js';

const DEFAULT_JINA_URL = 'https://api.jina.ai/v1';

/**
 * Gets the vector for the given text batch from Jina AI endpoint.
 * @param {string[]} texts - The array of texts to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {object} options - Additional options (late_chunking, dimensions, task)
 * @param {object} [sourceSettings] - Resolved source settings; may include `reverseProxy`, `proxyPassword`, `secretId`
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getJinaBatchVector(texts, isQuery, directories, model, options = {}, sourceSettings = null) {
    const settings = sourceSettings || {};
    const reverseProxy = typeof settings.reverseProxy === 'string' ? settings.reverseProxy.trim() : '';
    const proxyPassword = typeof settings.proxyPassword === 'string' ? settings.proxyPassword : '';
    const secretId = typeof settings.secretId === 'string' && settings.secretId.trim()
        ? settings.secretId.trim()
        : null;

    const key = reverseProxy
        ? proxyPassword
        : readSecret(directories, SECRET_KEYS.JINA, secretId);

    if (!key) {
        console.warn('No API key found');
        throw new Error('No API key found');
    }

    const baseUrl = (reverseProxy || DEFAULT_JINA_URL).replace(/\/+$/, '');

    const requestBody = {
        model: model,
        input: texts,
    };

    // Add task parameter based on isQuery if not explicitly provided
    if (options.task !== undefined && options.task !== null) {
        requestBody.task = options.task;
    } else {
        requestBody.task = isQuery ? 'retrieval.query' : 'retrieval.passage';
    }

    // Add optional parameters only if they have meaningful values
    if (options.late_chunking !== undefined && options.late_chunking !== null) {
        requestBody.late_chunking = options.late_chunking;
    }

    if (options.dimensions !== undefined && options.dimensions !== null && options.dimensions > 0) {
        requestBody.dimensions = options.dimensions;
    }

    if (options.normalized !== undefined && options.normalized !== null) {
        requestBody.normalized = options.normalized;
    }

    if (options.truncate !== undefined && options.truncate !== null) {
        requestBody.truncate = options.truncate;
    }

    if (options.embedding_type !== undefined && options.embedding_type !== null) {
        requestBody.embedding_type = options.embedding_type;
    }

    const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const text = await response.text();
        console.warn('API request failed', response.statusText, text);
        throw new Error('API request failed');
    }

    /** @type {any} */
    const data = await response.json();
    if (!Array.isArray(data?.data)) {
        console.warn('API response was not an array');
        throw new Error('API response was not an array');
    }

    return data.data.map(item => item.embedding);
}

/**
 * Gets the vector for the given text from Jina AI endpoint.
 * @param {string} text - The text to get the vector for
 * @param {boolean} isQuery - If the text is a query for embedding search
 * @param {import('../users.js').UserDirectoryList} directories - The directories object for the user
 * @param {string} model - The model to use for the embedding
 * @param {object} options - Additional options (late_chunking, dimensions, task)
 * @param {object} [sourceSettings] - Resolved source settings
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getJinaVector(text, isQuery, directories, model, options = {}, sourceSettings = null) {
    const vectors = await getJinaBatchVector([text], isQuery, directories, model, options, sourceSettings);
    return vectors[0];
}
