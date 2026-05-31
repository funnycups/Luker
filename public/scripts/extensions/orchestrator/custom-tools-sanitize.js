/**
 * Shared sanitizer for Layer-3 profile.customTools[]. Called by every
 * mode's sanitize*Profile function. Compile is intentionally deferred to
 * runtime (per-run-custom-tools.js) so a schema with bad JS can still
 * persist — failures surface as a console warn at run time, not at save.
 */

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const BODY_MAX_BYTES = 65536;
const DESCRIPTION_MAX_BYTES = 8192;
const DISPLAY_NAME_MAX_BYTES = 256;

function clampString(value, maxLen) {
    if (typeof value !== 'string') return '';
    return value.length > maxLen ? value.slice(0, maxLen) : value;
}

export function sanitizeCustomTools(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    const byName = new Map();  // name -> index in `out`
    for (const raw of input) {
        if (!raw || typeof raw !== 'object') continue;
        const name = String(raw.name || '');
        if (!NAME_PATTERN.test(name)) continue;
        const mode = raw.mode === 'read' ? 'read' : 'write';
        const entry = {
            name,
            displayName: clampString(typeof raw.displayName === 'string' ? raw.displayName : '', DISPLAY_NAME_MAX_BYTES),
            description: clampString(typeof raw.description === 'string' ? raw.description : '', DESCRIPTION_MAX_BYTES),
            parameters: raw.parameters && typeof raw.parameters === 'object'
                ? raw.parameters
                : { type: 'object' },
            mode,
            body: clampString(raw.body, BODY_MAX_BYTES),
            simulateBody: clampString(raw.simulateBody, BODY_MAX_BYTES),
        };
        if (byName.has(name)) {
            console.warn(`[orchestrator] sanitizeCustomTools: duplicate name '${name}' — later definition wins.`);
            out[byName.get(name)] = entry;
        } else {
            byName.set(name, out.length);
            out.push(entry);
        }
    }
    return out;
}
