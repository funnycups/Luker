// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure serialized coordinator for character extension-field writes
 * (`writeExtensionField` and `writeExtensionFieldBulk`).
 *
 * Guarantees:
 *   - Per-(character, key) serialized persists and read/modify/write callbacks.
 *   - Ownership tokens tied to live character object identity (`WeakMap`),
 *     so index shifts publish safely while replaced/removed cards are skipped.
 *   - Bulk updates drain all queued single persists for targeted cards before
 *     issuing the bulk request, and still publish their acknowledged baseline
 *     when a newer single write queues behind them.
 */

export const UNSET_VALUE = '__@@UNSET@@__';

export function stripUnsetSentinels(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
        return node.map(item => stripUnsetSentinels(item));
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (v === UNSET_VALUE) continue;
        out[k] = stripUnsetSentinels(v);
    }
    return out;
}

function isCharacterPresent(context, character) {
    return Boolean(character) && Array.isArray(context?.characters) && context.characters.includes(character);
}

/**
 * @param {object} deps
 * @param {() => { characters: any[], characterId?: number, menuType?: string }} deps.getContext
 * @param {() => Record<string, string>} deps.getRequestHeaders
 * @param {(value: any) => any} deps.cloneAsJsonWire
 * @param {(obj: object, path: string, value: any) => void} deps.setValueByPath
 * @param {(obj: object, path: string) => void} deps.deleteValueByPath
 * @param {(jsonData: string) => void} [deps.syncActiveCharacterJsonData]
 */
export function createExtensionFieldWriter({
    getContext,
    getRequestHeaders,
    cloneAsJsonWire,
    setValueByPath,
    deleteValueByPath,
    syncActiveCharacterJsonData = () => {},
}) {
    const extensionFieldWrites = new WeakMap();
    const extensionFieldMutations = new WeakMap();
    const extensionFieldPersists = new WeakMap();
    const extensionFieldPersistTokens = new WeakMap();

    async function enqueueExtensionFieldPersist(persists, persistTokens, key, run) {
        const previous = persists.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => {
            const persistToken = {};
            persistTokens.set(key, persistToken);
            return run(persistToken);
        });
        persists.set(key, next);
        try { return await next; } finally { if (persists.get(key) === next) persists.delete(key); }
    }

    async function persistExtensionField(characterId, character, key, value, writes, token, previous, { isCurrent, ifMatch, onAcknowledged, requireSaved = false, isWriteOwned = () => writes.get(key) === token }) {
        const summary = Array.isArray(value)
            ? {
                kind: 'array',
                length: value.length,
                sampleIds: value.slice(0, 5).map(item => String(item?.id || '')),
                serializedLength: JSON.stringify(value).length,
            }
            : {
                kind: typeof value,
                serializedLength: JSON.stringify(value ?? null).length,
            };

        const extensionPath = `data.extensions.${key}`;
        const isUnset = value === UNSET_VALUE;
        console.info('[Extensions] writeExtensionField requested', {
            characterId,
            contextCharacterId: getContext().characterId,
            avatar: character.avatar || null,
            key,
            path: extensionPath,
            hasJsonData: Boolean(character.json_data),
            valueSummary: summary,
            isUnset,
        });

        const saveDataRequest = {
            avatar: character.avatar,
            data: {
                extensions: {
                    [key]: value,
                },
            },
            replacePaths: [`data.extensions.${key}`],
        };
        if (ifMatch !== undefined) saveDataRequest.ifMatch = ifMatch;

        const body = JSON.stringify(saveDataRequest);
        const parsedWrittenValue = JSON.parse(body).data.extensions[key];
        const writtenValue = !isUnset && parsedWrittenValue && typeof parsedWrittenValue === 'object'
            ? stripUnsetSentinels(parsedWrittenValue)
            : parsedWrittenValue;
        const mergeResponse = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
        });

        console.info('[Extensions] writeExtensionField merge response', {
            characterId,
            avatar: character.avatar || null,
            key,
            status: mergeResponse.status,
            ok: mergeResponse.ok,
            statusText: mergeResponse.statusText,
        });

        if (!mergeResponse.ok) {
            if (requireSaved) {
                throw new Error(`Failed to save extension field (${mergeResponse.status}): ${mergeResponse.statusText}`);
            }
            console.error('Failed to save extension field', mergeResponse.statusText);
            return false;
        }
        if (!isCurrent()) return false;

        const live = getContext();
        if (isWriteOwned() && isCharacterPresent(live, character) && JSON.stringify(character.data?.extensions?.[key]) === previous) {
            if (isUnset) deleteValueByPath(character, extensionPath);
            else setValueByPath(character, extensionPath, writtenValue);
            if (character.json_data) {
                const jsonData = JSON.parse(character.json_data);
                if (isUnset) deleteValueByPath(jsonData, extensionPath);
                else setValueByPath(jsonData, extensionPath, writtenValue);
                character.json_data = JSON.stringify(jsonData);
                if (character.avatar && live.characters[live.characterId] === character && live.menuType !== 'create') {
                    syncActiveCharacterJsonData(character.json_data);
                }
            }
            onAcknowledged?.(mergeResponse);
        }
        return mergeResponse.ok;
    }

    async function writeExtensionField(characterId, key, value, { isCurrent = () => true, ifMatch, onAcknowledged, requireSaved = false } = {}) {
        const context = getContext();
        const character = context.characters[characterId];
        if (!character) {
            if (requireSaved) throw new Error('Character not found');
            console.warn('Character not found', characterId);
            return false;
        }
        const writes = extensionFieldWrites.get(character) || new Map();
        extensionFieldWrites.set(character, writes);
        const persists = extensionFieldPersists.get(character) || new Map();
        extensionFieldPersists.set(character, persists);
        const persistTokens = extensionFieldPersistTokens.get(character) || new Map();
        extensionFieldPersistTokens.set(character, persistTokens);

        if (typeof value === 'function') {
            const queues = extensionFieldMutations.get(character) || new Map();
            extensionFieldMutations.set(character, queues);
            const previous = queues.get(key) || Promise.resolve();
            const next = previous.catch(() => {}).then(async () => {
                while (persists.has(key)) {
                    await persists.get(key).catch(() => {});
                }
                if (!isCharacterPresent(getContext(), character) || !isCurrent()) return false;
                const current = character.data?.extensions?.[key];
                const source = JSON.stringify(current);
                const token = {};
                writes.set(key, token);
                const replacement = await value(cloneAsJsonWire(current));
                if (!isCharacterPresent(getContext(), character) || writes.get(key) !== token || JSON.stringify(character.data?.extensions?.[key]) !== source || !isCurrent()) return false;
                return enqueueExtensionFieldPersist(persists, persistTokens, key, persistToken =>
                    persistExtensionField(characterId, character, key, replacement, writes, token, source, {
                        isCurrent,
                        ifMatch,
                        onAcknowledged,
                        requireSaved,
                        isWriteOwned: () => persistTokens.get(key) === persistToken,
                    }),
                );
            });
            queues.set(key, next);
            try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
        }

        if (!isCurrent()) return false;
        const token = {};
        writes.set(key, token);
        return enqueueExtensionFieldPersist(persists, persistTokens, key, persistToken => {
            if (!isCharacterPresent(getContext(), character) || !isCurrent()) return false;
            return persistExtensionField(characterId, character, key, value, writes, token, JSON.stringify(character.data?.extensions?.[key]), {
                isCurrent,
                ifMatch,
                onAcknowledged,
                requireSaved,
                isWriteOwned: () => persistTokens.get(key) === persistToken,
            });
        });
    }

    async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
        const extensionPath = `data.extensions.${key}`;
        const isUnset = value === UNSET_VALUE;
        const avatarList = Array.isArray(avatars) && avatars.length > 0 ? avatars : [];
        const avatarFilter = avatarList.length > 0 ? new Set(avatarList) : null;

        const requestBody = {
            avatars: avatarList,
            data: {
                data: {
                    extensions: {
                        [key]: value,
                    },
                },
            },
            replacePaths: [`data.extensions.${key}`],
        };

        const resolvedFilterPath = filterPath ?? (isUnset ? extensionPath : undefined);
        if (resolvedFilterPath) {
            requestBody.filter = { path: resolvedFilterPath };
        }

        const body = JSON.stringify(requestBody);
        const parsedWrittenValue = JSON.parse(body).data.data.extensions[key];
        const writtenValue = !isUnset && parsedWrittenValue && typeof parsedWrittenValue === 'object'
            ? stripUnsetSentinels(parsedWrittenValue)
            : parsedWrittenValue;

        while (true) {
            const currentContext = getContext();
            const currentChars = (Array.isArray(currentContext.characters) ? currentContext.characters : [])
                .filter(character => character && (!avatarFilter || avatarFilter.has(character.avatar)));
            const priorPersists = [];
            for (const character of currentChars) {
                const persists = extensionFieldPersists.get(character);
                if (persists?.has(key)) priorPersists.push(persists.get(key));
            }
            if (priorPersists.length === 0) break;
            await Promise.allSettled(priorPersists);
        }

        const bulkToken = {};
        let resolveBulkDone;
        const bulkDone = new Promise(resolve => { resolveBulkDone = resolve; });
        const trackedChars = [];
        const trackedSet = new Set();
        const preFetchContext = getContext();
        for (const character of (Array.isArray(preFetchContext.characters) ? preFetchContext.characters : [])) {
            if (!character || (avatarFilter && !avatarFilter.has(character.avatar))) continue;
            let writes = extensionFieldWrites.get(character);
            if (!writes) extensionFieldWrites.set(character, writes = new Map());
            let persists = extensionFieldPersists.get(character);
            if (!persists) extensionFieldPersists.set(character, persists = new Map());
            let persistTokens = extensionFieldPersistTokens.get(character);
            if (!persistTokens) extensionFieldPersistTokens.set(character, persistTokens = new Map());
            writes.set(key, bulkToken);
            persistTokens.set(key, bulkToken);
            persists.set(key, bulkDone);
            trackedChars.push({ character, persists });
            trackedSet.add(character);
        }

        try {
            const mergeResponse = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body,
            });

            if (!mergeResponse.ok) {
                console.error('Bulk extension field update failed', mergeResponse.statusText);
                throw new Error(`Bulk extension field update failed: ${mergeResponse.status} ${mergeResponse.statusText}`);
            }

            const result = await mergeResponse.json();

            const live = getContext();
            const updatedSet = new Set(result.updated);
            const locallyUpdated = new Set();
            for (const character of (Array.isArray(live.characters) ? live.characters : [])) {
                if (!character || !updatedSet.has(character.avatar)) continue;
                const writes = extensionFieldWrites.get(character);
                const persistTokens = extensionFieldPersistTokens.get(character);
                if (trackedSet.has(character)) {
                    if (persistTokens?.get(key) !== bulkToken) continue;
                } else if (writes?.has(key) || persistTokens?.has(key)) {
                    continue;
                }

                const perCharacterValue = !isUnset && writtenValue && typeof writtenValue === 'object'
                    ? structuredClone(writtenValue)
                    : writtenValue;

                if (isUnset) {
                    deleteValueByPath(character, extensionPath);
                } else {
                    setValueByPath(character, extensionPath, perCharacterValue);
                }

                if (character.json_data) {
                    const jsonData = JSON.parse(character.json_data);
                    if (isUnset) {
                        deleteValueByPath(jsonData, extensionPath);
                    } else {
                        setValueByPath(jsonData, extensionPath, structuredClone(perCharacterValue));
                    }
                    character.json_data = JSON.stringify(jsonData);
                }
                locallyUpdated.add(character);
            }

            if (live.characterId !== undefined && live.menuType !== 'create') {
                const activeChar = live.characters[live.characterId];
                if (activeChar && locallyUpdated.has(activeChar) && activeChar.json_data) {
                    syncActiveCharacterJsonData(activeChar.json_data);
                }
            }

            return result;
        } finally {
            for (const { persists } of trackedChars) {
                if (persists.get(key) === bulkDone) persists.delete(key);
            }
            resolveBulkDone();
        }
    }

    return {
        writeExtensionField,
        writeExtensionFieldBulk,
    };
}
