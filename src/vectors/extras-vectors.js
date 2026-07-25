import fetch from 'node-fetch';
import { attachInspectionEndpoint } from '../request-inspector.js';

/**
 * Gets the vector for the given text from SillyTavern-extras
 * @param {string[]} texts - The array of texts to get the vectors for
 * @param {string} apiUrl - The Extras API URL
 * @param {string} apiKey - The Extras API key, or empty string if API key not enabled
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[][]>} - The array of vectors for the texts
 */
export async function getExtrasBatchVector(texts, apiUrl, apiKey, request = null) {
    return getExtrasVectorImpl(texts, apiUrl, apiKey, request);
}

/**
 * Gets the vector for the given text from SillyTavern-extras
 * @param {string} text - The text to get the vector for
 * @param {string} apiUrl - The Extras API URL
 * @param {string} apiKey - The Extras API key, or empty string if API key not enabled
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<number[]>} - The vector for the text
 */
export async function getExtrasVector(text, apiUrl, apiKey, request = null) {
    return getExtrasVectorImpl(text, apiUrl, apiKey, request);
}

/**
 * Gets the vector for the given text from SillyTavern-extras
 * @param {string|string[]} text - The text or texts to get the vector(s) for
 * @param {string} apiUrl - The Extras API URL
 * @param {string} apiKey - The Extras API key, or empty string if API key not enabled *
 * @param {import('express').Request} [request] - Inspector-carrying request
 * @returns {Promise<Array>} - The vector for a single text if input is string, or the array of vectors for multiple texts if input is string[]
 */
async function getExtrasVectorImpl(text, apiUrl, apiKey, request = null) {
    let url;
    try {
        url = new URL(apiUrl);
        url.pathname = '/api/embeddings/compute';
    } catch (error) {
        console.error('Failed to set up Extras API call:', error);
        console.debug('Extras API URL given was:', apiUrl);
        throw error;
    }

    const headers = {
        'Content-Type': 'application/json',
    };

    // Include the Extras API key, if enabled
    if (apiKey && apiKey.length > 0) {
        Object.assign(headers, {
            'Authorization': `Bearer ${apiKey}`,
        });
    }

    const body = { text };
    if (request) attachInspectionEndpoint(request, url.toString(), apiKey || '', body);

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),  // The backend accepts {string|string[]} for one or multiple text items, respectively.
    });

    if (!response.ok) {
        const errText = await response.text();
        console.warn('Extras request failed', response.statusText, errText);
        throw new Error('Extras request failed');
    }

    /** @type {any} */
    const data = await response.json();
    const vector = data.embedding;  // `embedding`: number[] (one text item), or number[][] (multiple text items).

    return vector;
}
