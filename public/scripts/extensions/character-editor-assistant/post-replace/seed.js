// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

// Post-replace seed message: the prose prev/next diff the merge studio sends
// as the AI's first-turn brief.

import { lorebookHelpers } from '../../../iteration-library/tools/_lorebook-helpers.js';
import { mdLiteral } from '../../../iteration-library/markdown-escape.js';
import { i18n, i18nFormat } from '../i18n.js';

async function loadLorebookData(context, bookName) {
    const data = await context.loadWorldInfo(bookName);
    if (data && typeof data === 'object') {
        if (!data.entries || typeof data.entries !== 'object') {
            data.entries = {};
        }
        return data;
    }
    return { entries: {} };
}

const CHARACTER_DIFF_TOP_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']);
const CHARACTER_DIFF_DATA_FIELDS = Object.freeze(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions']);
const LOREBOOK_ENTRY_DIFF_FIELDS = Object.freeze(['comment', 'content', 'key', 'keysecondary', 'order', 'position', 'depth', 'disable', 'constant', 'selective', 'selectiveLogic', 'probability', 'useProbability', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion']);

// Post-replace seed diffs feed the LLM's very first turn and drive the
// entire reconciliation plan. Silent truncation here hid the actual
// content of changed fields / entries so the model could only see "X
// changed" without seeing what X changed *to* — which produced generic,
// hand-wavy plans that couldn't reference specific curated lines. We
// now render prev/next verbatim and let the model handle length. The
// seed is a one-shot message; the context-window cost is bounded by
// the card and lorebook themselves.
function diffExcerpt(value) {
    const text = String(value ?? '');
    if (!text.trim()) return '(empty)';
    return text;
}

function fieldsEqualForDiff(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (String(a[i] ?? '') !== String(b[i] ?? '')) return false;
        }
        return true;
    }
    return String(a ?? '') === String(b ?? '');
}

function pickCharacterDiffFields(character) {
    if (!character || typeof character !== 'object') return {};
    const out = {};
    for (const key of CHARACTER_DIFF_TOP_FIELDS) {
        const value = character[key];
        if (value !== undefined && value !== null && value !== '') {
            out[key] = value;
        }
    }
    const data = character.data && typeof character.data === 'object' ? character.data : {};
    for (const key of CHARACTER_DIFF_DATA_FIELDS) {
        const value = data[key];
        if (value !== undefined && value !== null && value !== '') {
            out[`data.${key}`] = value;
        }
    }
    return out;
}

export function summarizeCharacterDiff(prevCharacter, nextCharacter) {
    const prev = pickCharacterDiffFields(prevCharacter);
    const next = pickCharacterDiffFields(nextCharacter);
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    const lines = [];
    // Multi-line prose fields (description / personality / scenario /
    // first_mes / mes_example / creator_notes / system_prompt /
    // post_history_instructions) get their prev/next values inside
    // fenced blocks so the model sees the full unmodified text. Short
    // scalar fields (like `name`) stay on inline arrow-diff lines.
    const emitFieldDump = (key, prevVal, nextVal, kind /* 'changed' | 'added' | 'removed' */) => {
        const prevText = String(prevVal ?? '');
        const nextText = String(nextVal ?? '');
        const multiline = prevText.includes('\n') || nextText.includes('\n') || prevText.length > 200 || nextText.length > 200;
        let heading;
        if (kind === 'changed') heading = i18nFormat('Field changed: ${0}', mdLiteral(key));
        else if (kind === 'added') heading = i18nFormat('Field added: ${0}', mdLiteral(key));
        else heading = i18nFormat('Field removed: ${0}', mdLiteral(key));
        lines.push(`- ${heading}`);
        if (multiline) {
            if (kind !== 'added') {
                lines.push('    - prev:');
                lines.push('      ```');
                lines.push(prevText || '(empty)');
                lines.push('      ```');
            }
            if (kind !== 'removed') {
                lines.push('    - next:');
                lines.push('      ```');
                lines.push(nextText || '(empty)');
                lines.push('      ```');
            }
        } else {
            if (kind !== 'added') lines.push(`    - prev: ${mdLiteral(prevText || '(empty)')}`);
            if (kind !== 'removed') lines.push(`    - next: ${mdLiteral(nextText || '(empty)')}`);
        }
    };
    for (const key of [...keys].sort()) {
        const hadPrev = Object.prototype.hasOwnProperty.call(prev, key);
        const hadNext = Object.prototype.hasOwnProperty.call(next, key);
        if (hadPrev && hadNext) {
            if (!fieldsEqualForDiff(prev[key], next[key])) {
                emitFieldDump(key, prev[key], next[key], 'changed');
            }
        } else if (hadNext) {
            emitFieldDump(key, undefined, next[key], 'added');
        } else {
            emitFieldDump(key, prev[key], undefined, 'removed');
        }
    }
    return lines;
}

function summarizeLorebookEntryDiff(prevEntry, nextEntry) {
    const prevNorm = lorebookHelpers.normalizeEntryForSync(prevEntry, prevEntry?.uid);
    const nextNorm = lorebookHelpers.normalizeEntryForSync(nextEntry, nextEntry?.uid);
    const changed = [];
    for (const key of LOREBOOK_ENTRY_DIFF_FIELDS) {
        if (!fieldsEqualForDiff(prevNorm[key], nextNorm[key])) {
            changed.push(key);
        }
    }
    return changed;
}

function entryLabel(entry) {
    const comment = String(entry?.comment ?? '').trim();
    if (comment) return diffExcerpt(comment);
    const keys = Array.isArray(entry?.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (keys) return diffExcerpt(keys);
    return '(no label)';
}

// Emit prev/next full text for a field-level per-uid diff. Multi-line
// content stays as-is (no whitespace collapse) so the model sees the
// user-curated structure verbatim — that's the whole point of the
// reconciliation seed. Empty values render as `(empty)` so absence is
// distinguishable from "same content".
function appendPrevNextField(lines, label, prevVal, nextVal) {
    lines.push(`    - ${label}: ${mdLiteral(String(label))}`);
    lines.push('      prev:');
    lines.push('      ```');
    lines.push(String(prevVal ?? ''));
    lines.push('      ```');
    lines.push('      next:');
    lines.push('      ```');
    lines.push(String(nextVal ?? ''));
    lines.push('      ```');
}

function renderLorebookEntryFullDump(lines, headingPrefix, uid, entry) {
    const label = entryLabel(entry);
    lines.push(`- ${i18nFormat('${0} (uid ${1}): ${2}', headingPrefix, uid, mdLiteral(label))}`);
    const norm = lorebookHelpers.normalizeEntryForSync(entry, entry?.uid);
    for (const key of LOREBOOK_ENTRY_DIFF_FIELDS) {
        const value = norm[key];
        if (value == null) continue;
        const isEmptyString = typeof value === 'string' && value === '';
        const isEmptyArray = Array.isArray(value) && value.length === 0;
        if (isEmptyString || isEmptyArray) continue;
        if (key === 'content' || key === 'comment') {
            lines.push(`    - ${mdLiteral(key)}:`);
            lines.push('      ```');
            lines.push(String(value ?? ''));
            lines.push('      ```');
        } else if (Array.isArray(value)) {
            lines.push(`    - ${mdLiteral(key)}: ${mdLiteral(value.join(', '))}`);
        } else {
            lines.push(`    - ${mdLiteral(key)}: ${mdLiteral(String(value))}`);
        }
    }
}

export function summarizeLorebookDiff(prevSnapshot, nextLorebookData, prevBookName, nextBookName) {
    const lines = [];
    const prevName = String(prevBookName || '').trim();
    const nextName = String(nextBookName || '').trim();
    const prevLabel = prevName ? mdLiteral(prevName) : '`(none)`';
    const nextLabel = nextName ? mdLiteral(nextName) : '`(none)`';
    if (prevName !== nextName) {
        lines.push(`- ${i18nFormat('Primary world book: ${0} → ${1}', prevLabel, nextLabel)}`);
    }
    const prevEntries = prevSnapshot && typeof prevSnapshot === 'object' && prevSnapshot.entries && typeof prevSnapshot.entries === 'object'
        ? prevSnapshot.entries
        : {};
    const nextEntries = nextLorebookData && typeof nextLorebookData === 'object' && nextLorebookData.entries && typeof nextLorebookData.entries === 'object'
        ? nextLorebookData.entries
        : {};

    if (prevName === nextName) {
        // Same book name → uid identity is meaningful, diff per uid so
        // the model sees exactly which entries were touched.
        const uids = new Set([...Object.keys(prevEntries), ...Object.keys(nextEntries)]);
        for (const uid of [...uids].sort((a, b) => Number(a) - Number(b))) {
            const prevEntry = prevEntries[uid];
            const nextEntry = nextEntries[uid];
            if (prevEntry && !nextEntry) {
                renderLorebookEntryFullDump(lines, i18n('Entry removed'), uid, prevEntry);
            } else if (!prevEntry && nextEntry) {
                renderLorebookEntryFullDump(lines, i18n('Entry added'), uid, nextEntry);
            } else if (prevEntry && nextEntry) {
                const changedFields = summarizeLorebookEntryDiff(prevEntry, nextEntry);
                if (changedFields.length) {
                    lines.push(`- ${i18nFormat('Entry changed (uid ${0}): ${1}', uid, mdLiteral(entryLabel(nextEntry)))}`);
                    const prevNorm = lorebookHelpers.normalizeEntryForSync(prevEntry, prevEntry?.uid);
                    const nextNorm = lorebookHelpers.normalizeEntryForSync(nextEntry, nextEntry?.uid);
                    for (const key of changedFields) {
                        const prevValRaw = prevNorm[key];
                        const nextValRaw = nextNorm[key];
                        const prevText = Array.isArray(prevValRaw) ? prevValRaw.join(', ') : String(prevValRaw ?? '');
                        const nextText = Array.isArray(nextValRaw) ? nextValRaw.join(', ') : String(nextValRaw ?? '');
                        if (key === 'content' || key === 'comment' || prevText.includes('\n') || nextText.includes('\n')) {
                            appendPrevNextField(lines, key, prevText, nextText);
                        } else {
                            lines.push(`    - ${mdLiteral(key)}: \`${mdLiteral(prevText || '(empty)')}\` → \`${mdLiteral(nextText || '(empty)')}\``);
                        }
                    }
                }
            }
        }
        return lines;
    }

    // Different book names → uid identity is NOT meaningful (uid 5 in
    // book A is unrelated to uid 5 in book B). Dump both sides in
    // full so the model can do content-based reconciliation across
    // the rename. This is verbose but it's the only faithful way to
    // convey "here's everything you had, here's everything you have
    // now, decide what to migrate".
    const prevUids = Object.keys(prevEntries).sort((a, b) => Number(a) - Number(b));
    const nextUids = Object.keys(nextEntries).sort((a, b) => Number(a) - Number(b));
    if (prevUids.length > 0) {
        lines.push('');
        lines.push(`- ${i18nFormat('Previous world book ${0} (${1} entries):', prevLabel, String(prevUids.length))}`);
        for (const uid of prevUids) {
            renderLorebookEntryFullDump(lines, i18n('prev entry'), uid, prevEntries[uid]);
        }
    }
    if (nextUids.length > 0) {
        lines.push('');
        lines.push(`- ${i18nFormat('Next world book ${0} (${1} entries):', nextLabel, String(nextUids.length))}`);
        for (const uid of nextUids) {
            renderLorebookEntryFullDump(lines, i18n('next entry'), uid, nextEntries[uid]);
        }
    }
    return lines;
}

/**
 * Resolve the "next" world book contents used for post-replace comparisons.
 *
 * The new card's authoritative book content is `nextCharacter.data.character_book`
 * (V2/V3 spec slot). Read it directly via convertCharacterBook so the diff
 * always compares against what the new card actually carries — independent
 * of whether the OPEN_EDITOR branch's pre-materialize step ran, whether
 * the disk file is the same content, or whether the new book name collides
 * with a different local book the user already had. Fall back to disk only
 * when the card carries no embedded book (i.e. it ships referring to a
 * pre-existing local book by name).
 *
 * Extracted from buildPostReplaceSeedMessage so both the seed prose builder
 * and the structured replace-diff overview (UI-facing) get the same shape
 * for the "next" book, i.e. neither view drifts from the other on cards
 * whose embedded book is authoritative vs the disk fallback.
 *
 * @param {Object} context
 * @param {Object} nextCharacter  V2/V3 card imported by the replace.
 * @returns {Promise<{ entries: Object }>}
 */
export async function resolvePostReplaceNextLorebookData(context, nextCharacter) {
    const __ctx = Luker.getContext();
    let nextLorebookData = { entries: {} };
    const embeddedBook = nextCharacter?.data?.character_book;
    const embeddedHasEntries = embeddedBook
        && Array.isArray(embeddedBook.entries)
        && embeddedBook.entries.length > 0;
    if (embeddedHasEntries && typeof __ctx?.convertCharacterBook === 'function') {
        // Conversion assigns missing identifiers; diff preparation must
        // leave the initiating embedded source unchanged.
        const converted = __ctx.convertCharacterBook(JSON.parse(JSON.stringify(embeddedBook)));
        if (converted && typeof converted === 'object' && converted.entries) {
            nextLorebookData = { entries: converted.entries };
        }
    }
    const nextBookName = String(nextCharacter?.data?.extensions?.world || '').trim();
    if (!Object.keys(nextLorebookData.entries).length && nextBookName) {
        nextLorebookData = await loadLorebookData(context, nextBookName);
    }
    return nextLorebookData;
}

export async function buildPostReplaceSeedMessage(context, detail) {
    const previousCharacter = detail?.previousCharacter && typeof detail.previousCharacter === 'object'
        ? detail.previousCharacter
        : null;
    const previousLorebookSnapshot = detail?.previousLorebookSnapshot && typeof detail.previousLorebookSnapshot === 'object'
        ? detail.previousLorebookSnapshot
        : null;
    const nextCharacter = detail?.character && typeof detail.character === 'object' ? detail.character : null;
    if (!previousCharacter) {
        // First-time import or the upload path didn't capture a prev snapshot — no diff to show.
        return i18n('Just imported this card — review the baseline and suggest tweaks.');
    }
    const nextBookName = String(nextCharacter?.data?.extensions?.world || '').trim();
    const prevBookName = String(previousLorebookSnapshot?.bookName || previousCharacter?.data?.extensions?.world || '').trim();

    const nextLorebookData = await resolvePostReplaceNextLorebookData(context, nextCharacter);

    const cardLines = summarizeCharacterDiff(previousCharacter, nextCharacter);
    const bookLines = summarizeLorebookDiff(previousLorebookSnapshot, nextLorebookData, prevBookName, nextBookName);
    const sections = [
        i18n('You are running a post-replace iteration. The user replaced their character card with a new version. Your job is to help the user reconcile the previous version (prev, the one they were actually using) with the new version (next, the one they just imported) — but DO NOT touch the card or world book on this first turn.'),
        '',
        i18n('Direction convention used throughout this seed message and the diffs below:'),
        i18n('- `prev` / "previous" / 旧 = the version the user was actually using until just now. May contain edits, additions, and refinements the user made by hand.'),
        i18n('- `next` / "current" / 新 = the version that was just imported. Treat this as the new baseline.'),
        '',
        i18n('This first turn — REVIEW ONLY, no tool calls:'),
        i18n('1. Read the diff below and summarize for the user what actually changed between prev and next (card fields + world book entries).'),
        i18n('2. Flag specific entries / fields where prev contains user-curated content that next does not have, or has in a regressed form — those are migration candidates.'),
        i18n('3. Propose a concrete reconciliation plan in plain text: which prev-only items would you migrate into next, which prev-vs-next conflicts you would keep as next, and anything you would leave to the user to decide.'),
        i18n('4. End the turn with a plain text message and NO tool calls. The user will read your summary and either approve the plan, refine it, or ask for specific changes.'),
        '',
        i18n('Only on subsequent turns — after the user replies — apply the agreed changes with `cea_*` tools. Use `cea_add_lorebook_entry` / `cea_update_lorebook_entry` for world book entries. Follow the migration policy:'),
        i18n('- Migrate prev-only curated content into next.'),
        i18n('- Keep next\'s genuine improvements.'),
        i18n('- On conflicts, prefer next unless prev is obviously hand-curated and richer.'),
        i18n('- Never dump prev wholesale into next — that defeats the point of accepting a new version.'),
    ];
    if (cardLines.length) {
        sections.push('');
        sections.push(i18n('Character card diff (previous → current):'));
        sections.push(...cardLines);
    }
    if (bookLines.length) {
        sections.push('');
        sections.push(i18n('World book diff (previous → current):'));
        sections.push(...bookLines);
    }
    if (!cardLines.length && !bookLines.length) {
        sections.push('');
        sections.push(i18n('(no human-readable changes detected)'));
    }
    return sections.join('\n');
}
