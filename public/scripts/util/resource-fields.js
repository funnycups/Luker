/**
 * Pure helpers for the settings field directory and field assembly.
 *
 * The directory is derived from one source object. Values are leaf JSON
 * values addressed by RFC 6901 pointers. Every root property is a leaf,
 * except `extension_settings`, whose immediate namespaces are each one leaf.
 */

const EXTENSION_SETTINGS = 'extension_settings';

export function escapeResourcePointerSegment(segment) {
    return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

export function decodeResourcePointer(pointer) {
    const raw = String(pointer ?? '');
    if (raw === '') {
        return [];
    }
    if (!raw.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer: ${raw}`);
    }
    return raw.slice(1).split('/').map((segment) => {
        if (/~(?![01])/.test(segment)) {
            throw new Error(`Invalid JSON Pointer escape: ${raw}`);
        }
        return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function pointerFor(segments) {
    return segments.map((segment) => `/${escapeResourcePointerSegment(segment)}`).join('');
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * @param {unknown} document
 * @returns {{containers: {path: string, keys: string[]}[], values: Map<string, unknown>}}
 */
export function buildSettingsFieldStructure(document) {
    if (!isPlainObject(document)) {
        throw new Error('Settings document root must be an object.');
    }

    const containers = [];
    const values = new Map();

    if (!isPlainObject(document[EXTENSION_SETTINGS])) {
        containers.push({ path: '', keys: Object.keys(document) });
        for (const key of Object.keys(document)) {
            values.set(pointerFor([key]), document[key]);
        }
        return { containers, values };
    }

    containers.push({ path: '', keys: Object.keys(document) });
    containers.push({ path: `/${EXTENSION_SETTINGS}`, keys: Object.keys(document[EXTENSION_SETTINGS]) });

    for (const key of Object.keys(document)) {
        if (key === EXTENSION_SETTINGS) {
            continue;
        }
        values.set(pointerFor([key]), document[key]);
    }

    const extensions = document[EXTENSION_SETTINGS];
    for (const namespace of Object.keys(extensions)) {
        values.set(pointerFor([EXTENSION_SETTINGS, namespace]), extensions[namespace]);
    }

    return { containers, values };
}

function defineOwn(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
    });
}

function objectAt(root, segments) {
    let current = root;
    for (const segment of segments) {
        if (!isPlainObject(current[segment])) {
            defineOwn(current, segment, {});
        }
        current = current[segment];
    }
    return current;
}

/**
 * Reconstructs an object from a directory and its field values. The old
 * working object is never used as a fallback, so deleted fields stay deleted.
 */
export function assembleJsonFields(directory, values) {
    const containers = Array.isArray(directory?.containers) ? directory.containers : [];
    const fields = Array.isArray(directory?.fields) ? directory.fields : [];
    const root = {};

    for (const container of containers) {
        const segments = decodeResourcePointer(container?.path);
        const target = segments.length === 0 ? root : objectAt(root, segments);
        const keys = Array.isArray(container?.keys) ? container.keys : [];
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(target, key)) {
                defineOwn(target, key, {});
            }
        }
    }

    for (const field of fields) {
        const segments = decodeResourcePointer(field?.path);
        if (segments.length === 0) {
            throw new Error('A field cannot replace the document root.');
        }
        if (!values?.has(field.path)) {
            throw new Error(`Missing field value: ${field.path}`);
        }
        const parent = objectAt(root, segments.slice(0, -1));
        defineOwn(parent, segments[segments.length - 1], values.get(field.path));
    }

    return root;
}
