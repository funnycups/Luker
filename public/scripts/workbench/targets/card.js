// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Platform-owned `card` IterateTarget for Workbench AI iteration.
 * Edits the active character card and all bound world books, with full CEA
 * tool parity, v2 field projection & validation, live-draft lorebook reads,
 * prompt simulation, and custom CEA prompt support.
 */

import { safeClone } from '../../iteration-library/storage/safe-clone.js';
import { i18n, i18nFormat, listSeparator } from '../i18n.js';
import { SourceError } from '../model/errors.js';
import { requireStoredPrompt } from '../../lib/prompt-values.js';
import { cardUnits, cardRebuild, cardEditsFor } from '../model/adapters.js';
import { commitCardAndBooks } from '../model/commit.js';
import { DEFAULT_CARD_SYSTEM_PROMPT } from './card-prompts.js';
import {
    buildCardLiveSnapshot,
    commitCharacterOperations,
    createWorldBookIo,
    getLocalCardApplyEdits,
    isKnownCardField,
    resolveCurrentCharacter,
} from './card-world.js';
import {
    buildCeaEditorToolSet,
    normalizeToolCallToEdit,
    resolveBookNameFromArgsOrSingle,
    runCeaEditorReadTool,
} from './card-tools.js';

const defaultGetContext = () => globalThis.Luker?.getContext?.() ?? globalThis.lukerContext ?? null;
const fnName = (t) => t?.function?.name;

function applyEditsTo(edits, live, ctx) {
    const applyFn = getLocalCardApplyEdits(ctx);
    const res = applyFn(edits, safeClone(live));
    if (res?.conflicts?.length) {
        const c = res.conflicts[0];
        throw new SourceError('conflict', i18nFormat('Not changed (${0}): ${1}. Read the latest content first.', c.reason, c.edit?.path || ''));
    }
    return res.newLive;
}

function hasSearchTools(ctx) {
    const api = ctx?.searchTools || globalThis?.Luker?.searchTools;
    return Boolean(
        api
        && typeof api === 'object'
        && typeof api.getToolDefs === 'function'
        && typeof api.isToolName === 'function'
        && typeof api.invoke === 'function'
        && String(api?.toolNames?.SEARCH || '').trim(),
    );
}

/**
 * Creates the platform `card` IterateTarget.
 * @param {{ getContext?: () => object | null, bookIo?: object | null }} [opts]
 */
export function createCardTarget({ getContext = defaultGetContext, bookIo = null } = {}) {
    const resolveCtx = (explicitCtx = null) => explicitCtx || getContext();
    const resolveBookIo = () => bookIo || createWorldBookIo(() => resolveCtx());

    return {
        id: 'card',
        get label() { return i18n('Character card'); },
        tone: 'card',
        order: 40,
        chips: () => [
            i18n('This reply is not like her — find out why'),
            i18n('Tighten the description and remove repetition'),
            i18n('Add some example dialogue'),
            i18n('Check the world books for conflicts'),
        ],
        scopeNotes: {
            character: () => i18n('Edit this character\'s card and bound world books'),
        },
        async scopes(ctx) {
            const c = resolveCtx(ctx);
            return { character: Boolean(resolveCurrentCharacter(c)) };
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
            const stored = String(s?.editorIterationSystemPrompt ?? '');
            const custom = Boolean(stored) && stored !== DEFAULT_CARD_SYSTEM_PROMPT.trim();
            return {
                from: i18nFormat('Built into Luker · ${0}', i18n('"Edit iteration prompt" in Character Assistant settings')),
                custom,
                text: stored,
            };
        },
        async load(_scope, ctx) {
            const c = resolveCtx(ctx);
            const cur = resolveCurrentCharacter(c);
            if (!cur) throw new SourceError('no-character', i18n('No character card selected'));
            const live = await buildCardLiveSnapshot(c, cur.avatar, { includeBoundBooks: true });
            const bookCount = Object.keys(live.lorebooks || {}).length;
            return {
                live,
                target: { scope: 'character', avatar: cur.avatar },
                title: i18nFormat(
                    'Character card of "${0}"${1}',
                    cur.name,
                    bookCount ? i18nFormat(' · ${0} world books', bookCount) : '',
                ),
            };
        },
        async prompt(_live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const s = c?.extensionSettings?.character_editor_assistant;
            return requireStoredPrompt(s?.editorIterationSystemPrompt, i18n('Fill in the prompt or reset it to the default.'));
        },
        async tools(_live, _scope, ctx) {
            const c = resolveCtx(ctx);
            const searchReady = hasSearchTools(c);
            const set = buildCeaEditorToolSet(c, c?.extensionSettings?.character_editor_assistant || {}, {
                hasSearchTools: searchReady,
            });
            return searchReady ? set : set.filter((d) => fnName(d) !== 'web_search');
        },
        isRead: (name) => /^(cea_read_|lorebook_|world_book_|simulate_|inspect_|web_search$)/.test(String(name || '')),
        async runRead(call, live) {
            const c = resolveCtx();
            const cur = resolveCurrentCharacter(c);
            const settings = c?.extensionSettings?.character_editor_assistant || {};
            const res = await runCeaEditorReadTool(
                { id: call?.id, name: call?.name, args: call?.args || {} },
                {
                    context: c,
                    settings,
                    avatar: cur?.avatar || live?.character?.avatar || '',
                    state: { live },
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
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            if (name.startsWith('cea_') && name.includes('lorebook')) {
                const allowedBooks = Object.keys(live?.lorebooks || {});
                const book = resolveBookNameFromArgsOrSingle(args, live);
                if (!book) {
                    throw new SourceError(
                        'bad-args',
                        allowedBooks.length
                            ? `missing book_name: specify one of ${allowedBooks.join(', ')}`
                            : 'missing book_name: no world books are bound to this character',
                    );
                }
                if (!Object.hasOwn(live?.lorebooks || {}, book)) {
                    throw new SourceError(
                        'book',
                        i18nFormat('Only these can be edited: ${0}', allowedBooks.join(listSeparator())),
                    );
                }
            }
            const edits = await normalizeToolCallToEdit(
                { id: call?.id, name, args },
                { context: c, live },
            );
            if (!edits) throw new SourceError('bad-args', i18n('Invalid arguments'));
            const next = safeClone(live) || { character: {}, lorebooks: {} };
            next.character ||= {};
            next.lorebooks ||= {};

            for (const e of edits) {
                if (e?.target?.kind === 'lorebook') {
                    const book = String(e.target.bookName || '').trim();
                    const allowedBooks = Object.keys(next.lorebooks);
                    if (!book) {
                        throw new SourceError(
                            'bad-args',
                            allowedBooks.length
                                ? `missing book_name: specify one of ${allowedBooks.join(', ')}`
                                : 'missing book_name: no world books are bound to this character',
                        );
                    }
                    if (!Object.hasOwn(next.lorebooks, book)) {
                        throw new SourceError(
                            'book',
                            i18nFormat('Only these can be edited: ${0}', allowedBooks.join(listSeparator())),
                        );
                    }
                    const rel = { ...e, path: String(e.path).replace(/^lorebook\./, '') };
                    next.lorebooks[book] = applyEditsTo([rel], next.lorebooks[book], c);
                } else {
                    const relPath = String(e.path).replace(/^card\./, '');
                    const rel = { ...e, path: relPath };
                    next.character = applyEditsTo([rel], next.character, c);
                    if (isKnownCardField(relPath) && next.character.data && typeof next.character.data === 'object') {
                        next.character.data[relPath] = safeClone(next.character[relPath]);
                    }
                }
            }
            return next;
        },
        units: (live) => cardUnits(live),
        rebuild: (base, ai, keys) => cardRebuild(base, ai, keys),
        async commit(targetRef, base, next, keys) {
            const io = resolveBookIo();
            return commitCardAndBooks(cardEditsFor(base, next, keys), {
                commitCard(edits) {
                    const c = resolveCtx();
                    const liveCharacter = (c?.characters || []).find((ch) => ch?.avatar === targetRef.avatar) || null;
                    return commitCharacterOperations(c, targetRef.avatar, edits, { liveCharacter });
                },
                ...io,
            });
        },
    };
}

export const cardTarget = createCardTarget();
