const LORA_WEIGHT_PATTERN = /^-?\d+(\.\d+)?$/;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}

/**
 * Builds the JSON-schema property for the optional per-image LoRA selection.
 * Returns null when no LoRA can be selected.
 *
 * @param {string[]} names Selectable LoRA names.
 * @param {{ includeWeight?: boolean }} [options] Whether each entry offers a weight.
 * @returns {object | null} Schema usable as a tool parameter property.
 */
export function buildLorasProperty(names, { includeWeight = false } = {}) {
    if (names.length === 0) {
        return null;
    }

    const properties = {
        name: {
            type: 'string',
            enum: [...names],
            description: 'LoRA name.',
        },
    };
    if (includeWeight) {
        properties.weight = {
            type: 'number',
            description: 'LoRA weight. Defaults to 1.',
        };
    }

    return {
        type: 'array',
        description: 'LoRAs to load for this image. Omit when none apply.',
        items: {
            type: 'object',
            properties,
            required: ['name'],
        },
    };
}

/**
 * Validates the LoRA tool argument supplied by the model.
 *
 * @param {unknown} value Raw argument value; undefined means the argument was omitted.
 * @param {{ available?: string[], includeWeight?: boolean }} [options] Allowed names and whether a weight is offered.
 * @returns {{ ok: true, value: Array<{ name: string, weight: number }> } | { ok: false, error: string }}
 */
export function validateLorasArg(value, { available, includeWeight = false } = {}) {
    if (value === undefined) {
        return { ok: true, value: [] };
    }
    if (!Array.isArray(value)) {
        return { ok: false, error: 'loras must be an array' };
    }

    const seen = new Set();
    const result = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            return { ok: false, error: 'loras entry must be an object with a name' };
        }
        if (!isNonEmptyString(entry.name)) {
            return { ok: false, error: 'loras entry name must be a non-empty string' };
        }
        if (seen.has(entry.name)) {
            return { ok: false, error: `duplicate LoRA '${entry.name}'` };
        }
        seen.add(entry.name);
        if (available !== undefined && !available.includes(entry.name)) {
            return { ok: false, error: `unknown LoRA '${entry.name}'` };
        }

        const weight = entry.weight;
        if (weight !== undefined && !includeWeight) {
            return { ok: false, error: `LoRA '${entry.name}' does not accept a weight` };
        }
        if (weight !== undefined && !Number.isFinite(weight)) {
            return { ok: false, error: `LoRA '${entry.name}' weight must be a finite number` };
        }

        result.push({ name: entry.name, weight: weight === undefined ? 1 : weight });
    }
    return { ok: true, value: result };
}

/**
 * Parses the slash-command LoRA list. An entry is a LoRA name with an optional
 * `:<weight>` suffix after the last colon; a suffix that is not a number stays
 * part of the name. The weight key is present only when the entry carried a
 * numeric suffix, so an implicit weight is never mistaken for an explicit one.
 *
 * @param {string | string[]} values One entry or a list of entries.
 * @returns {{ ok: true, value: Array<{ name: string, weight?: number }> } | { ok: false, error: string }}
 */
export function parseSlashLoras(values) {
    const entries = typeof values === 'string' ? [values] : values;
    if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) {
        return { ok: false, error: 'loras must be a string or an array of strings' };
    }

    const seen = new Set();
    const result = [];
    for (const entry of entries) {
        const separator = entry.lastIndexOf(':');
        const suffix = separator === -1 ? '' : entry.slice(separator + 1);
        const hasWeight = LORA_WEIGHT_PATTERN.test(suffix);
        const name = hasWeight ? entry.slice(0, separator) : entry;
        if (!isNonEmptyString(name)) {
            return { ok: false, error: 'LoRA name must not be empty' };
        }
        if (seen.has(name)) {
            return { ok: false, error: `duplicate LoRA '${name}'` };
        }
        seen.add(name);
        result.push(hasWeight ? { name, weight: Number(suffix) } : { name });
    }
    return { ok: true, value: result };
}

/**
 * Filters saved record LoRAs down to the names that are still available,
 * preserving order and weights, and reports the dropped names.
 *
 * @param {Array<{ name: string, weight: number }>} saved LoRAs stored on a record.
 * @param {string[]} [available] Currently available names; omitted keeps every entry.
 * @returns {{ loras: Array<{ name: string, weight: number }>, dropped: string[] }}
 */
export function resolveRecordLoras(saved, available) {
    const loras = [];
    const dropped = [];
    for (const entry of saved) {
        if (available === undefined || available.includes(entry.name)) {
            loras.push({ name: entry.name, weight: entry.weight });
        } else {
            dropped.push(entry.name);
        }
    }
    return { loras, dropped };
}

/**
 * Resolves the LoRA selection stored on a record for replay and reports the
 * names that can no longer be applied.
 *
 * @param {Array<{ name: string, weight: number }>} saved LoRAs stored on a record.
 * @param {string[]} available Currently available names.
 * @param {(dropped: string[]) => void} [warn] Receives the dropped names once when any were dropped.
 * @returns {{ loras: Array<{ name: string, weight: number }>, dropped: string[] }}
 */
export function resolveReplayLoras(saved, available, warn) {
    const { loras, dropped } = resolveRecordLoras(saved, available);
    if (dropped.length > 0) {
        warn?.(dropped);
    }
    return { loras, dropped };
}
