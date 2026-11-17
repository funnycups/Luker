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
