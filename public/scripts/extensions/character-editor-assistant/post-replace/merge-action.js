// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { MODULE_NAME } from '../constants.js';
import { i18n, i18nFormat } from '../i18n.js';
import { buildPostReplaceSeedMessage, resolvePostReplaceNextLorebookData } from './seed.js';

const __ctx = Luker.getContext();
const getContext = Luker.getContext;

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message || ''));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message || ''));
    }
}

function notifyWarning(message) {
    if (typeof toastr !== 'undefined') toastr.warning(message);
}

/**
 * Build the "Merge in editor" action registered with the core post-replace
 * registry. The core owns the popup, availability and error envelope;
 * everything beyond the decision (materialize the new card's embedded book,
 * seed the diff, open the studio, roll back when the user closes without
 * applying) stays here.
 */
export function buildPostReplaceMergeAction({ openCharacterEditorPopup } = {}) {
    return {
        id: 'character-editor-assistant-merge',
        label: () => i18n('Merge in editor'),
        description: () => i18n('Open the iteration studio with a prev vs next diff so an AI can carry your earlier edits forward into the new book. Use when you have hand-curated additions to preserve.'),
        isAvailable: () => true,
        run: async (detail) => {
            const context = getContext();
            const nextCharacter = detail?.character && typeof detail.character === 'object' ? detail.character : null;
            const avatar = String(nextCharacter?.avatar || '').trim();
            if (!avatar) {
                throw new Error('post-replace merge action: character avatar is unavailable');
            }
            const characters = Array.isArray(context?.characters) ? context.characters : (Array.isArray(__ctx.characters) ? __ctx.characters : []);
            let chid = Number.isInteger(detail?.characterId) ? detail.characterId : -1;
            if (chid < 0 || String(characters[chid]?.avatar || '').trim() !== avatar) {
                chid = characters.findIndex(c => String(c?.avatar || '').trim() === avatar);
            }
            if (chid < 0) {
                throw new Error('post-replace merge action: replaced character not found in characters list');
            }
            const targetCharacter = characters[chid];

            const previousLorebookSnapshot = detail?.previousLorebookSnapshot && typeof detail.previousLorebookSnapshot === 'object'
                ? detail.previousLorebookSnapshot
                : null;
            const previousBookName = String(previousLorebookSnapshot?.bookName || detail?.previousCharacter?.data?.extensions?.world || '').trim();
            const hasNewEmbeddedBook = Boolean(nextCharacter?.data?.character_book
                && Array.isArray(nextCharacter.data.character_book.entries)
                && nextCharacter.data.character_book.entries.length > 0);

            // Materialize the new card's embedded book FIRST so the diff the
            // AI sees compares the real prev book entries against the real new
            // book entries. Skip the import only when (a) the new card carries
            // no embedded book, (b) its bookName equals the previous bookName
            // (importing would overwrite the book the user may still want to
            // keep), or (c) the name already exists locally as a different
            // book the user manages — overwriting a third-party book the user
            // owns would be data loss.
            const newEmbeddedBookName = String(nextCharacter?.data?.character_book?.name || '').trim();
            const newBindingTarget = String(nextCharacter?.data?.extensions?.world || '').trim();
            const effectiveNewBookName = newEmbeddedBookName || newBindingTarget;
            const shouldMaterializeNewBook = hasNewEmbeddedBook
                && effectiveNewBookName
                && effectiveNewBookName !== previousBookName
                && !worldBookExists(context, effectiveNewBookName);
            let materializedBookName = '';
            let ownership;
            if (shouldMaterializeNewBook) {
                const importEmbeddedBook = context?.importEmbeddedBookForCharacter;
                if (typeof importEmbeddedBook !== 'function') {
                    throw new Error('importEmbeddedBookForCharacter is unavailable');
                }
                const outcome = await importEmbeddedBook(chid, nextCharacter, { captureOwnership: true });
                if (!outcome.imported) throw new Error(i18n('The embedded world book import could not be confirmed. Reopen the character and retry.'));
                // A saved book with an unacknowledged binding is a partial
                // import. Keep the file and the importer's failure feedback.
                if (!outcome.bound) return;
                materializedBookName = outcome.bookName;
                ownership = outcome.ownership;
            }

            // Close-without-applying rollback: re-bind the previous book and
            // delete the book file we materialized. Applied even a single
            // edit -> the user chose to iterate on the new book; rollback is
            // skipped by the studio's hasEverApplied gate.
            const postReplaceRollback = materializedBookName
                ? async () => {
                    let restored = false;
                    try {
                        const current = getContext();
                        const targetId = current.characters.indexOf(targetCharacter);
                        if (targetId < 0 || !ownership.isCurrent()) {
                            notifyWarning(i18nFormat('Cancelled — cleanup stopped for imported world book: ${0}. Its binding or source changed.', materializedBookName));
                            return;
                        }
                        await current.rebindPreviousPrimaryBook(targetId, previousBookName, targetCharacter, { ownership });
                        restored = true;
                        if (!await current.deleteWorldBook(materializedBookName, { expectedVersion: ownership.world.version, onlyIfUnbound: true })) throw new Error(i18nFormat('Could not delete imported world book: ${0}', materializedBookName));
                        notifySuccess(i18nFormat('Cancelled — restored previous world book: ${0}', previousBookName || '(none)'));
                    } catch (err) {
                        if (restored && err.resourceState === 'present' && ['world_changed', 'world_in_use'].includes(err.code)) {
                            notifyWarning(i18nFormat('Previous binding acknowledged: ${0}. Imported world book retained: ${1}.', previousBookName || '(none)', materializedBookName));
                            return;
                        }
                        console.error(`[${MODULE_NAME}] merge rollback failed`, err);
                        const acknowledged = restored ? i18nFormat('Previous binding acknowledged: ${0}.', previousBookName || '(none)') : '';
                        const outcome = !restored
                            ? i18nFormat('Cleanup stopped before deletion of imported world book: ${0}.', materializedBookName)
                            : err.resourceState === 'present'
                                ? i18nFormat('Imported world book retained: ${0}.', materializedBookName)
                                : err.resourceState === 'missing'
                                    ? i18nFormat('Imported world book is already absent: ${0}.', materializedBookName)
                                    : i18nFormat('Deletion outcome unknown for imported world book: ${0}. Reload the world book list before retrying cleanup.', materializedBookName);
                        notifyError(i18nFormat('Rollback failed: ${0}', [acknowledged, err?.message || err, outcome].filter(Boolean).join(' ')));
                    }
                }
                : null;

            let opened = null;
            try {
                const seedSystemMessage = await buildPostReplaceSeedMessage(context, detail);
                // Structured replace context for the studio's "View full replace
                // diff" button; same helpers as the seed builder so both describe
                // the same "next" book.
                const replaceContext = detail?.previousCharacter
                    ? {
                        previousCharacter: detail.previousCharacter,
                        previousLorebookSnapshot: detail.previousLorebookSnapshot || null,
                        nextCharacter: detail?.character || null,
                        nextLorebookData: await resolvePostReplaceNextLorebookData(context, detail?.character || null),
                    }
                    : null;
                opened = await openCharacterEditorPopup(context, {
                    avatar,
                    seedSystemMessage,
                    // The seed message is a long prose brief for the LLM; the
                    // user gets the structured form via "View full replace diff".
                    hideSeedFromUi: true,
                    autoSend: true,
                    postReplaceRollback,
                    replaceContext,
                });
            } catch (err) {
                if (typeof postReplaceRollback === 'function') {
                    await postReplaceRollback();
                }
                throw err;
            }
            if (!opened && typeof postReplaceRollback === 'function') {
                await postReplaceRollback();
            }
        },
    };
}

export function registerPostReplaceMergeAction(context, { openCharacterEditorPopup }) {
    if (typeof context?.registerPostReplaceAction !== 'function') {
        return;
    }
    context.registerPostReplaceAction(buildPostReplaceMergeAction({ openCharacterEditorPopup }));
}

function worldBookExists(context, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    const getNames = typeof context?.getWorldInfoNames === 'function'
        ? () => context.getWorldInfoNames()
        : (typeof __ctx?.getWorldInfoNames === 'function' ? () => __ctx.getWorldInfoNames() : null);
    if (!getNames) return false;
    const names = getNames();
    return Array.isArray(names) && names.some(n => String(n || '').trim() === trimmed);
}
