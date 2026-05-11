import { getRequestHeaders } from '../script.js';

/**
 * Saves a preset to the server with a full write.
 *
 * @param {object} options
 * @param {string} options.apiId
 * @param {string} options.name
 * @param {object} options.preset
 * @returns {Promise<{ ok: boolean, response: Response, data: any, mode: 'full', operations: [] }>}
 */
export async function persistPreset(options) {
    const apiId = String(options?.apiId || '').trim();
    const name = String(options?.name || '').trim();
    const preset = options?.preset && typeof options.preset === 'object' && !Array.isArray(options.preset)
        ? options.preset
        : {};

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId, name, preset }),
    });

    const data = response.ok ? await response.json() : null;
    return {
        ok: response.ok,
        response,
        data,
        mode: 'full',
        operations: [],
    };
}
