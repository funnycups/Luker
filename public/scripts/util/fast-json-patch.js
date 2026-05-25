function isObjectLike(value) {
    return value !== null && typeof value === 'object';
}

function cloneJsonValue(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fallback below.
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

function cloneComparableJsonValue(value) {
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

function isSameJsonValue(left, right) {
    if (left === right) {
        return true;
    }
    if (left === null || right === null) {
        return false;
    }
    const leftType = typeof left;
    if (leftType !== typeof right) {
        return false;
    }
    if (leftType !== 'object') {
        return false; // primitives already handled by ===
    }
    const leftIsArray = Array.isArray(left);
    if (leftIsArray !== Array.isArray(right)) {
        return false;
    }
    if (leftIsArray) {
        if (left.length !== right.length) {
            return false;
        }
        for (let i = 0; i < left.length; i++) {
            if (!isSameJsonValue(left[i], right[i])) {
                return false;
            }
        }
        return true;
    }
    // Object equality per RFC 6902 §7.7: two members are equal if their keys
    // and values match, regardless of insertion order. The previous
    // `JSON.stringify(left) === JSON.stringify(right)` shortcut compared the
    // serialized form, which is order-sensitive — so a chat[i] whose `extra`
    // field had been re-assigned (and thus moved to the end of insertion
    // order on the FE side) failed the test against a server copy that still
    // held the on-disk order, even when both were structurally identical.
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(right, key)) {
            return false;
        }
        if (!isSameJsonValue(left[key], right[key])) {
            return false;
        }
    }
    return true;
}

function isUnsafePathSegment(segment) {
    return segment === '__proto__' || segment === 'prototype' || segment === 'constructor';
}

function escapePathSegment(segment) {
    return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePathSegment(segment) {
    return String(segment).replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePath(path) {
    if (path === '' || path === undefined || path === null) {
        return [];
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error(`Invalid JSON Patch path: ${String(path)}`);
    }
    return path
        .slice(1)
        .split('/')
        .map(unescapePathSegment)
        .map(segment => {
            if (isUnsafePathSegment(segment)) {
                throw new Error(`Unsafe JSON Patch path segment: ${segment}`);
            }
            return segment;
        });
}

function joinPath(basePath, segment) {
    return `${basePath}/${escapePathSegment(segment)}`;
}

function normalizeArrayIndex(indexToken, length, { allowEnd = false } = {}) {
    if (indexToken === '-' && allowEnd) {
        return length;
    }
    if (!/^\d+$/.test(String(indexToken))) {
        throw new Error(`Invalid array index in JSON Patch path: ${String(indexToken)}`);
    }
    const index = Number(indexToken);
    if (!Number.isInteger(index)) {
        throw new Error(`Invalid array index in JSON Patch path: ${String(indexToken)}`);
    }
    if (allowEnd) {
        if (index < 0 || index > length) {
            throw new Error(`Array index out of bounds: ${index}`);
        }
    } else if (index < 0 || index >= length) {
        throw new Error(`Array index out of bounds: ${index}`);
    }
    return index;
}

function getContainerAndKey(document, segments) {
    if (segments.length === 0) {
        return { container: null, key: null };
    }

    let cursor = document;
    for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (Array.isArray(cursor)) {
            const index = normalizeArrayIndex(segment, cursor.length);
            cursor = cursor[index];
            continue;
        }
        if (!isObjectLike(cursor)) {
            throw new Error('Invalid JSON Patch path: encountered non-container object.');
        }
        cursor = cursor[segment];
    }

    return {
        container: cursor,
        key: segments[segments.length - 1],
    };
}

function applyAdd(document, segments, value) {
    if (segments.length === 0) {
        return cloneJsonValue(value);
    }

    const { container, key } = getContainerAndKey(document, segments);
    if (Array.isArray(container)) {
        const index = normalizeArrayIndex(key, container.length, { allowEnd: true });
        container.splice(index, 0, cloneJsonValue(value));
        return document;
    }
    if (!isObjectLike(container)) {
        throw new Error('Invalid JSON Patch add path.');
    }

    container[key] = cloneJsonValue(value);
    return document;
}

function applyReplace(document, segments, value) {
    if (segments.length === 0) {
        return cloneJsonValue(value);
    }

    const { container, key } = getContainerAndKey(document, segments);
    if (Array.isArray(container)) {
        const index = normalizeArrayIndex(key, container.length);
        container[index] = cloneJsonValue(value);
        return document;
    }
    if (!isObjectLike(container) || !Object.hasOwn(container, key)) {
        throw new Error('Invalid JSON Patch replace path.');
    }

    container[key] = cloneJsonValue(value);
    return document;
}

function applyRemove(document, segments) {
    if (segments.length === 0) {
        return {};
    }

    const { container, key } = getContainerAndKey(document, segments);
    if (Array.isArray(container)) {
        const index = normalizeArrayIndex(key, container.length);
        container.splice(index, 1);
        return document;
    }
    if (!isObjectLike(container)) {
        throw new Error('Invalid JSON Patch remove path.');
    }

    delete container[key];
    return document;
}

/**
 * fast-json-patch compatible compare operation subset.
 * Generates RFC6902 operations using add/remove/replace.
 */
export function compare(documentA, documentB) {
    const operations = [];
    // Compare against strict JSON clones so `undefined` object fields are ignored
    // exactly like JSON transport, preventing invalid ops without `value`.
    const leftRoot = cloneComparableJsonValue(documentA);
    const rightRoot = cloneComparableJsonValue(documentB);

    const walk = (left, right, path = '') => {
        if (isSameJsonValue(left, right)) {
            return;
        }

        if (Array.isArray(left) && Array.isArray(right)) {
            const shared = Math.min(left.length, right.length);
            for (let i = 0; i < shared; i++) {
                walk(left[i], right[i], joinPath(path, i));
            }
            for (let i = left.length - 1; i >= right.length; i--) {
                operations.push({ op: 'remove', path: joinPath(path, i) });
            }
            for (let i = shared; i < right.length; i++) {
                operations.push({ op: 'add', path: joinPath(path, i), value: cloneComparableJsonValue(right[i]) });
            }
            return;
        }

        const leftObject = isObjectLike(left) && !Array.isArray(left);
        const rightObject = isObjectLike(right) && !Array.isArray(right);

        if (leftObject && rightObject) {
            for (const key of Object.keys(left)) {
                if (!Object.hasOwn(right, key)) {
                    operations.push({ op: 'remove', path: joinPath(path, key) });
                }
            }
            for (const key of Object.keys(right)) {
                if (!Object.hasOwn(left, key)) {
                    operations.push({ op: 'add', path: joinPath(path, key), value: cloneComparableJsonValue(right[key]) });
                }
            }
            for (const key of Object.keys(right)) {
                if (Object.hasOwn(left, key)) {
                    walk(left[key], right[key], joinPath(path, key));
                }
            }
            return;
        }

        operations.push({ op: 'replace', path, value: cloneComparableJsonValue(right) });
    };

    walk(leftRoot, rightRoot, '');
    return operations;
}

/**
 * fast-json-patch compatible applyPatch subset.
 * Supports add/remove/replace/test operations and returns { newDocument } metadata.
 */
export function applyPatch(document, patch, validateOperation = true, mutateDocument = false) {
    if (!Array.isArray(patch)) {
        throw new Error('JSON Patch document must be an array.');
    }

    let nextDocument = mutateDocument ? document : cloneJsonValue(document);
    const results = [];

    for (const rawOperation of patch) {
        if (!rawOperation || typeof rawOperation !== 'object') {
            throw new Error('JSON Patch operation must be an object.');
        }
        const op = String(rawOperation.op || '').trim().toLowerCase();
        const path = rawOperation.path;
        const segments = parsePath(path);

        if (validateOperation && !op) {
            throw new Error('JSON Patch operation is missing op.');
        }

        if (op === 'add') {
            if (!Object.hasOwn(rawOperation, 'value')) {
                throw new Error('JSON Patch add operation requires value.');
            }
            nextDocument = applyAdd(nextDocument, segments, rawOperation.value);
            results.push({ newDocument: nextDocument });
            continue;
        }

        if (op === 'replace') {
            if (!Object.hasOwn(rawOperation, 'value')) {
                throw new Error('JSON Patch replace operation requires value.');
            }
            nextDocument = applyReplace(nextDocument, segments, rawOperation.value);
            results.push({ newDocument: nextDocument });
            continue;
        }

        if (op === 'remove') {
            nextDocument = applyRemove(nextDocument, segments);
            results.push({ newDocument: nextDocument });
            continue;
        }

        if (op === 'test') {
            const { container, key } = getContainerAndKey(nextDocument, segments);
            const currentValue = segments.length === 0
                ? nextDocument
                : (Array.isArray(container)
                    ? container[normalizeArrayIndex(key, container.length)]
                    : container?.[key]);
            const passed = isSameJsonValue(currentValue, rawOperation.value);
            if (!passed) {
                throw new Error(`JSON Patch test failed at path ${String(path)}`);
            }
            results.push({ test: true, newDocument: nextDocument });
            continue;
        }

        throw new Error(`Unsupported JSON Patch operation: ${op}`);
    }

    results.newDocument = nextDocument;
    return results;
}
