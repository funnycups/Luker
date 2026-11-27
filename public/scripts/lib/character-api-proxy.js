// SPDX-License-Identifier: AGPL-3.0-or-later

import { t } from '../i18n.js';

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// Extension-facing character compatibility layer:
// keep getContext().characters usable for legacy root-field reads/writes while routing data through V2-shaped fields.
export const CHARACTER_API_PROXY_TARGET = Symbol.for('luker.characterApiProxyTarget');
const characterApiProxyTargetMap = new WeakMap();
const characterApiArrayProxyCache = new WeakMap();
const characterApiProxyCache = new WeakMap();
const characterApiDataProxyCache = new WeakMap();
const characterApiExtensionsProxyCache = new WeakMap();
const legacyCharacterWriteWarningKeys = new Set();

function rememberCharacterApiProxy(proxy, target) {
    characterApiProxyTargetMap.set(proxy, target);
    return proxy;
}

export function unwrapCharacterApiProxy(value) {
    return characterApiProxyTargetMap.get(value) ?? value;
}

function normalizeCharacterTextField(value) {
    return String(value ?? '');
}

function normalizeCharacterTagsField(value) {
    if (Array.isArray(value)) {
        return value
            .map(tag => String(tag ?? '').trim())
            .filter(Boolean);
    }

    if (typeof value === 'string') {
        return value
            .split(',')
            .map(tag => tag.trim())
            .filter(Boolean);
    }

    return [];
}

function normalizeCharacterTalkativenessField(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0.5;
}

function normalizeCharacterFavField(value) {
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false' || normalizedValue === '') {
            return false;
        }
    }

    return Boolean(value);
}

function ensureCharacterDataObject(character) {
    if (!isPlainObject(character?.data)) {
        character.data = {};
    }

    return character.data;
}

function ensureCharacterExtensionsObject(character) {
    const data = ensureCharacterDataObject(character);
    if (!isPlainObject(data.extensions)) {
        data.extensions = {};
    }

    return data.extensions;
}

const legacyCharacterRootFieldSpecs = Object.freeze({
    name: {
        canonicalPath: 'data.name',
        read: character => character?.data?.name ?? character?.name ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).name = normalized;
            character.name = normalized;
        },
    },
    description: {
        canonicalPath: 'data.description',
        read: character => character?.data?.description ?? character?.description ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).description = normalized;
            character.description = normalized;
        },
    },
    personality: {
        canonicalPath: 'data.personality',
        read: character => character?.data?.personality ?? character?.personality ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).personality = normalized;
            character.personality = normalized;
        },
    },
    scenario: {
        canonicalPath: 'data.scenario',
        read: character => character?.data?.scenario ?? character?.scenario ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).scenario = normalized;
            character.scenario = normalized;
        },
    },
    first_mes: {
        canonicalPath: 'data.first_mes',
        read: character => character?.data?.first_mes ?? character?.first_mes ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).first_mes = normalized;
            character.first_mes = normalized;
        },
    },
    mes_example: {
        canonicalPath: 'data.mes_example',
        read: character => character?.data?.mes_example ?? character?.mes_example ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).mes_example = normalized;
            character.mes_example = normalized;
        },
    },
    creatorcomment: {
        canonicalPath: 'data.creator_notes',
        read: character => character?.data?.creator_notes ?? character?.creatorcomment ?? '',
        write: (character, value) => {
            const normalized = normalizeCharacterTextField(value);
            ensureCharacterDataObject(character).creator_notes = normalized;
            character.creatorcomment = normalized;
        },
    },
    tags: {
        canonicalPath: 'data.tags',
        read: (character) => {
            if (Array.isArray(character?.data?.tags)) {
                character.tags = character.data.tags;
                return character.data.tags;
            }

            return character?.tags ?? [];
        },
        write: (character, value) => {
            const normalized = normalizeCharacterTagsField(value);
            ensureCharacterDataObject(character).tags = normalized;
            character.tags = normalized;
        },
    },
    talkativeness: {
        canonicalPath: 'data.extensions.talkativeness',
        read: character => character?.data?.extensions?.talkativeness ?? character?.talkativeness ?? 0.5,
        write: (character, value) => {
            const normalized = normalizeCharacterTalkativenessField(value);
            ensureCharacterExtensionsObject(character).talkativeness = normalized;
            character.talkativeness = normalized;
        },
    },
    fav: {
        canonicalPath: 'data.extensions.fav',
        read: character => character?.data?.extensions?.fav ?? character?.fav ?? false,
        write: (character, value) => {
            const normalized = normalizeCharacterFavField(value);
            ensureCharacterExtensionsObject(character).fav = normalized;
            character.fav = normalized;
        },
    },
});

const characterDataMirrorSpecs = Object.freeze({
    name: {
        rootField: 'name',
        normalize: normalizeCharacterTextField,
    },
    description: {
        rootField: 'description',
        normalize: normalizeCharacterTextField,
    },
    personality: {
        rootField: 'personality',
        normalize: normalizeCharacterTextField,
    },
    scenario: {
        rootField: 'scenario',
        normalize: normalizeCharacterTextField,
    },
    first_mes: {
        rootField: 'first_mes',
        normalize: normalizeCharacterTextField,
    },
    mes_example: {
        rootField: 'mes_example',
        normalize: normalizeCharacterTextField,
    },
    creator_notes: {
        rootField: 'creatorcomment',
        normalize: normalizeCharacterTextField,
    },
    tags: {
        rootField: 'tags',
        normalize: normalizeCharacterTagsField,
    },
});

const characterExtensionsMirrorSpecs = Object.freeze({
    talkativeness: {
        rootField: 'talkativeness',
        normalize: normalizeCharacterTalkativenessField,
    },
    fav: {
        rootField: 'fav',
        normalize: normalizeCharacterFavField,
    },
});

function syncCharacterRootFieldFromData(character, field) {
    const spec = characterDataMirrorSpecs[field];
    if (!spec) {
        return;
    }

    const data = ensureCharacterDataObject(character);
    if (!Object.prototype.hasOwnProperty.call(data, field)) {
        return;
    }

    const normalized = spec.normalize(data[field]);
    data[field] = normalized;
    character[spec.rootField] = normalized;
}

function syncCharacterRootFieldFromExtensions(character, field) {
    const spec = characterExtensionsMirrorSpecs[field];
    if (!spec) {
        return;
    }

    const extensions = ensureCharacterExtensionsObject(character);
    if (!Object.prototype.hasOwnProperty.call(extensions, field)) {
        return;
    }

    const normalized = spec.normalize(extensions[field]);
    extensions[field] = normalized;
    character[spec.rootField] = normalized;
}

function syncCharacterMirrorsFromData(character) {
    const data = ensureCharacterDataObject(character);
    for (const field of Object.keys(characterDataMirrorSpecs)) {
        if (Object.prototype.hasOwnProperty.call(data, field)) {
            syncCharacterRootFieldFromData(character, field);
        }
    }
}

function syncCharacterMirrorsFromExtensions(character) {
    const extensions = ensureCharacterExtensionsObject(character);
    for (const field of Object.keys(characterExtensionsMirrorSpecs)) {
        if (Object.prototype.hasOwnProperty.call(extensions, field)) {
            syncCharacterRootFieldFromExtensions(character, field);
        }
    }
}

function warnLegacyCharacterRootWrite(field, canonicalPath) {
    const warningKey = `legacy-character-root-write:${field}`;
    if (!legacyCharacterWriteWarningKeys.has(warningKey)) {
        console.warn(`Deprecated extension character write: root field "${field}" was written through Luker.getContext().characters. Write to "${canonicalPath}" instead.`);
        legacyCharacterWriteWarningKeys.add(warningKey);
    }

    const toastKey = 'legacy-character-root-write:toast';
    if (!legacyCharacterWriteWarningKeys.has(toastKey)) {
        globalThis.toastr?.warning(
            t`An extension wrote deprecated root character fields. The change was applied, but extensions should write to data.* / data.extensions.* instead.`,
            t`Deprecated character API write`,
            { preventDuplicates: true, timeOut: 8000 },
        );
        legacyCharacterWriteWarningKeys.add(toastKey);
    }
}

function isArrayIndexProperty(prop) {
    if (typeof prop !== 'string') {
        return false;
    }

    const numericIndex = Number(prop);
    return Number.isInteger(numericIndex) && numericIndex >= 0 && String(numericIndex) === prop;
}

function getCharacterApiExtensionsProxy(character) {
    const extensions = ensureCharacterExtensionsObject(character);
    const cachedProxy = characterApiExtensionsProxyCache.get(extensions);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(extensions, {
        get(target, prop, receiver) {
            if (prop === CHARACTER_API_PROXY_TARGET) {
                return target;
            }
            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop]) {
                const normalized = characterExtensionsMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(value));
                const result = Reflect.set(target, prop, normalized, receiver);
                character[characterExtensionsMirrorSpecs[prop].rootField] = normalized;
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                const normalized = characterExtensionsMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(descriptor.value));
                target[prop] = normalized;
                character[characterExtensionsMirrorSpecs[prop].rootField] = normalized;
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && characterExtensionsMirrorSpecs[prop]) {
                delete character[characterExtensionsMirrorSpecs[prop].rootField];
            }
            return Reflect.deleteProperty(target, prop);
        },
    }), extensions);

    characterApiExtensionsProxyCache.set(extensions, proxy);
    return proxy;
}

function getCharacterApiDataProxy(character) {
    const data = ensureCharacterDataObject(character);
    const cachedProxy = characterApiDataProxyCache.get(data);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(data, {
        get(target, prop, receiver) {
            if (prop === CHARACTER_API_PROXY_TARGET) {
                return target;
            }

            if (prop === 'extensions') {
                return getCharacterApiExtensionsProxy(character);
            }

            if (prop === 'tags' && Array.isArray(target.tags)) {
                character.tags = target.tags;
                return target.tags;
            }

            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop]) {
                const normalized = characterDataMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(value));
                const result = Reflect.set(target, prop, normalized, receiver);
                character[characterDataMirrorSpecs[prop].rootField] = normalized;
                return result;
            }

            if (prop === 'extensions') {
                const nextValue = isPlainObject(unwrapCharacterApiProxy(value)) ? unwrapCharacterApiProxy(value) : {};
                const result = Reflect.set(target, prop, nextValue, receiver);
                syncCharacterMirrorsFromExtensions(character);
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                const normalized = characterDataMirrorSpecs[prop].normalize(unwrapCharacterApiProxy(descriptor.value));
                target[prop] = normalized;
                character[characterDataMirrorSpecs[prop].rootField] = normalized;
                return true;
            }

            if (prop === 'extensions' && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                target.extensions = isPlainObject(unwrapCharacterApiProxy(descriptor.value)) ? unwrapCharacterApiProxy(descriptor.value) : {};
                syncCharacterMirrorsFromExtensions(character);
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && characterDataMirrorSpecs[prop]) {
                delete character[characterDataMirrorSpecs[prop].rootField];
            }
            return Reflect.deleteProperty(target, prop);
        },
        ownKeys(target) {
            const keys = new Set(Reflect.ownKeys(target));
            keys.add('extensions');
            return [...keys];
        },
        getOwnPropertyDescriptor(target, prop) {
            if (prop === 'extensions') {
                return {
                    configurable: true,
                    enumerable: true,
                    value: getCharacterApiExtensionsProxy(character),
                    writable: true,
                };
            }

            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    }), data);

    characterApiDataProxyCache.set(data, proxy);
    return proxy;
}

export function getCharacterApiProxy(character) {
    if (!isPlainObject(character)) {
        return character;
    }

    const cachedProxy = characterApiProxyCache.get(character);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(character, {
        get(target, prop, receiver) {
            if (prop === CHARACTER_API_PROXY_TARGET) {
                return target;
            }

            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return legacyCharacterRootFieldSpecs[prop].read(target);
            }

            if (prop === 'data') {
                return getCharacterApiDataProxy(target);
            }

            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                legacyCharacterRootFieldSpecs[prop].write(target, unwrapCharacterApiProxy(value));
                warnLegacyCharacterRootWrite(prop, legacyCharacterRootFieldSpecs[prop].canonicalPath);
                return true;
            }

            if (prop === 'data') {
                const nextValue = isPlainObject(unwrapCharacterApiProxy(value)) ? unwrapCharacterApiProxy(value) : {};
                const result = Reflect.set(target, prop, nextValue, receiver);
                syncCharacterMirrorsFromData(target);
                syncCharacterMirrorsFromExtensions(target);
                return result;
            }

            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
        defineProperty(target, prop, descriptor) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop] && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                legacyCharacterRootFieldSpecs[prop].write(target, unwrapCharacterApiProxy(descriptor.value));
                warnLegacyCharacterRootWrite(prop, legacyCharacterRootFieldSpecs[prop].canonicalPath);
                return true;
            }

            if (prop === 'data' && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
                target.data = isPlainObject(unwrapCharacterApiProxy(descriptor.value)) ? unwrapCharacterApiProxy(descriptor.value) : {};
                syncCharacterMirrorsFromData(target);
                syncCharacterMirrorsFromExtensions(target);
                return true;
            }

            return Reflect.defineProperty(target, prop, descriptor);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                delete target[prop];
                return true;
            }

            return Reflect.deleteProperty(target, prop);
        },
        has(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return true;
            }

            if (prop === 'data') {
                return true;
            }

            return Reflect.has(target, prop);
        },
        ownKeys(target) {
            const keys = new Set(Reflect.ownKeys(target));
            keys.add('data');
            for (const field of Object.keys(legacyCharacterRootFieldSpecs)) {
                keys.add(field);
            }
            return [...keys];
        },
        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string' && legacyCharacterRootFieldSpecs[prop]) {
                return {
                    configurable: true,
                    enumerable: true,
                    value: legacyCharacterRootFieldSpecs[prop].read(target),
                    writable: true,
                };
            }

            if (prop === 'data') {
                return {
                    configurable: true,
                    enumerable: true,
                    value: getCharacterApiDataProxy(target),
                    writable: true,
                };
            }

            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    }), character);

    characterApiProxyCache.set(character, proxy);
    return proxy;
}

export function getCharacterArrayApiProxy(characterList) {
    if (!Array.isArray(characterList)) {
        return characterList;
    }

    const cachedProxy = characterApiArrayProxyCache.get(characterList);
    if (cachedProxy) {
        return cachedProxy;
    }

    const proxy = rememberCharacterApiProxy(new Proxy(characterList, {
        get(target, prop, receiver) {
            if (prop === CHARACTER_API_PROXY_TARGET) {
                return target;
            }
            if (prop === 'indexOf') {
                return (...args) => target.indexOf(unwrapCharacterApiProxy(args[0]), ...args.slice(1));
            }
            if (prop === 'lastIndexOf') {
                return (...args) => (args.length > 1
                    ? target.lastIndexOf(unwrapCharacterApiProxy(args[0]), args[1])
                    : target.lastIndexOf(unwrapCharacterApiProxy(args[0])));
            }
            if (prop === 'includes') {
                return (...args) => target.includes(unwrapCharacterApiProxy(args[0]), ...args.slice(1));
            }

            const value = Reflect.get(target, prop, receiver);
            if (isArrayIndexProperty(prop)) {
                return getCharacterApiProxy(value);
            }

            return value;
        },
        set(target, prop, value, receiver) {
            return Reflect.set(target, prop, unwrapCharacterApiProxy(value), receiver);
        },
    }), characterList);

    characterApiArrayProxyCache.set(characterList, proxy);
    return proxy;
}

