/**
 * Ownership and persistence controller for character-card shared image prompts (`sd_character_prompt`).
 *
 * Keeps card-write ownership bound to the live character object and a monotonic per-character
 * sequence number so debounced edits, unshares, character switches, reindexing, and list
 * replacements cannot republish stale state or mutate another selected avatar's controls.
 */

/**
 * Returns true when a character card currently holds an acknowledged shared prompt object.
 * Always returns a strict boolean so jQuery `.prop('checked', ...)` never receives `undefined`.
 * @param {object | null | undefined} character
 * @returns {boolean}
 */
export function hasSharedCharacterPrompt(character) {
    const shared = character?.data?.extensions?.sd_character_prompt;
    return Boolean(shared && typeof shared === 'object');
}

/**
 * @param {object} deps
 * @param {() => Array<object>} deps.getCharacters Returns the live character list
 * @param {() => { characterId: number | null, character: object | null, isGroup: boolean }} deps.getSelection Returns current selection
 * @param {(characterId: number, key: string, value: any, options?: { isCurrent?: () => boolean }) => Promise<boolean>} deps.writeExtensionField
 * @param {number} deps.debounceMs Debounce delay for shared prompt text updates
 * @param {(checked: boolean) => void} deps.setShareChecked Updates the share checkbox in the UI
 * @param {(intent: 'share' | 'unshare' | 'update', details: { character: object, error?: unknown }) => void} deps.onFailure Reports failed persistence
 * @param {(fn: () => void, ms: number) => any} [deps.scheduleTimer]
 * @param {(id: any) => void} [deps.cancelTimer]
 */
export function createCharacterPromptShareController({
    getCharacters,
    getSelection,
    writeExtensionField,
    debounceMs,
    setShareChecked,
    onFailure,
    scheduleTimer = (fn, ms) => setTimeout(fn, ms),
    cancelTimer = (id) => clearTimeout(id),
}) {
    /** @type {WeakMap<object, { seq: number, pendingTimer: any }>} */
    const opsByCharacter = new WeakMap();

    function getState(character) {
        let state = opsByCharacter.get(character);
        if (!state) {
            state = { seq: 0, pendingTimer: null };
            opsByCharacter.set(character, state);
        }
        return state;
    }

    function cancelPendingTimer(character) {
        if (!character) {
            return;
        }
        const state = opsByCharacter.get(character);
        if (state?.pendingTimer !== null && state?.pendingTimer !== undefined) {
            cancelTimer(state.pendingTimer);
            state.pendingTimer = null;
        }
    }

    function resolveTarget(character, preferredId) {
        const list = getCharacters();
        if (!Array.isArray(list) || !character) {
            return null;
        }
        if (Number.isInteger(preferredId) && list[preferredId] === character) {
            return { characterId: preferredId, character };
        }
        const reindexed = list.indexOf(character);
        if (reindexed !== -1) {
            return { characterId: reindexed, character };
        }
        return null;
    }

    function isCharacterSelected(character) {
        const selection = getSelection();
        return Boolean(selection && !selection.isGroup && selection.character && selection.character === character);
    }

    function syncControlIfSelected(character) {
        if (isCharacterSelected(character)) {
            setShareChecked(hasSharedCharacterPrompt(character));
        }
    }

    async function persist({ character, preferredId, seq, value, intent }) {
        const state = getState(character);
        if (state.seq !== seq) {
            return false;
        }

        const target = resolveTarget(character, preferredId);
        if (!target) {
            if (state.seq === seq) {
                syncControlIfSelected(character);
                onFailure(intent, { character, error: new Error('Target character is no longer loaded.') });
            }
            return false;
        }

        const isStillOwned = () => {
            if (state.seq !== seq) {
                return false;
            }
            const list = getCharacters();
            return Array.isArray(list) && list.includes(character);
        };

        try {
            const saved = await writeExtensionField(target.characterId, 'sd_character_prompt', value, {
                isCurrent: isStillOwned,
            });
            if (state.seq !== seq) {
                return false;
            }
            if (!saved) {
                syncControlIfSelected(character);
                onFailure(intent, { character });
                return false;
            }
            syncControlIfSelected(character);
            return true;
        } catch (error) {
            if (state.seq !== seq) {
                return false;
            }
            syncControlIfSelected(character);
            onFailure(intent, { character, error });
            return false;
        }
    }

    /**
     * Handles an explicit toggle of the Shareable checkbox for the currently selected character.
     * Cancels any pending debounced text update and supersedes any older in-flight write for this character.
     * @param {{ shouldShare: boolean, positive: string, negative: string }} input
     * @returns {Promise<boolean>}
     */
    async function setShareEnabled({ shouldShare, positive, negative }) {
        const selection = getSelection();
        if (!selection || selection.isGroup || !selection.character || !Number.isInteger(selection.characterId)) {
            return false;
        }
        const { character, characterId } = selection;
        const state = getState(character);
        cancelPendingTimer(character);
        const seq = ++state.seq;
        const value = shouldShare
            ? { positive: String(positive ?? ''), negative: String(negative ?? '') }
            : null;
        return await persist({
            character,
            preferredId: characterId,
            seq,
            value,
            intent: shouldShare ? 'share' : 'unshare',
        });
    }

    /**
     * Schedules a debounced card update when the currently selected character is shared.
     * Captures character identity, sequence number, and prompt body before scheduling.
     * Does nothing when sharing is disabled.
     * @param {{ shareChecked: boolean, positive: string, negative: string }} input
     * @returns {boolean} True when a debounced card write was scheduled
     */
    function scheduleSharedPromptUpdate({ shareChecked, positive, negative }) {
        const selection = getSelection();
        if (!selection || selection.isGroup || !selection.character || !Number.isInteger(selection.characterId)) {
            return false;
        }
        const { character, characterId } = selection;
        if (!shareChecked) {
            return false;
        }
        const state = getState(character);
        cancelPendingTimer(character);
        const seq = ++state.seq;
        const capturedValue = {
            positive: String(positive ?? ''),
            negative: String(negative ?? ''),
        };
        state.pendingTimer = scheduleTimer(() => {
            if (state.pendingTimer !== null) {
                state.pendingTimer = null;
            }
            if (state.seq !== seq) {
                return;
            }
            // Refuse silently if the character object was replaced/removed before the debounce ran.
            const target = resolveTarget(character, characterId);
            if (!target) {
                return;
            }
            void persist({
                character,
                preferredId: target.characterId,
                seq,
                value: capturedValue,
                intent: 'update',
            });
        }, debounceMs);
        return true;
    }

    return {
        setShareEnabled,
        scheduleSharedPromptUpdate,
        cancelPendingForCharacter: cancelPendingTimer,
    };
}
