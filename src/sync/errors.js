/**
 * An `Error` carrying a stable machine-readable `code` for routes and the UI.
 *
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function syncError(code, message) {
    return Object.assign(new Error(message), { code });
}
