// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure character-edit form target resolution and patch/edit planning shared by
 * `public/script.js`. Always binds edits to the form's own `avatar_url` rather
 * than live `this_chid`, preventing a character switch from writing one card's
 * form fields onto another card.
 */

function escapeCharacterPointer(value) {
    return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function defaultDeepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!defaultDeepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    if (typeof a === 'object') {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            if (!defaultDeepEqual(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

/**
 * Resolves the loaded character targeted by an edit form from its `avatar_url`.
 * Returns `null` when the avatar is empty or no longer present in `characters`.
 *
 * @param {Array<object>} characters
 * @param {string|null|undefined} formAvatarUrl
 * @returns {{ chid: string, avatar: string, character: object } | null}
 */
export function resolveCharacterFormEditTarget(characters, formAvatarUrl) {
    const avatar = String(formAvatarUrl || '').trim();
    if (!avatar || !Array.isArray(characters)) {
        return null;
    }
    const index = characters.findIndex(character => String(character?.avatar || '') === avatar);
    if (index < 0 || !characters[index]) {
        return null;
    }
    return {
        chid: String(index),
        avatar,
        character: characters[index],
    };
}

export function characterSourceData(character) {
    try {
        const parsed = JSON.parse(character?.json_data || '{}');
        return parsed?.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
            ? parsed.data
            : parsed;
    } catch {
        return {};
    }
}

export function characterDataPatchOperations(character, nextData = character?.data || {}, { isEqual = defaultDeepEqual } = {}) {
    const sourceData = characterSourceData(character);
    const currentExtensions = nextData.extensions ?? {};
    const sourceExtensions = sourceData?.extensions ?? {};
    if (!isEqual(currentExtensions, sourceExtensions)) {
        return null;
    }

    const operations = [];
    for (const [key, value] of Object.entries(nextData)) {
        if (key === 'extensions') continue;
        if (!isEqual(value, sourceData?.[key])) {
            operations.push({
                op: 'add',
                path: `/data/${escapeCharacterPointer(key)}`,
                value,
            });
        }
    }
    return operations;
}

export function characterDataFromForm(character, formData, { isEqual = defaultDeepEqual } = {}) {
    const current = character?.data && typeof character.data === 'object' ? character.data : {};
    const sourceData = characterSourceData(character);
    const next = { ...current };
    const text = (name) => {
        const value = formData.get(name);
        return value === null ? undefined : String(value);
    };
    const setText = (field, name = field) => {
        const value = text(name);
        if (value !== undefined && !(value === '' && sourceData?.[field] === undefined)) {
            next[field] = value;
        }
    };

    setText('name', 'ch_name');
    for (const field of ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) {
        setText(field);
    }
    const tags = text('tags');
    if (tags !== undefined) {
        next.tags = tags.split(',').map(tag => tag.trim()).filter(Boolean);
    }

    const extensions = { ...(current.extensions || {}) };
    const talkativeness = text('talkativeness');
    if (talkativeness !== undefined && Number(talkativeness) !== Number(extensions.talkativeness ?? 0.5)) {
        extensions.talkativeness = Number(talkativeness);
    }
    const fav = text('fav');
    if (fav !== undefined && (fav === 'true') !== (extensions.fav === true)) {
        extensions.fav = fav === 'true';
    }
    const world = text('world');
    if (world !== undefined && world !== String(extensions.world ?? '')) {
        extensions.world = world;
    }
    const depthPrompt = text('depth_prompt_prompt');
    const depth = text('depth_prompt_depth');
    const role = text('depth_prompt_role');
    const currentDepth = extensions.depth_prompt || {};
    const nextDepth = {
        ...currentDepth,
        ...(depthPrompt !== undefined && depthPrompt !== String(currentDepth.prompt ?? '') ? { prompt: depthPrompt } : {}),
        ...(depth !== undefined && Number(depth) !== Number(currentDepth.depth ?? 4) ? { depth: Number(depth) } : {}),
        ...(role !== undefined && role !== String(currentDepth.role ?? 'system') ? { role } : {}),
    };
    if (!isEqual(nextDepth, currentDepth)) {
        extensions.depth_prompt = nextDepth;
    }
    next.extensions = extensions;
    return next;
}

/**
 * Plans a character edit form submission strictly against the character
 * identified by `formData.get('avatar_url')`.
 *
 * @param {object} params
 * @param {Array<object>} params.characters
 * @param {FormData | { get: (name: string) => any }} params.formData
 * @param {any} [params.rawFile]
 * @param {any} [params.cropData]
 * @param {(a: any, b: any) => boolean} [params.isEqual]
 */
export function planCharacterFormEdit({ characters, formData, rawFile = null, cropData = undefined, isEqual = defaultDeepEqual }) {
    const rawAvatarUrl = formData?.get?.('avatar_url');
    const target = resolveCharacterFormEditTarget(characters, rawAvatarUrl);
    if (!target) {
        const displayAvatar = String(rawAvatarUrl || '').trim() || '(empty)';
        throw new Error(`Cannot save character edit: form target "${displayAvatar}" is not loaded.`);
    }

    const nextData = characterDataFromForm(target.character, formData, { isEqual });
    const hasUploadedAvatar = Boolean(rawFile && typeof rawFile === 'object' && Number(rawFile.size) > 0);
    const operations = target.character.shallow
        ? null
        : characterDataPatchOperations(target.character, nextData, { isEqual });
    const canPatch = !hasUploadedAvatar && cropData === undefined && operations !== null;
    const alternateGreetings = Array.isArray(target.character.data?.alternate_greetings)
        ? target.character.data.alternate_greetings
        : [];
    const editingExtensions = (target.character.data?.extensions && typeof target.character.data.extensions === 'object')
        ? target.character.data.extensions
        : null;

    return {
        target,
        nextData,
        operations,
        canPatch,
        alternateGreetings,
        editingExtensions,
    };
}
