import { lodash } from '../../lib.js';

// Tokens contain no payload or predecessor references. A captured row and its
// acknowledged successors share an identity; unrelated replacements do not.
export function createPresetLineage() {
    const identities = new WeakMap();
    return {
        capture(value) {
            if (!identities.has(value)) identities.set(value, {});
            return identities.get(value);
        },
        owns(value, identity) { return identities.get(value) === identity; },
        acknowledge(value, identity) { identities.set(value, identity); },
    };
}

const ABSENT = Symbol('absent');
const object = value => value !== ABSENT && value !== null && typeof value === 'object' && !Array.isArray(value);

/** Three-way conditional mutation. Arrays are atomic values, including inserts. */
export function preparePresetMutation(before, desired, current, { ownedPath = null, ownedValue, acknowledged = false, normalize = structuredClone } = {}) {
    // Match lodash.set's captured string-key resolution, not a key that a
    // competing live edit could add later. Array-form paths always stay paths.
    const extensionPath = typeof ownedPath === 'string' && ownedPath !== '' && Object.hasOwn(desired?.extensions ?? {}, ownedPath)
        ? [ownedPath] : lodash.toPath(ownedPath);
    // The public root string replaces extensions; an empty array owns no field.
    const reserved = ownedPath === '' || extensionPath.length ? ['extensions', ...extensionPath] : null;
    if (reserved?.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid preset extension path');
    // Materialize the explicit operation before comparison. This also prepares
    // a complete intended array for indexed lodash paths; arrays never recurse.
    const materialized = structuredClone(desired);
    if (reserved) lodash.set(materialized, reserved, structuredClone(ownedValue));
    const intended = normalize(materialized);
    const read = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : ABSENT;
    const merge = (old, next, live, path) => {
        const owns = reserved && lodash.isEqual(path, reserved);
        const containsOwned = reserved && path.length < reserved.length && reserved.slice(0, path.length).every((key, i) => key === path[i]);
        // An explicit same-value operation still has a source expectation.
        // Only unrelated unchanged subtrees may bypass the conditional checks.
        if (!owns && !containsOwned && lodash.isEqual(old, next)) return live;
        if (lodash.isEqual(live, old)) return next;
        if (acknowledged && lodash.isEqual(live, next)) return live;
        // The owned node is an intentional replacement, even for objects.
        // Ancestor objects recurse to isolate disjoint siblings. Arrays remain
        // atomic so a concurrent insertion cannot redirect an indexed write.
        if (!owns && object(next) && (object(old) && object(live) || containsOwned && (old === ABSENT || object(old)) && (live === ABSENT || object(live)))) {
            const result = live === ABSENT ? {} : structuredClone(live);
            const keys = new Set([...Object.keys(old === ABSENT ? {} : old), ...Object.keys(next)]);
            if (containsOwned) keys.add(reserved[path.length]);
            for (const key of keys) {
                const value = merge(read(old, key), read(next, key), read(live, key), [...path, key]);
                if (value === ABSENT) delete result[key];
                else Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
            }
            return result;
        }
        throw new Error(`Character-bound preset source conflict at /${path.join('/')}`);
    };
    return merge(before, intended, current, []);
}
