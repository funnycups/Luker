export function normalizePresetNameIndexMap(presetNames) {
    if (Array.isArray(presetNames)) {
        return presetNames.reduce((acc, name, index) => {
            const presetName = String(name ?? '').trim();
            if (presetName) {
                acc[presetName] = index;
            }
            return acc;
        }, {});
    }

    if (presetNames && typeof presetNames === 'object') {
        return Object.entries(presetNames).reduce((acc, [name, index]) => {
            const presetName = String(name ?? '').trim();
            const presetIndex = Number(index);
            if (presetName && Number.isInteger(presetIndex) && presetIndex >= 0) {
                acc[presetName] = presetIndex;
            }
            return acc;
        }, {});
    }

    return {};
}

export function listHydratedIndexedPresetNames(nameMap, bodies) {
    if (!nameMap || typeof nameMap !== 'object' || !Array.isArray(bodies)) {
        return [];
    }
    const hydrated = [];
    for (const [name, index] of Object.entries(nameMap)) {
        const body = bodies[index];
        if (name && body && typeof body === 'object') {
            hydrated.push(name);
        }
    }
    return hydrated;
}

export function hydrateIndexedPresetEntries({
    currentNames,
    currentBodies,
    nextNamesInput,
    nextBodiesInput,
    preserveExisting = false,
} = {}) {
    const existingByName = new Map();
    if (preserveExisting && currentNames && typeof currentNames === 'object' && Array.isArray(currentBodies)) {
        for (const [name, index] of Object.entries(currentNames)) {
            const existing = currentBodies[index];
            if (name && existing && typeof existing === 'object') {
                existingByName.set(name, existing);
            }
        }
    }

    const names = normalizePresetNameIndexMap(nextNamesInput ?? currentNames);
    const nameAtIndex = new Map();
    for (const [name, index] of Object.entries(names)) {
        nameAtIndex.set(index, name);
    }

    const bodies = Array.isArray(nextBodiesInput)
        ? nextBodiesInput.map((item, index) => {
            if (preserveExisting) {
                const candidate = Array.isArray(nextNamesInput)
                    ? String(nextNamesInput[index] ?? '').trim()
                    : nameAtIndex.get(index);
                if (candidate && existingByName.has(candidate)) {
                    return existingByName.get(candidate);
                }
            }
            if (typeof item === 'string') {
                return JSON.parse(item);
            }
            return null;
        })
        : [];

    if (preserveExisting) {
        for (const [name, existingBody] of existingByName.entries()) {
            if (!(name in names)) {
                bodies.push(existingBody);
                names[name] = bodies.length - 1;
            }
        }
    }

    return { names, bodies };
}

export function listHydratedOrderedPresetNames(names, bodies) {
    if (!Array.isArray(names) || !Array.isArray(bodies)) {
        return [];
    }
    const hydrated = [];
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const body = bodies[index];
        if (typeof name === 'string' && name && body && typeof body === 'object') {
            hydrated.push(name);
        }
    }
    return hydrated;
}

export function hydrateOrderedPresetEntries({
    currentNames,
    currentBodies,
    nextNamesInput,
    nextBodiesInput,
    preserveExisting = false,
} = {}) {
    const existingByName = new Map();
    if (preserveExisting && Array.isArray(currentNames) && Array.isArray(currentBodies)) {
        for (let index = 0; index < currentNames.length; index += 1) {
            const name = currentNames[index];
            const existing = currentBodies[index];
            if (typeof name === 'string' && name && existing && typeof existing === 'object') {
                existingByName.set(name, existing);
            }
        }
    }

    const names = Array.isArray(nextNamesInput) ? [...nextNamesInput] : [];
    const bodies = Array.isArray(nextBodiesInput)
        ? nextBodiesInput.map((item, index) => {
            if (preserveExisting) {
                const name = names[index];
                if (typeof name === 'string' && name && existingByName.has(name)) {
                    return existingByName.get(name);
                }
            }
            if (typeof item === 'string') {
                return JSON.parse(item);
            }
            return null;
        })
        : [];

    if (preserveExisting) {
        const presentNames = new Set(names);
        for (const [name, existingBody] of existingByName.entries()) {
            if (!presentNames.has(name)) {
                names.push(name);
                bodies.push(existingBody);
                presentNames.add(name);
            }
        }
    }

    return { names, bodies };
}

/**
 * Synthesizes a third-party-compatible preset list view for an active card-bound preset:
 * - No name collision with global presets: appends a synthesized entry at the tail.
 * - Same-name collision with an unhydrated (`null`/`undefined`) global slot: fills the hole with `ghost.body` so
 *   third-party extensions do not read `null` before background warm preload finishes.
 * - Same-name collision with an already-hydrated global object: returns `raw` unchanged (yield-to-global contract).
 * @param {{ presets: any[], preset_names: object, settings: object }} raw Raw preset list
 * @param {{ name?: string, body?: object }|null|undefined} ghost Active card-bound ghost preset snapshot
 * @returns {{ presets: any[], preset_names: object, settings: object }}
 */
export function synthesizeCardBoundPresetList(raw, ghost) {
    if (!raw || !ghost?.name || !ghost?.body || !raw.preset_names) {
        return raw;
    }

    if (!(ghost.name in raw.preset_names)) {
        const synthIndex = raw.presets.length;
        return {
            presets: [...raw.presets, ghost.body],
            preset_names: { ...raw.preset_names, [ghost.name]: synthIndex },
            settings: raw.settings,
        };
    }

    const existingIndex = raw.preset_names[ghost.name];
    if (Number.isInteger(existingIndex) && existingIndex >= 0 && raw.presets[existingIndex] == null) {
        const nextPresets = [...raw.presets];
        nextPresets[existingIndex] = ghost.body;
        return {
            presets: nextPresets,
            preset_names: { ...raw.preset_names },
            settings: raw.settings,
        };
    }

    return raw;
}
