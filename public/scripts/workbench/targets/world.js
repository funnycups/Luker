// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Platform-owned `world` IterateTarget for Workbench AI iteration.
 * Scoped to globally active books (`global`) or character/chat-bound books
 * (`character`), with live-draft lorebook reads, prompt simulation, and
 * field-by-field worldbook commit/undo.
 */

import { safeClone } from '../../iteration-library/storage/safe-clone.js';
import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { SourceError } from '../model/errors.js';
import { worldUnits, worldRebuild, cardEditsFor } from '../model/adapters.js';
import { commitCardAndBooks } from '../model/commit.js';
import { DEFAULT_CARD_SYSTEM_PROMPT, buildWorldOnlyNote } from './card-prompts.js';
import {
    createWorldBookIo,
    getLocalCardApplyEdits,
    resolveCurrentCharacter,
    worldBookNamesForScope,
} from './card-world.js';
import {
    buildCeaEditorToolSet,
    normalizeToolCallToEdit,
    resolveBookNameFromArgsOrSingle,
    runCeaEditorReadTool,
} from './card-tools.js';

const defaultGetContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
const fnName = (t) => t?.function?.name;

const WORLD_TOOL = /^(cea_(add|update|str_replace|remove)_lorebook_entry(_field)?|cea_set_lorebook_metadata|lorebook_(list|query|get)|world_book_list|simulate_prompt)$/;

function applyEditsTo(edits, live, ctx) {
    const applyFn = getLocalCardApplyEdits(ctx);
    const res = applyFn(edits, safeClone(live));
    if (res?.conflicts?.length) {
        const c = res.conflicts[0];
        throw new SourceError('conflict', i18nFormat('Not changed (${0}): ${1}. Read the latest content first.', c.reason, c.edit?.path || ''));
    }
    return res.newLive;
}

/**
 * Creates the platform `world` IterateTarget.
 * @param {{ getContext?: () => object | null, bookIo?: object | null }} [opts]
 */
export function createWorldTarget({ getContext = defaultGetContext, bookIo = null } = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getContext();
    const resolveBookIo = () => bookIo || createWorldBookIo(() => resolveCtx());

    return {
        id: 'world',
        get label() { return i18n('World book'); },
        tone: 'world',
        order: 50,
        chips: () => [
            i18n('Find contradicting or duplicate entries'),
            i18n('Why did this entry not trigger'),
            i18n('Add a few keywords'),
            i18n('Split or trim entries that are too long'),
        ],
        scopeNotes: {
            global: () => i18n('Edit globally active world books (affects all chats)'),
            character: () => i18n('Edit this character\'s main book, extra books and the books bound to this chat'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            const global = (await worldBookNamesForScope(c, 'global')).length > 0;
            return { global, character: Boolean(resolveCurrentCharacter(c)) };
        },
        getNativeAi(ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.character_editor_assistant;
            if (!s) return null;
            return {
                connection: String(s.requestApiPresetName || '').trim(),
                preset: String(s.requestLlmPresetName || '').trim(),
            };
        },
        async promptInfo(ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.character_editor_assistant;
            const stored = String(s?.editorIterationSystemPrompt || '').trim();
            const custom = Boolean(stored) && stored !== DEFAULT_CARD_SYSTEM_PROMPT.trim();
            const base = stored || DEFAULT_CARD_SYSTEM_PROMPT;
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('"Edit iteration prompt" in Character Assistant settings (Luker has no separate world book prompt — the workbench offers only world book tools and lists the editable books)')),
                custom,
                text: [base, '', buildWorldOnlyNote([])].join('\n'),
            };
        },
        async load(scope, ctx) {
            const c = resolveCtx(ctx);
            const names = await worldBookNamesForScope(c, scope);
            if (!names.length) {
                throw new SourceError(
                    'no-book',
                    scope === 'global'
                        ? i18n('No globally active world book. Select one in Luker\'s world info panel first.')
                        : i18n('This character has no world books bound (no main book, extra books or chat binding).'),
                );
            }
            if (typeof c?.loadWorldInfo !== 'function') {
                throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', names[0]));
            }
            const lorebooks = {};
            for (const name of names) {
                let data;
                try {
                    data = await c.loadWorldInfo(name);
                } catch (err) {
                    if (err instanceof SourceError) throw err;
                    throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', name), { cause: err });
                }
                if (!data || typeof data !== 'object') {
                    throw new SourceError('read-failed', i18nFormat('Could not read "${0}", so nothing was changed', name));
                }
                const copy = safeClone(data);
                if (!copy.entries || typeof copy.entries !== 'object') copy.entries = {};
                lorebooks[name] = copy;
            }
            const cur = resolveCurrentCharacter(c);
            const who = scope === 'global'
                ? i18n('Globally active world books')
                : i18nFormat('World books of "${0}"', cur?.name || i18n('Character'));
            return {
                live: { lorebooks },
                target: { scope, avatar: scope === 'character' ? cur?.avatar || '' : '' },
                title: `${who} · ${Object.keys(lorebooks).join('、')}`,
            };
        },
        async prompt(live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.character_editor_assistant;
            const base = String(s?.editorIterationSystemPrompt || '').trim() || DEFAULT_CARD_SYSTEM_PROMPT;
            return [base, '', buildWorldOnlyNote(Object.keys(live?.lorebooks || {}))].join('\n');
        },
        async tools(_live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const set = buildCeaEditorToolSet(c, c?.extensionSettings?.character_editor_assistant || {}, {
                hasSearchTools: false,
            });
            return set.filter((d) => WORLD_TOOL.test(String(fnName(d) || '')));
        },
        isRead: (name) => /^(lorebook_|world_book_|simulate_)/.test(String(name || '')),
        async runRead(call, live, helpers) {
            const c = resolveCtx();
            const avatar = helpers?.target
                ? String(helpers.target.avatar || '').trim()
                : (resolveCurrentCharacter(c)?.avatar || '');
            const settings = c?.extensionSettings?.character_editor_assistant || {};
            const res = await runCeaEditorReadTool(
                { id: call?.id, name: call?.name, args: call?.args || {} },
                {
                    context: c,
                    settings,
                    avatar,
                    state: { live },
                    restrictToLiveBooks: true,
                    defaultSource: 'world',
                },
            );
            if (res?.cancelled) {
                return res.toolResultText;
            }
            if (res?.ok === false) {
                throw new SourceError('read', res.error || res.toolResultText || i18n('Read failed'));
            }
            return res?.toolResultText !== undefined
                ? res.toolResultText
                : (res?.result !== undefined ? res.result : res);
        },
        async runEdit(call, live) {
            const c = resolveCtx();
            const name = String(call?.name || '');
            if (!WORLD_TOOL.test(name)) {
                throw new SourceError('bad-args', `Tool "${name}" is not available in the World book workbench.`);
            }
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            const allowedBooks = Object.keys(live?.lorebooks || {});
            const book = resolveBookNameFromArgsOrSingle(args, live);
            if (!book) {
                throw new SourceError(
                    'bad-args',
                    allowedBooks.length
                        ? `missing book_name: specify one of ${allowedBooks.join(', ')}`
                        : 'missing book_name: no editable world books loaded',
                );
            }
            if (!Object.hasOwn(live?.lorebooks || {}, book)) {
                throw new SourceError(
                    'book',
                    i18nFormat('Only these can be edited: ${0}', allowedBooks.join(listSeparator())),
                );
            }
            const edits = await normalizeToolCallToEdit(
                { id: call?.id, name, args },
                { context: c, live: { character: {}, lorebooks: live?.lorebooks || {} } },
            );
            if (!edits) throw new SourceError('bad-args', i18n('Invalid arguments'));
            const next = { lorebooks: safeClone(live?.lorebooks || {}) };
            for (const e of edits) {
                const rel = { ...e, path: String(e.path).replace(/^lorebook\./, '') };
                next.lorebooks[book] = applyEditsTo([rel], next.lorebooks[book], c);
            }
            return next;
        },
        units: (live) => worldUnits(live),
        rebuild: (base, ai, keys) => worldRebuild(base, ai, keys),
        async commit(_targetRef, base, next, keys) {
            const io = resolveBookIo();
            return commitCardAndBooks(
                cardEditsFor({ character: {}, ...base }, { character: {}, ...next }, keys.filter((k) => k.startsWith('wi:'))),
                io,
            );
        },
    };
}

export const worldTarget = createWorldTarget();
