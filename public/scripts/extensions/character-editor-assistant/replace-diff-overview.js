/**
 * Post-replace "full diff overview" — user-facing visualization of
 * previous vs current character card + world book, opened from a
 * button in the CEA editor popup topbar.
 *
 * Complement to the seed system message: the seed is prose written
 * for the LLM to read; this overview is structured, per-field /
 * per-entry, with the same line-diff visual affordances the studio
 * uses for per-edit proposal cards (renderLineDiffHtml from
 * diff-ui.js) so the user sees exactly what changed with side-by-
 * side highlight, expandable rows, etc.
 *
 * The model builder here mirrors summarizeCharacterDiff /
 * summarizeLorebookDiff (main.js) but returns structured data
 * instead of prose lines, so the renderer can produce interactive
 * UI (details / cards / expand affordances) rather than markdown.
 */

const CARD_FIELDS_TO_DIFF = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
    'system_prompt',
    'post_history_instructions',
    'tags',
    'creator',
    'character_version',
    'alternate_greetings',
];

const LOREBOOK_ENTRY_FIELDS = ['comment', 'content', 'keys', 'secondary_keys'];
const LOREBOOK_ENTRY_META_FIELDS = ['constant', 'selective', 'enabled', 'position', 'insertion_order', 'depth', 'probability'];

function normalizeFieldValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(v => normalizeFieldValue(v)).join('\n');
    if (typeof value === 'object') {
        try { return JSON.stringify(value, null, 2); } catch { return String(value); }
    }
    return String(value);
}

function readCardField(character, field) {
    if (!character || typeof character !== 'object') return '';
    if (field === 'creator_notes') {
        const notes = character?.data?.creator_notes ?? character?.creatorcomment ?? character?.creator_notes ?? '';
        return normalizeFieldValue(notes);
    }
    if (field === 'system_prompt') {
        return normalizeFieldValue(character?.data?.system_prompt ?? character?.system_prompt ?? '');
    }
    if (field === 'post_history_instructions') {
        return normalizeFieldValue(character?.data?.post_history_instructions ?? character?.post_history_instructions ?? '');
    }
    if (field === 'tags') {
        const tags = character?.data?.tags ?? character?.tags ?? [];
        return normalizeFieldValue(tags);
    }
    if (field === 'creator') {
        return normalizeFieldValue(character?.data?.creator ?? character?.creator ?? '');
    }
    if (field === 'character_version') {
        return normalizeFieldValue(character?.data?.character_version ?? character?.character_version ?? '');
    }
    if (field === 'alternate_greetings') {
        const alts = character?.data?.alternate_greetings ?? character?.alternate_greetings ?? [];
        return normalizeFieldValue(alts);
    }
    // For the common visible V2 fields (description / personality / scenario /
    // first_mes / mes_example / name), the V2/V3 shape puts them under
    // `data.<field>` and legacy cards mirror them at the top level. Prefer
    // the nested slot, fall back to top-level, then empty string.
    return normalizeFieldValue(character?.data?.[field] ?? character?.[field] ?? '');
}

/**
 * Build a structured diff model from a post-replace replaceContext.
 *
 * @param {Object} replaceContext
 * @param {Object} [replaceContext.previousCharacter]  V2/V3 card as loaded before the replace.
 * @param {Object} [replaceContext.nextCharacter]      V2/V3 card imported by the replace.
 * @param {Object} [replaceContext.previousLorebookSnapshot]  { bookName, entries } snapshot before replace.
 * @param {Object} [replaceContext.nextLorebookData]   { entries } snapshot of the current bound book.
 * @returns {{
 *   hasChanges: boolean,
 *   card: { previousName: string, nextName: string, fields: Array<{ key: string, previous: string, next: string }> },
 *   book: { previousName: string, nextName: string, renamed: boolean, added: Array<Object>, removed: Array<Object>, changed: Array<{ uid: string, previous: Object, next: Object, changedFields: string[] }>, unchangedCount: number }
 * }}
 */
export function buildReplaceDiffModel(replaceContext) {
    const previousCharacter = replaceContext?.previousCharacter && typeof replaceContext.previousCharacter === 'object'
        ? replaceContext.previousCharacter
        : null;
    const nextCharacter = replaceContext?.nextCharacter && typeof replaceContext.nextCharacter === 'object'
        ? replaceContext.nextCharacter
        : null;
    const previousBook = replaceContext?.previousLorebookSnapshot && typeof replaceContext.previousLorebookSnapshot === 'object'
        ? replaceContext.previousLorebookSnapshot
        : null;
    const nextBook = replaceContext?.nextLorebookData && typeof replaceContext.nextLorebookData === 'object'
        ? replaceContext.nextLorebookData
        : null;

    // ── Card diff ──
    const cardFields = [];
    if (previousCharacter || nextCharacter) {
        for (const field of CARD_FIELDS_TO_DIFF) {
            const prev = readCardField(previousCharacter, field);
            const next = readCardField(nextCharacter, field);
            if (prev !== next) {
                cardFields.push({ key: field, previous: prev, next });
            }
        }
    }

    // ── Book diff ──
    const prevBookName = String(previousBook?.bookName || previousCharacter?.data?.extensions?.world || '').trim();
    const nextBookName = String(nextCharacter?.data?.extensions?.world || '').trim();
    const prevEntries = (previousBook && previousBook.entries && typeof previousBook.entries === 'object') ? previousBook.entries : {};
    const nextEntries = (nextBook && nextBook.entries && typeof nextBook.entries === 'object') ? nextBook.entries : {};

    // Match entries by uid. If the book was renamed the uids may collide but
    // point to unrelated content — that's expected; we still surface the
    // per-uid diff so the user can eyeball what stayed vs shifted.
    const prevUids = Object.keys(prevEntries);
    const nextUids = Object.keys(nextEntries);
    const prevUidSet = new Set(prevUids);
    const nextUidSet = new Set(nextUids);

    const removed = [];
    const added = [];
    const changed = [];
    let unchangedCount = 0;

    for (const uid of prevUids) {
        if (!nextUidSet.has(uid)) {
            removed.push({ uid, entry: prevEntries[uid] });
        }
    }
    for (const uid of nextUids) {
        if (!prevUidSet.has(uid)) {
            added.push({ uid, entry: nextEntries[uid] });
            continue;
        }
        const prevEntry = prevEntries[uid];
        const nextEntry = nextEntries[uid];
        const changedFields = [];
        for (const field of [...LOREBOOK_ENTRY_FIELDS, ...LOREBOOK_ENTRY_META_FIELDS]) {
            const a = normalizeFieldValue(prevEntry?.[field]);
            const b = normalizeFieldValue(nextEntry?.[field]);
            if (a !== b) changedFields.push(field);
        }
        if (changedFields.length > 0) {
            changed.push({ uid, previous: prevEntry, next: nextEntry, changedFields });
        } else {
            unchangedCount += 1;
        }
    }

    const bookRenamed = Boolean(prevBookName && nextBookName && prevBookName !== nextBookName);

    return {
        hasChanges: cardFields.length > 0 || added.length > 0 || removed.length > 0 || changed.length > 0 || bookRenamed,
        card: {
            previousName: String(previousCharacter?.name || previousCharacter?.data?.name || ''),
            nextName: String(nextCharacter?.name || nextCharacter?.data?.name || ''),
            fields: cardFields,
        },
        book: {
            previousName: prevBookName,
            nextName: nextBookName,
            renamed: bookRenamed,
            added,
            removed,
            changed,
            unchangedCount,
        },
    };
}

function escapeHtmlInline(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function renderEntryHeading({ uid, entry, label, escapeHtml, i18nFormat }) {
    const commentOrKey = String(entry?.comment || (Array.isArray(entry?.keys) ? entry.keys.join(', ') : '') || i18nFormat('(untitled entry)')).trim();
    return `<div class="cea_replace_diff_entry_heading">
        <span class="cea_replace_diff_entry_label">${escapeHtml(label)}</span>
        <span class="cea_replace_diff_entry_uid">uid ${escapeHtml(String(uid))}</span>
        <span class="cea_replace_diff_entry_title">${escapeHtml(commentOrKey)}</span>
    </div>`;
}

function renderMetadataChips(entry, { i18nFormat, escapeHtml }) {
    if (!entry || typeof entry !== 'object') return '';
    const chips = [];
    for (const field of LOREBOOK_ENTRY_META_FIELDS) {
        if (entry[field] === undefined || entry[field] === null || entry[field] === '') continue;
        chips.push(`<code>${escapeHtml(`${field}=${normalizeFieldValue(entry[field])}`)}</code>`);
    }
    if (Array.isArray(entry?.keys) && entry.keys.length > 0) {
        chips.push(`<code>${escapeHtml(i18nFormat('keys: ${0}', entry.keys.join(', ')))}</code>`);
    }
    if (chips.length === 0) return '';
    return `<div class="cea_replace_diff_meta_row">${chips.join(' ')}</div>`;
}

function renderFullEntryBlock(entry, { escapeHtml, i18n, i18nFormat }) {
    if (!entry || typeof entry !== 'object') {
        return `<div class="cea_replace_diff_body_empty">${escapeHtml(i18n('(no entry data)'))}</div>`;
    }
    const parts = [];
    parts.push(renderMetadataChips(entry, { i18nFormat, escapeHtml }));
    for (const field of LOREBOOK_ENTRY_FIELDS) {
        const value = normalizeFieldValue(entry[field]);
        if (!value) continue;
        parts.push(`<div class="cea_replace_diff_field">
            <div class="cea_replace_diff_field_label">${escapeHtml(field)}</div>
            <pre class="cea_replace_diff_field_pre">${escapeHtml(value)}</pre>
        </div>`);
    }
    return parts.join('');
}

/**
 * Render a full-screen diff overview HTML string for the given model.
 *
 * Consumes:
 *   - the diff model from buildReplaceDiffModel
 *   - i18n / i18nFormat / escapeHtml helpers
 *   - renderLineDiffHtml(before, after, fileLabel) from diff-ui.js — reused
 *     for both card-field diffs and per-entry field diffs so the user gets
 *     the same interactive line-by-line comparison affordance they see on
 *     per-edit proposal cards later in the flow.
 *
 * @returns {string} HTML for the popup body.
 */
export function renderReplaceDiffOverview(model, deps = {}) {
    const escapeHtml = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : escapeHtmlInline;
    const i18n = typeof deps.i18n === 'function' ? deps.i18n : (s) => String(s ?? '');
    const i18nFormat = typeof deps.i18nFormat === 'function' ? deps.i18nFormat : ((s, ...args) => String(s).replace(/\$\{(\d+)\}/g, (_, i) => String(args[i] ?? '')));
    const renderLineDiffHtml = typeof deps.renderLineDiffHtml === 'function' ? deps.renderLineDiffHtml : null;

    if (!model || !model.hasChanges) {
        return `<div class="cea_replace_diff_overview">
            <div class="cea_replace_diff_empty">${escapeHtml(i18n('No structural changes detected between the previous version and the new one.'))}</div>
        </div>`;
    }

    const card = model.card;
    const book = model.book;

    // ── Card section ──
    const cardHeader = card.previousName || card.nextName
        ? escapeHtml(i18nFormat('Character card: ${0} → ${1}', card.previousName || '(unnamed)', card.nextName || '(unnamed)'))
        : escapeHtml(i18n('Character card'));

    let cardSectionHtml;
    if (card.fields.length === 0) {
        cardSectionHtml = `<div class="cea_replace_diff_body_empty">${escapeHtml(i18n('No character-card fields changed.'))}</div>`;
    } else {
        cardSectionHtml = card.fields.map(({ key, previous, next }) => {
            const diffHtml = renderLineDiffHtml
                ? renderLineDiffHtml(previous, next, i18nFormat('card.${0}', key))
                : `<div class="cea_replace_diff_prev_next">
                    <div><div class="cea_replace_diff_field_label">${escapeHtml(i18n('previous'))}</div><pre class="cea_replace_diff_field_pre">${escapeHtml(previous)}</pre></div>
                    <div><div class="cea_replace_diff_field_label">${escapeHtml(i18n('current'))}</div><pre class="cea_replace_diff_field_pre">${escapeHtml(next)}</pre></div>
                </div>`;
            return `<div class="cea_replace_diff_card_field">
                <div class="cea_replace_diff_card_field_label">${escapeHtml(key)}</div>
                ${diffHtml}
            </div>`;
        }).join('');
    }

    // ── Book section ──
    const bookHeaderText = book.renamed
        ? i18nFormat('World book: ${0} → ${1}', book.previousName || '(none)', book.nextName || '(none)')
        : (book.nextName || book.previousName
            ? i18nFormat('World book: ${0}', book.nextName || book.previousName)
            : i18n('World book'));
    const bookHeader = escapeHtml(bookHeaderText);

    const bookSummaryHtml = `<div class="cea_replace_diff_book_summary">
        <span class="cea_replace_diff_stat cea_replace_diff_stat_add">+${book.added.length} ${escapeHtml(i18n('added'))}</span>
        <span class="cea_replace_diff_stat cea_replace_diff_stat_del">−${book.removed.length} ${escapeHtml(i18n('removed'))}</span>
        <span class="cea_replace_diff_stat cea_replace_diff_stat_mod">~${book.changed.length} ${escapeHtml(i18n('changed'))}</span>
        <span class="cea_replace_diff_stat cea_replace_diff_stat_eq">=${book.unchangedCount} ${escapeHtml(i18n('unchanged'))}</span>
    </div>`;

    const removedHtml = book.removed.length === 0 ? '' : `<details class="cea_replace_diff_group cea_replace_diff_group_del" open>
        <summary>${escapeHtml(i18nFormat('Removed entries (${0})', String(book.removed.length)))}</summary>
        <div class="cea_replace_diff_group_body">
            ${book.removed.map(({ uid, entry }) => `<div class="cea_replace_diff_entry cea_replace_diff_entry_del">
                ${renderEntryHeading({ uid, entry, label: i18n('Only in previous'), escapeHtml, i18nFormat })}
                <div class="cea_replace_diff_entry_body">${renderFullEntryBlock(entry, { escapeHtml, i18n, i18nFormat })}</div>
            </div>`).join('')}
        </div>
    </details>`;

    const addedHtml = book.added.length === 0 ? '' : `<details class="cea_replace_diff_group cea_replace_diff_group_add" open>
        <summary>${escapeHtml(i18nFormat('Added entries (${0})', String(book.added.length)))}</summary>
        <div class="cea_replace_diff_group_body">
            ${book.added.map(({ uid, entry }) => `<div class="cea_replace_diff_entry cea_replace_diff_entry_add">
                ${renderEntryHeading({ uid, entry, label: i18n('Only in current'), escapeHtml, i18nFormat })}
                <div class="cea_replace_diff_entry_body">${renderFullEntryBlock(entry, { escapeHtml, i18n, i18nFormat })}</div>
            </div>`).join('')}
        </div>
    </details>`;

    const changedHtml = book.changed.length === 0 ? '' : `<details class="cea_replace_diff_group cea_replace_diff_group_mod" open>
        <summary>${escapeHtml(i18nFormat('Changed entries (${0})', String(book.changed.length)))}</summary>
        <div class="cea_replace_diff_group_body">
            ${book.changed.map(({ uid, previous, next, changedFields }) => {
        const heading = renderEntryHeading({ uid, entry: next, label: i18n('Changed'), escapeHtml, i18nFormat });
        const changedList = escapeHtml(i18nFormat('Fields changed: ${0}', changedFields.join(', ')));
        const fieldDiffs = changedFields.map(field => {
            const before = normalizeFieldValue(previous?.[field]);
            const after = normalizeFieldValue(next?.[field]);
            const diffHtml = renderLineDiffHtml
                ? renderLineDiffHtml(before, after, i18nFormat('entry.${0}.${1}', uid, field))
                : `<div class="cea_replace_diff_prev_next">
                            <div><div class="cea_replace_diff_field_label">${escapeHtml(i18n('previous'))}</div><pre class="cea_replace_diff_field_pre">${escapeHtml(before)}</pre></div>
                            <div><div class="cea_replace_diff_field_label">${escapeHtml(i18n('current'))}</div><pre class="cea_replace_diff_field_pre">${escapeHtml(after)}</pre></div>
                        </div>`;
            return `<div class="cea_replace_diff_card_field">
                        <div class="cea_replace_diff_card_field_label">${escapeHtml(field)}</div>
                        ${diffHtml}
                    </div>`;
        }).join('');
        return `<div class="cea_replace_diff_entry cea_replace_diff_entry_mod">
                    ${heading}
                    <div class="cea_replace_diff_entry_summary">${changedList}</div>
                    <div class="cea_replace_diff_entry_body">${fieldDiffs}</div>
                </div>`;
    }).join('')}
        </div>
    </details>`;

    let bookSectionHtml;
    if (book.added.length === 0 && book.removed.length === 0 && book.changed.length === 0) {
        bookSectionHtml = `<div class="cea_replace_diff_body_empty">${escapeHtml(i18n('No world-book entries added, removed, or changed.'))}</div>`;
    } else {
        bookSectionHtml = `${bookSummaryHtml}${removedHtml}${addedHtml}${changedHtml}`;
    }

    return `<div class="cea_replace_diff_overview">
        <section class="cea_replace_diff_section">
            <h3 class="cea_replace_diff_section_header">${cardHeader}</h3>
            <div class="cea_replace_diff_section_body">${cardSectionHtml}</div>
        </section>
        <section class="cea_replace_diff_section">
            <h3 class="cea_replace_diff_section_header">${bookHeader}</h3>
            <div class="cea_replace_diff_section_body">${bookSectionHtml}</div>
        </section>
    </div>`;
}
