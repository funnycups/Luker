import { compare as compareJsonPatch } from '../util/fast-json-patch.js';

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fall back to JSON-safe cloning for values that cannot be structured-cloned.
        }
    }

    const seen = new WeakSet();
    const serialized = JSON.stringify(value, (_, nextValue) => {
        if (typeof nextValue === 'function' || typeof nextValue === 'symbol') {
            return undefined;
        }
        if (typeof nextValue === 'bigint') {
            return String(nextValue);
        }
        if (nextValue && typeof nextValue === 'object') {
            if (seen.has(nextValue)) {
                return undefined;
            }
            seen.add(nextValue);
        }
        return nextValue;
    });

    return serialized === undefined ? undefined : JSON.parse(serialized);
}

function decodeJsonPointerSegment(segment) {
    return String(segment || '').replace(/~1/g, '/').replace(/~0/g, '~');
}

function getJsonPointerValue(root, path) {
    if (path === '') {
        return { found: true, value: root };
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
        return { found: false, value: undefined };
    }

    const segments = path.slice(1).split('/').map(decodeJsonPointerSegment);
    let cursor = root;

    for (const segment of segments) {
        if (Array.isArray(cursor)) {
            if (segment === '-') {
                return { found: false, value: undefined };
            }
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
                return { found: false, value: undefined };
            }
            cursor = cursor[index];
            continue;
        }

        if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
            return { found: false, value: undefined };
        }
        cursor = cursor[segment];
    }

    return { found: true, value: cursor };
}

function attachObjectPatchTests(previousState, operations) {
    const sourceOperations = Array.isArray(operations)
        ? operations.filter(op => op && typeof op === 'object')
        : [];
    if (sourceOperations.length === 0) {
        return sourceOperations;
    }

    let lastTestedPath = null;
    const guardedOperations = [];

    for (const operation of sourceOperations) {
        const opName = String(operation.op || '').trim().toLowerCase();
        const path = typeof operation.path === 'string' ? operation.path : null;

        if (opName === 'test') {
            guardedOperations.push(operation);
            if (typeof path === 'string') {
                lastTestedPath = path;
            }
            continue;
        }

        const shouldAddTest = (opName === 'replace' || opName === 'remove')
            && typeof path === 'string'
            && path !== lastTestedPath;

        if (shouldAddTest) {
            const resolved = getJsonPointerValue(previousState, path);
            if (resolved.found) {
                guardedOperations.push({
                    op: 'test',
                    path,
                    value: cloneJsonValue(resolved.value),
                });
                lastTestedPath = path;
            }
        }

        guardedOperations.push(operation);

        if (opName === 'add' || opName === 'remove') {
            lastTestedPath = null;
        }
    }

    return guardedOperations;
}

function isDiffableContainer(value) {
    return isPlainObject(value) || Array.isArray(value);
}

function buildObjectPatchOperations(previousState, nextState, options = {}) {
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 2000;
    const attachTests = options?.attachTests !== false;

    if (!isDiffableContainer(nextState)) {
        return [];
    }

    const previous = isDiffableContainer(previousState)
        ? previousState
        : (Array.isArray(nextState) ? [] : {});
    const operations = compareJsonPatch(previous, nextState);
    if (operations.length > maxOperations) {
        return [{ op: 'replace', path: '', value: cloneJsonValue(nextState) }];
    }

    return attachTests ? attachObjectPatchTests(previous, operations) : operations;
}

self.addEventListener('message', (event) => {
    const id = Number(event?.data?.id);
    const previousState = event?.data?.previousState;
    const nextState = event?.data?.nextState;
    const maxOperations = Number(event?.data?.maxOperations);
    const attachTests = event?.data?.attachTests !== false;

    if (!Number.isInteger(id)) {
        return;
    }

    try {
        const operations = buildObjectPatchOperations(previousState, nextState, {
            maxOperations: Number.isInteger(maxOperations) && maxOperations > 0 ? maxOperations : 2000,
            attachTests,
        });
        self.postMessage({ id, ok: true, operations });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
});
