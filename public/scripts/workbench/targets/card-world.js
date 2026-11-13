// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Platform-owned character card and worldbook projection, edits-engine ops,
 * snapshot builders, commit helpers, and prompt simulation.
 * Zero extension imports; heavy browser modules (named-resource-read,
 * world-info, simulation-review) are loaded lazily when invoked.
 */

import { resolveLodash } from './lodash-fallback.js';
import { createEngine } from '../../lib/edits/engine.js';
import { createSetOp } from '../../lib/edits/ops/set.js';
import { createUnsetOp } from '../../lib/edits/ops/unset.js';
import { createStrReplaceOp } from '../../lib/edits/ops/str-replace.js';
import { createStrInsertOp } from '../../lib/edits/ops/str-insert.js';
import { createStrDeleteOp } from '../../lib/edits/ops/str-delete.js';
import { createListInsertOp } from '../../lib/edits/ops/list-insert.js';
import { createListRemoveOp } from '../../lib/edits/ops/list-remove.js';
import { createListMoveOp } from '../../lib/edits/ops/list-move.js';
import { floorRecordToTaskMessage, readPluginFloors } from '../../lib/plugin-floors.js';
import { safeClone } from '../../iteration-library/storage/safe-clone.js';
import { i18n, i18nFormat } from '../i18n.js';
import { SourceError } from '../model/errors.js';
import { bookForWrite } from '../model/commit.js';
import { same } from '../model/patch.js';

export const CHARACTER_EDITOR_ROOT_TEXT_FIELDS = Object.freeze([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
]);

export const CHARACTER_EDITOR_DATA_TEXT_FIELDS = Object.freeze([
    'system_prompt',
    'post_history_instructions',
    'creator_notes',
]);

export const CHARACTER_EDITOR_DATA_ARRAY_FIELDS = Object.freeze([
    'alternate_greetings',
]);

export const CEA_CARD_FIELD_ENUM = Object.freeze([
    ...CHARACTER_EDITOR_ROOT_TEXT_FIELDS,
    ...CHARACTER_EDITOR_DATA_TEXT_FIELDS,
    ...CHARACTER_EDITOR_DATA_ARRAY_FIELDS,
]);

const KNOWN_CARD_FIELDS = new Set(CEA_CARD_FIELD_ENUM);

export function isKnownCardField(name) {
    return KNOWN_CARD_FIELDS.has(String(name || ''));
}

/**
 * Projects canonical v2 character.data.* fields (notably system_prompt,
 * post_history_instructions, creator_notes, alternate_greetings, plus root text
 * fields when present in data) onto a cloned character root so read/patch/commit
 * paths operate on a single consistent representation.
 */
export function projectCardV2Fields(character) {
    if (!character || typeof character !== 'object') return {};
    const projected = safeClone(character);
    const data = projected.data && typeof projected.data === 'object' ? projected.data : null;
    if (data) {
        for (const f of CEA_CARD_FIELD_ENUM) {
            if (Object.hasOwn(data, f) && data[f] !== undefined) {
                projected[f] = safeClone(data[f]);
            }
        }
    }
    return projected;
}

/**
 * Validates and parses an `alternate_greetings` write value as `string[]`.
 * Accepts a native `string[]` or a JSON-encoded string array; rejects any other
 * string, object, or array with non-string elements.
 */
export function parseAlternateGreetingsValue(value, toolName = 'cea_set_card_field') {
    let parsed = value;
    if (typeof parsed === 'string') {
        const trimmed = parsed.trim();
        if (!trimmed.startsWith('[')) {
            throw new Error(`${toolName}: invalid_args — alternate_greetings must be an array of strings (or a JSON-encoded string[]).`);
        }
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            throw new Error(`${toolName}: invalid_args — alternate_greetings must be a valid JSON array of strings.`);
        }
    }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new Error(`${toolName}: invalid_args — alternate_greetings must be an array of strings.`);
    }
    return parsed.slice();
}

// ---------------------------------------------------------------------------
// Lorebook entry edits-lib ops
// ---------------------------------------------------------------------------

function getEntries(deps, live, path) {
    return deps.get(live, path) || {};
}

export function createLorebookEntryAddOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            entries[edit.uid] = deps.cloneDeep(edit.entry);
            deps.set(live, edit.path, entries);
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_remove',
                path: edit.path,
                uid: edit.uid,
                entry: edit.entry,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            if (entries[edit.uid]) {
                return {
                    reason: 'duplicate',
                    baseline: undefined,
                    current: entries[edit.uid],
                };
            }
            return null;
        },
    };
}

export function createLorebookEntryUpdateOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) return live;
            for (const key of Object.keys(edit.patch || {})) {
                cur[key] = deps.cloneDeep(edit.patch[key]);
            }
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_update',
                path: edit.path,
                uid: edit.uid,
                patch: edit.before,
                before: edit.patch,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) {
                return { reason: 'not_found', baseline: edit.before, current: undefined };
            }
            const allMatch = Object.keys(edit.patch || {}).every(
                (k) => deps.isEqual(cur[k], edit.patch[k]),
            );
            if (allMatch) {
                return { reason: 'already_done', baseline: edit.before, current: deps.cloneDeep(cur) };
            }
            const anyDrift = Object.keys(edit.before || {}).some(
                (k) => !deps.isEqual(cur[k], edit.before[k]),
            );
            if (anyDrift) {
                return { reason: 'value_drifted', baseline: edit.before, current: deps.cloneDeep(cur) };
            }
            return null;
        },
    };
}

export function createLorebookEntryRemoveOp() {
    return {
        apply(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            delete entries[edit.uid];
            deps.set(live, edit.path, entries);
            return live;
        },
        inverse(edit) {
            return {
                op: 'lorebook_entry_add',
                path: edit.path,
                uid: edit.uid,
                entry: edit.entry,
            };
        },
        detectConflict(deps, edit, live) {
            const entries = getEntries(deps, live, edit.path);
            const cur = entries[edit.uid];
            if (!cur) {
                return { reason: 'not_found', baseline: edit.entry, current: undefined };
            }
            if (!deps.isEqual(cur, edit.entry)) {
                return { reason: 'value_drifted', baseline: edit.entry, current: deps.cloneDeep(cur) };
            }
            return null;
        },
    };
}

export function getLocalCardApplyEdits(ctx = null) {
    const lodash = resolveLodash(ctx);
    const engine = createEngine({
        get: lodash.get,
        set: lodash.set,
        unset: lodash.unset,
        isEqual: lodash.isEqual,
        cloneDeep: lodash.cloneDeep,
    });
    for (const [name, handler] of [
        ['set', createSetOp()],
        ['unset', createUnsetOp()],
        ['str_replace', createStrReplaceOp()],
        ['str_insert', createStrInsertOp()],
        ['str_delete', createStrDeleteOp()],
        ['list_insert', createListInsertOp()],
        ['list_remove', createListRemoveOp()],
        ['list_move', createListMoveOp()],
        ['lorebook_entry_add', createLorebookEntryAddOp()],
        ['lorebook_entry_update', createLorebookEntryUpdateOp()],
        ['lorebook_entry_remove', createLorebookEntryRemoveOp()],
    ]) {
        engine.registerOp(name, handler);
    }
    return engine.applyEdits;
}

// ---------------------------------------------------------------------------
// Character & Worldbook snapshots + commits
// ---------------------------------------------------------------------------

export function resolveCurrentCharacter(ctx) {
    if (!ctx || ctx.groupId) return null;
    const idx = Number(ctx.characterId);
    const c = ctx.characters?.[idx];
    return c?.avatar
        ? { avatar: String(c.avatar), name: String(c.name || c.data?.name || ''), index: idx }
        : null;
}

export function resolveCharacterRecord(context, { avatar = '' } = {}) {
    if (context?.groupId) {
        throw new Error('Character editor assistant is unavailable in group chats.');
    }
    const preferredAvatar = String(avatar || '').trim();
    const characters = Array.isArray(context?.characters) ? context.characters : [];

    if (preferredAvatar) {
        const characterIndex = characters.findIndex((item) => String(item?.avatar || '').trim() === preferredAvatar);
        if (characterIndex >= 0) {
            return { characterIndex, character: characters[characterIndex], avatar: preferredAvatar };
        }
        throw new Error(`Character not found for avatar: ${preferredAvatar}`);
    }

    const directIndex = context?.characterId;
    const directCharacter = characters?.[directIndex];
    if (directCharacter) {
        const resolvedAvatar = String(directCharacter?.avatar || '').trim();
        if (resolvedAvatar) {
            const resolvedIndex = Number.isInteger(Number(directIndex))
                ? Number(directIndex)
                : characters.findIndex((item) => String(item?.avatar || '').trim() === resolvedAvatar);
            return { characterIndex: resolvedIndex, character: directCharacter, avatar: resolvedAvatar };
        }
    }

    const currentChatId = String(context?.chatId || '').trim();
    if (currentChatId) {
        const characterIndex = characters.findIndex((item) => String(item?.chat || '').trim() === currentChatId);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return { characterIndex, character, avatar: resolvedAvatar };
            }
        }
    }

    const activeName = String(context?.name2 || '').trim();
    if (activeName) {
        const characterIndex = characters.findIndex((item) => String(item?.name || '').trim() === activeName);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return { characterIndex, character, avatar: resolvedAvatar };
            }
        }
    }

    throw new Error('No active character selected.');
}

export async function boundWorldBookNames(ctx) {
    if (!ctx) return [];
    const names = new Set();
    const c = resolveCurrentCharacter(ctx);
    if (c) {
        const full = ctx.characters[c.index];
        if (full?.data?.extensions?.world) names.add(String(full.data.extensions.world));
        const fileName = typeof ctx.getCharaFilename === 'function'
            ? ctx.getCharaFilename(null, { manualAvatarKey: full?.avatar })
            : String(full?.avatar || '').replace(/\.[^.]+$/, '');
        if (fileName && typeof ctx.getCharaAuxWorlds === 'function') {
            for (const n of ctx.getCharaAuxWorlds(fileName) || []) names.add(String(n));
        }
    }
    if (typeof ctx.chatWorldInfo?.getNames === 'function') {
        for (const n of ctx.chatWorldInfo.getNames(ctx?.chatMetadata) || []) names.add(String(n));
    }
    if (Array.isArray(ctx.chatWorldInfo?.globalSelection)) {
        for (const n of ctx.chatWorldInfo.globalSelection) names.add(String(n));
    }
    return [...names].filter(Boolean);
}

export async function worldBookNamesForScope(ctx, scope) {
    const names = new Set();
    if (scope === 'global') {
        if (Array.isArray(ctx?.chatWorldInfo?.globalSelection)) {
            for (const n of ctx.chatWorldInfo.globalSelection) names.add(String(n));
        }
    } else {
        const c = resolveCurrentCharacter(ctx);
        if (!c) throw new SourceError('no-character', i18n('No character card selected'));
        const full = ctx.characters[c.index];
        if (full?.data?.extensions?.world) names.add(String(full.data.extensions.world));
        const fileName = typeof ctx.getCharaFilename === 'function'
            ? ctx.getCharaFilename(null, { manualAvatarKey: full?.avatar })
            : String(full?.avatar || '').replace(/\.[^.]+$/, '');
        if (fileName && typeof ctx.getCharaAuxWorlds === 'function') {
            for (const n of ctx.getCharaAuxWorlds(fileName) || []) names.add(String(n));
        }
        if (typeof ctx.chatWorldInfo?.getNames === 'function') {
            for (const n of ctx.chatWorldInfo.getNames(ctx?.chatMetadata) || []) names.add(String(n));
        }
    }
    return [...names].filter(Boolean);
}

export async function buildCardLiveSnapshot(context, avatar = '', { includeBoundBooks = false } = {}) {
    const record = resolveCharacterRecord(context, { avatar });
    const character = projectCardV2Fields(record.character || {});
    const lorebooks = {};
    const primaryBook = String(character?.data?.extensions?.world || '').trim();
    const bookNames = new Set();
    if (primaryBook) bookNames.add(primaryBook);
    if (includeBoundBooks) {
        for (const name of await boundWorldBookNames(context)) {
            bookNames.add(name);
        }
    }
    if (bookNames.size > 0 && typeof context?.loadWorldInfo !== 'function') {
        const firstBook = [...bookNames][0];
        throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', firstBook));
    }
    for (const bookName of bookNames) {
        let data;
        try {
            data = await context.loadWorldInfo(bookName);
        } catch (err) {
            if (err instanceof SourceError) throw err;
            throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', bookName), { cause: err });
        }
        if (!data || typeof data !== 'object') {
            throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', bookName));
        }
        const copy = safeClone(data);
        if (!copy.entries || typeof copy.entries !== 'object') copy.entries = {};
        lorebooks[bookName] = copy;
    }
    return { character, lorebooks };
}

export async function mergeCharacterAttributes(context, avatar, patch) {
    const target = String(avatar || '').trim();
    if (!target) return;
    const characters = Array.isArray(context?.characters) ? context.characters : [];
    const characterIndex = characters.findIndex((item) => String(item?.avatar || '').trim() === target);
    if (characterIndex < 0) {
        throw new Error(`Character not found: ${target}`);
    }

    const formPatch = {};
    const extPatchesByTopKey = {};
    if (patch && typeof patch === 'object') {
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'avatar') continue;
            if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
                for (const [dataKey, dataValue] of Object.entries(value)) {
                    if (dataKey === 'extensions' && dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)) {
                        for (const [extKey, extValue] of Object.entries(dataValue)) {
                            extPatchesByTopKey[extKey] = extValue;
                        }
                    } else {
                        formPatch[dataKey] = dataValue;
                    }
                }
            } else {
                formPatch[key] = value;
            }
        }
    }

    if (Object.keys(formPatch).length === 0 && Object.keys(extPatchesByTopKey).length === 0) {
        return;
    }

    if (Object.keys(formPatch).length > 0) {
        await context.updateCharacterData(characterIndex, formPatch, { immediate: true });
    }
    for (const [topKey, value] of Object.entries(extPatchesByTopKey)) {
        await context.writeExtensionField(characterIndex, topKey, value);
    }
}

export async function commitCharacterOperations(context, avatar, edits, opts = {}) {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    const unknownFields = [];
    for (const edit of edits) {
        const path = String(edit?.path || '').trim();
        if (!path) continue;
        const field = path.startsWith('card.') ? path.slice('card.'.length) : path;
        if (field.includes('.')) continue;
        if (!KNOWN_CARD_FIELDS.has(field)) {
            unknownFields.push(field);
        } else if (field === 'alternate_greetings' && edit?.op === 'set' && edit?.newValue !== undefined) {
            if (!Array.isArray(edit.newValue) || !edit.newValue.every((item) => typeof item === 'string')) {
                throw new Error('Apply rejected: alternate_greetings must be an array of strings.');
            }
        }
    }
    if (unknownFields.length > 0) {
        const unique = [...new Set(unknownFields)];
        throw new Error(
            `Apply rejected: unknown character card field(s) ${unique.map((f) => `"${f}"`).join(', ')}. `
            + `Valid fields are: ${CEA_CARD_FIELD_ENUM.join(', ')}.`,
        );
    }

    const lodash = resolveLodash(context);
    const applyFn = getLocalCardApplyEdits(context);
    const before = opts?.liveCharacter ? projectCardV2Fields(opts.liveCharacter) : {};
    const result = applyFn(edits, before) || {};
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const alreadyDone = Array.isArray(result.alreadyDone) ? result.alreadyDone : [];
    const clean = Array.isArray(result.clean) ? result.clean : [];
    if (conflicts.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[workbench/card-world] commitCharacterOperations conflicts', conflicts);
    }

    const after = result.newLive || before;
    const patch = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
        if (!lodash.isEqual(before[k], after[k])) {
            patch[k] = after[k];
        }
    }
    let persisted = false;
    if (clean.length > 0 && Object.keys(patch).length > 0) {
        await mergeCharacterAttributes(context, avatar, patch);
        persisted = true;
    }
    return { applied: clean.length, conflicts, alreadyDone, persisted };
}

export async function commitLorebookOperations(bookName, liveBook, edits, opts = {}) {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    const safeName = String(bookName || '').trim();
    if (!safeName) {
        return { applied: 0, conflicts: [], alreadyDone: [], persisted: false };
    }
    const context = opts?.context;
    if (!context || typeof context.saveWorldInfo !== 'function') {
        throw new TypeError('commitLorebookOperations: opts.context.saveWorldInfo is required');
    }
    const renameEdit = edits.find((e) =>
        e && e.op === 'set'
        && (e.path === 'bookName' || e.path === 'lorebook.bookName')
        && String(e.newValue || '').trim() !== ''
        && String(e.newValue || '').trim() !== safeName,
    );
    if (renameEdit) {
        throw new Error(
            'Renaming lorebooks via cea_set_lorebook_metadata is not supported. '
            + `Use the world-info panel to rename "${safeName}" → "${String(renameEdit.newValue).trim()}".`,
        );
    }

    const lodash = resolveLodash(context);
    const applyFn = getLocalCardApplyEdits(context);
    const before = liveBook ? safeClone(liveBook) : { entries: {} };
    const result = applyFn(edits, before) || {};
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
    const alreadyDone = Array.isArray(result.alreadyDone) ? result.alreadyDone : [];
    const clean = Array.isArray(result.clean) ? result.clean : [];
    if (conflicts.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[workbench/card-world] commitLorebookOperations conflicts for ${safeName}`, conflicts);
    }
    const after = result.newLive || before;
    let persisted = false;
    if (clean.length > 0 && !lodash.isEqual(before, after)) {
        await context.saveWorldInfo(safeName, after, true, { refreshEditor: true });
        persisted = true;
    }
    return { applied: clean.length, conflicts, alreadyDone, persisted };
}

export async function readPersistedBook(name, ctx = null) {
    try {
        if (typeof ctx?.readWorldInfoDocument === 'function') {
            return safeClone(await ctx.readWorldInfoDocument(name));
        }
        const { readWorldInfoDocument } = await import('../../named-resource-read.js');
        return safeClone(await readWorldInfoDocument(name));
    } catch (err) {
        if (err?.status === 404) {
            throw new SourceError('target-gone', i18nFormat('World book "${0}" no longer exists', name));
        }
        throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', name));
    }
}

export function createWorldBookIo(getCtx) {
    return {
        readBook: async (book) => {
            const ctx = typeof getCtx === 'function' ? getCtx() : getCtx;
            const persisted = await readPersistedBook(book, ctx);
            const cached = typeof ctx?.loadWorldInfo === 'function'
                ? safeClone(await ctx.loadWorldInfo(book))
                : null;
            return bookForWrite(persisted, cached, book);
        },
        async saveBook(book, data) {
            const ctx = typeof getCtx === 'function' ? getCtx() : getCtx;
            if (typeof ctx?.saveWorldInfo !== 'function') {
                throw new SourceError('write-failed', i18nFormat('Could not read "${0}", so nothing was changed', book));
            }
            const key = String(book).trim();
            let cache = ctx?.worldInfoCache instanceof Map ? ctx.worldInfoCache : null;
            if (!cache) {
                const wiMod = await import('../../world-info.js');
                cache = wiMod?.worldInfoCache instanceof Map ? wiMod.worldInfoCache : null;
            }
            const previous = cache ? cache.get(key) : undefined;
            try {
                await ctx.saveWorldInfo(book, data, true, { refreshEditor: true });
            } catch (err) {
                if (cache && same(cache.get(key), data)) {
                    if (previous === undefined) cache.delete(key);
                    else cache.set(key, previous);
                }
                throw err;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Prompt simulation (shared by card & world targets)
// ---------------------------------------------------------------------------

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) return [];
    return messages.map((message) => {
        if (!message || typeof message !== 'object') return message;
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

function rewriteDepthWorldInfoToAfterWithNotes(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) return payload;
    const blocks = [];
    for (const entry of depthEntries) {
        const depth = Math.max(0, Math.floor(Number(entry?.depth) || 0));
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (!content) continue;
            blocks.push(`[原聊天深度注入: ${depth}]\n${content}`);
        }
    }
    payload.worldInfoDepth = [];
    if (blocks.length === 0) return payload;
    if (!Array.isArray(payload.worldInfoAfterEntries)) payload.worldInfoAfterEntries = [];
    for (const block of blocks) {
        if (!payload.worldInfoAfterEntries.includes(block)) {
            payload.worldInfoAfterEntries.push(block);
        }
    }
    return payload;
}

export function buildCardSimulationSourceMessages(context, { text = '', messages = null } = {}) {
    const explicitMessages = normalizeWorldInfoResolverMessages(messages)
        .filter((message) => message && typeof message === 'object' && String(message.content ?? '').trim());
    if (explicitMessages.length > 0) {
        return { mode: 'messages', messages: explicitMessages };
    }

    const safeText = String(text || '').trim();
    if (!safeText) {
        return { mode: '', messages: [] };
    }

    const currentChatMessages = readPluginFloors(context, { roles: ['user', 'assistant'] })
        .map(floorRecordToTaskMessage)
        .filter((message) => message && typeof message === 'object' && String(message.content ?? '').trim());
    return {
        mode: 'text',
        messages: [...currentChatMessages, { role: 'user', content: safeText }],
    };
}

function extractSystemPromptForSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return '';
    const first = promptMessages.find((m) => (m?.role || '').toLowerCase() === 'system');
    return String(first?.content || '');
}

function extractNonSystemMessagesForSimulation(promptMessages) {
    if (!Array.isArray(promptMessages)) return [];
    return promptMessages
        .filter((m) => (m?.role || '').toLowerCase() !== 'system')
        .map((m) => ({ role: String(m?.role || ''), content: String(m?.content || '') }));
}

function extractSystemFromCapturedPrompt(promptArray) {
    if (!Array.isArray(promptArray)) return '';
    return promptArray
        .filter((m) => (m?.role || '').toLowerCase() === 'system')
        .map((m) => String(m?.content || ''))
        .join('\n\n');
}

function extractNonSystemFromCapturedPrompt(promptArray) {
    return extractNonSystemMessagesForSimulation(promptArray);
}

function buildCardSimulationErrorResult(err) {
    return `<simulation_result kind="cea" ok="false">\n\n<error reason="simulation_failed">\n${String(err?.message || err || '')}\n</error>\n\n</simulation_result>`;
}

export async function runCardSimulatePrompt(context, args = {}) {
    if (!context || typeof context.buildPresetAwarePromptMessages !== 'function') {
        const err = new Error('Prompt preset assembly is unavailable.');
        return { ok: false, error: err.message, toolResultText: buildCardSimulationErrorResult(err) };
    }

    const translateFn = typeof context?.translate === 'function'
        ? context.translate
        : (typeof globalThis !== 'undefined' && globalThis.__i18n && typeof globalThis.__i18n.translate === 'function'
            ? globalThis.__i18n.translate
            : null);
    const i18nFn = (k, fb) => (translateFn ? translateFn(fb || k, k) : (fb || k));

    const source = buildCardSimulationSourceMessages(context, {
        text: String(args?.text || '').trim(),
        messages: Array.isArray(args?.messages) ? args.messages : null,
    });
    if (source.messages.length === 0) {
        return { ok: false, error: 'simulate_prompt requires either text or messages.' };
    }
    if (source.mode === 'messages') {
        const msg = 'simulate_prompt does not support the messages-mode input under the current generation backend. Pass text=<single user turn> and the simulator will append it to the live chat.';
        return {
            ok: false,
            error: msg,
            toolResultText: buildCardSimulationErrorResult(new Error(msg)),
        };
    }

    try {
        const [
            { openSimulationReview },
            { extractWorldInfoHitsFromRuntime },
        ] = await Promise.all([
            import('../../iteration-library/simulation-review/index.js'),
            import('../../iteration-library/simulation-review/wi-hits.js'),
        ]);
        const generateQuietPromptFn = context?.generateQuietPrompt
            || globalThis.Luker?.getContext?.()?.generateQuietPrompt;

        const runOneSimulationAttempt = async () => {
            const runtimeWorldInfo = typeof context?.resolveWorldInfoForMessages === 'function'
                ? await context.resolveWorldInfoForMessages(source.messages, {
                    type: 'quiet',
                    fallbackToCurrentChat: false,
                    postActivationHook: rewriteDepthWorldInfoToAfterWithNotes,
                })
                : {};

            const src = context?.eventSource ?? null;
            const eventName = context?.eventTypes?.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready';
            let capturedPromptArray = null;
            const listener = (eventData) => {
                const chat = Array.isArray(eventData) ? eventData : eventData?.chat;
                if (!Array.isArray(chat)) return;
                capturedPromptArray = safeClone(chat);
            };
            const registerLast = src && typeof src.makeLast === 'function'
                ? src.makeLast.bind(src)
                : src?.on?.bind(src);
            if (registerLast) registerLast(eventName, listener);

            const lastUserMsg = source.messages.slice().reverse().find((m) => m.role === 'user' || m.is_user);
            const quietPrompt = String(lastUserMsg?.content || lastUserMsg?.mes || '');
            let finalOutput = '';
            try {
                if (typeof generateQuietPromptFn === 'function') {
                    const generated = await generateQuietPromptFn({
                        quietPrompt,
                        quietToLoud: false,
                        skipWIAN: false,
                        removeReasoning: false,
                    });
                    finalOutput = String(generated || '');
                }
            } finally {
                if (typeof src?.removeListener === 'function') {
                    src.removeListener(eventName, listener);
                }
            }

            let assembledPrompt;
            let promptMessagesForCaller;
            if (Array.isArray(capturedPromptArray) && capturedPromptArray.length > 0) {
                assembledPrompt = {
                    systemPrompt: extractSystemFromCapturedPrompt(capturedPromptArray),
                    messages: extractNonSystemFromCapturedPrompt(capturedPromptArray),
                };
                promptMessagesForCaller = capturedPromptArray;
            } else {
                const promptMessages = context.buildPresetAwarePromptMessages({
                    messages: source.messages,
                    envelopeOptions: {
                        includeCharacterCard: true,
                        api: String(context?.mainApi || 'openai').trim() || 'openai',
                    },
                    runtimeWorldInfo,
                });
                assembledPrompt = {
                    systemPrompt: extractSystemPromptForSimulation(promptMessages),
                    messages: extractNonSystemMessagesForSimulation(promptMessages),
                };
                promptMessagesForCaller = promptMessages;
            }

            const worldInfoHits = extractWorldInfoHitsFromRuntime(runtimeWorldInfo);
            const payload = {
                finalOutput,
                reasoning: '',
                assembledPrompt,
                worldInfoHits,
            };
            return { payload, worldInfoHits, promptMessages: promptMessagesForCaller, runtimeWorldInfo };
        };

        const firstAttempt = await runOneSimulationAttempt();
        const review = await openSimulationReview({
            kind: 'cea',
            payload: firstAttempt.payload,
            worldInfoHits: firstAttempt.worldInfoHits,
            i18n: i18nFn,
            onRerun: async () => {
                const next = await runOneSimulationAttempt();
                return { payload: next.payload, worldInfoHits: next.worldInfoHits };
            },
        });

        return {
            ok: review.ok,
            cancelled: review.cancelled,
            toolResultText: review.toolResultText,
            result: {
                ok: review.ok,
                cancelled: review.cancelled,
                toolResultText: review.toolResultText,
                mode: source.mode,
                sourceMessages: source.messages,
                runtimeWorldInfo: firstAttempt.runtimeWorldInfo,
                promptMessages: firstAttempt.promptMessages,
                assembled_length: Array.isArray(firstAttempt.promptMessages)
                    ? firstAttempt.promptMessages.reduce((sum, m) => sum + String(m?.content || '').length, 0)
                    : 0,
            },
        };
    } catch (err) {
        return {
            ok: false,
            cancelled: false,
            toolResultText: buildCardSimulationErrorResult(err),
            error: String(err?.message || err || 'simulate failed'),
        };
    }
}
