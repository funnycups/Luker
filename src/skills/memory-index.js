/**
 * In-memory index of installed skills, layered by scope.
 *
 * Layering for getVisible(ctx): global < preset (active API + preset)
 * < character (active card). Later layers shadow earlier ones on name
 * collision, so a character-scoped skill named "foo" hides a global
 * skill named "foo".
 *
 * The index is a pure cache around `repository.list({ scope: 'all' })`
 * — every rebuild/invalidate re-walks the filesystem.
 */
export function createMemoryIndex(repository) {
    let state = {
        global: new Map(),
        preset: new Map(),
        character: new Map(),
    };

    async function rebuild() {
        const newState = { global: new Map(), preset: new Map(), character: new Map() };
        const all = await repository.list({ scope: 'all' });
        for (const e of all) {
            if (e.scope.kind === 'global') {
                newState.global.set(e.name, e);
            } else if (e.scope.kind === 'preset') {
                const key = `${e.scope.apiId}/${e.scope.name}`;
                if (!newState.preset.has(key)) newState.preset.set(key, new Map());
                newState.preset.get(key).set(e.name, e);
            } else if (e.scope.kind === 'character') {
                const key = e.scope.characterFile;
                if (!newState.character.has(key)) newState.character.set(key, new Map());
                newState.character.get(key).set(e.name, e);
            }
        }
        state = newState;
    }

    function getVisible(ctx) {
        const merged = new Map();
        for (const [name, e] of state.global) merged.set(name, e);
        if (ctx && ctx.presetApiId && ctx.presetName) {
            const key = `${ctx.presetApiId}/${ctx.presetName}`;
            const presetMap = state.preset.get(key);
            if (presetMap) for (const [name, e] of presetMap) merged.set(name, e);
        }
        if (ctx && ctx.characterFile) {
            const charMap = state.character.get(ctx.characterFile);
            if (charMap) for (const [name, e] of charMap) merged.set(name, e);
        }
        return Array.from(merged.values());
    }

    return {
        rebuild,
        invalidate: rebuild,
        getVisible,
    };
}
