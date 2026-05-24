// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// World-book preview pane renderer for the CEA character editor popup.
// Pure function — no DOM, no I/O — so it tests cleanly under Jest without
// the heavy `main.js` import graph.
//
// Reads a `worldInfo = { name, entries }` snapshot (the shape returned by
// `context.loadWorldInfo(bookName)`) and a `pendingApproval` batch from the
// editor's closure state. Marks existing entries that the pending batch
// targets with `pending-change`, and renders any brand-new draft entries
// (operations whose payload uid is not yet in the snapshot) as their own
// draft rows at the top.
//
// Layout is deliberately inline-styled rather than class-driven: prior
// iterations of this file lost flex-row alignment to an unidentified CSS
// specificity / cascade issue inside the popup that forced every span to
// stack vertically. Inline `style="display:flex"` on each row container
// sidesteps the cascade — the cards now reliably render head + meta on
// a single line regardless of what other stylesheets get injected later.
// Theme-aware tokens (SmartThemeBorderColor / SmartThemeQuoteColor /
// SmartThemeBodyColor) come from CSS variables so the inline values still
// adapt to the active theme.

function escapeHtmlLocal(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function truncateForPreview(value, max = 320) {
    const str = String(value ?? '');
    if (str.length <= max) return str;
    return `${str.slice(0, max)}…`;
}

function formatTemplate(template, ...values) {
    return String(template ?? '').replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

// Compact position labels match SillyTavern's own world-info entry-status
// tooltip (public/index.html:7419): ↑Char / ↓Char / ↑EM / ↓EM / ↑AN / ↓AN
// / @D + role badge / Out. Falls back to the numeric label for unknown
// positions so a future ST schema change degrades gracefully.
const POSITION_GLYPHS = Object.freeze({
    0: '↑Char',
    1: '↓Char',
    2: '↑AN',
    3: '↓AN',
    4: '@D',
    5: '↑EM',
    6: '↓EM',
    7: 'Out',
});

function getPositionGlyph(position) {
    const n = Number(position);
    if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(POSITION_GLYPHS, n)) {
        return POSITION_GLYPHS[n];
    }
    return String(position ?? '');
}

function getDepthRoleGlyph(role) {
    const n = Number(role);
    if (n === 0) return '⚙️';
    if (n === 1) return '👤';
    if (n === 2) return '🤖';
    return '';
}

// Status glyph mirrors the SillyTavern entry-status selector
// (public/index.html:7411-7413): 🔵 Constant, 🔗 Vectorized, 🟢 Selective.
function getStateGlyph(entry) {
    if (entry?.constant) return { glyph: '🔵', label: 'Constant' };
    if (entry?.vectorized) return { glyph: '🔗', label: 'Vectorized' };
    return { glyph: '🟢', label: 'Selective' };
}

function extractKeys(source) {
    if (Array.isArray(source?.key)) return source.key;
    if (Array.isArray(source?.keys)) return source.keys;
    return [];
}

const PILL_STYLE = 'flex:0 0 auto;display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--SmartThemeBorderColor, rgba(130,130,130,.3));border-radius:999px;font-size:0.72rem;line-height:1.5;opacity:0.85;background:transparent;';
const PILL_STYLE_ACTIVE = 'flex:0 0 auto;display:inline-flex;align-items:center;padding:1px 7px;border:1px solid color-mix(in srgb, var(--SmartThemeQuoteColor, #5b8def) 72%, var(--SmartThemeBorderColor, rgba(130,130,130,.3)));border-radius:999px;font-size:0.72rem;line-height:1.5;color:var(--SmartThemeQuoteColor, #5b8def);background:transparent;';
const CHIP_STYLE = 'flex:0 0 auto;display:inline-flex;align-items:center;padding:1px 8px;border:1px solid var(--SmartThemeBorderColor, rgba(130,130,130,.3));border-radius:999px;font-size:0.74rem;line-height:1.5;background:color-mix(in srgb, var(--SmartThemeQuoteColor, #5b8def) 10%, transparent);overflow:hidden;text-overflow:ellipsis;max-width:14rem;';

function renderKeyChips(keys) {
    const list = (Array.isArray(keys) ? keys : [])
        .map((k) => String(k ?? '').trim())
        .filter(Boolean);
    if (list.length === 0) return '';
    const visible = list.slice(0, 8);
    const overflow = list.length - visible.length;
    const chips = visible
        .map((k) => `<span style="${CHIP_STYLE}" title="${escapeHtmlLocal(k)}">${escapeHtmlLocal(k)}</span>`)
        .join('');
    const overflowChip = overflow > 0
        ? `<span style="${PILL_STYLE};opacity:0.7;">+${overflow}</span>`
        : '';
    return `<div style="display:flex;flex-wrap:wrap;gap:3px;padding:1px 0;">${chips}${overflowChip}</div>`;
}

function renderMetaPills(t, tFormat, entry, isPending, missingRefOp) {
    const pills = [];
    const pos = Number(entry?.position);
    if (Number.isFinite(pos)) {
        let label = getPositionGlyph(pos);
        if (pos === 4) {
            const role = entry?.role ?? entry?.depth_role;
            const depth = entry?.depth;
            const roleGlyph = getDepthRoleGlyph(role);
            if (depth != null) label = `${label}${roleGlyph ? ` ${roleGlyph}` : ''} ${Number(depth)}`;
            else if (roleGlyph) label = `${label} ${roleGlyph}`;
        }
        pills.push(`<span style="${PILL_STYLE}" title="${escapeHtmlLocal(t('Position'))}">${escapeHtmlLocal(label)}</span>`);
    }
    if (entry?.order != null && Number.isFinite(Number(entry.order)) && Number(entry.order) !== 100) {
        pills.push(`<span style="${PILL_STYLE}" title="${escapeHtmlLocal(t('Order'))}">${escapeHtmlLocal(`${t('Order')} ${Number(entry.order)}`)}</span>`);
    }
    const probabilityRaw = entry?.probability;
    if (probabilityRaw != null && Number.isFinite(Number(probabilityRaw))) {
        const probability = Number(probabilityRaw);
        if (probability !== 100) {
            pills.push(`<span style="${PILL_STYLE}" title="${escapeHtmlLocal(t('Probability'))}">${escapeHtmlLocal(`${probability}%`)}</span>`);
        }
    }
    if (entry?.disable) {
        pills.push(`<span style="${PILL_STYLE};color:var(--crimson70, #d9534f);">${escapeHtmlLocal(t('Disabled'))}</span>`);
    }
    if (isPending) {
        pills.push(`<span style="${PILL_STYLE_ACTIVE}">${escapeHtmlLocal(t('Draft (not applied)'))}</span>`);
    }
    if (missingRefOp) {
        pills.push(`<span style="${PILL_STYLE_ACTIVE};color:var(--crimson70, #d9534f);border-color:var(--crimson70, #d9534f);">${escapeHtmlLocal(tFormat('${0} references missing entry', missingRefOp))}</span>`);
    }
    return pills.join('');
}

function renderEntryCard(t, tFormat, entry, { isPending = false, missingRefOp = '', forceTitle = '' } = {}) {
    const uid = entry?.uid ?? entry?.id ?? '';
    const commentRaw = String(entry?.comment ?? entry?.title ?? '').trim();
    const titleText = forceTitle || commentRaw || (uid !== '' ? `#${uid}` : t('(untitled entry)'));
    const state = getStateGlyph(entry);
    const content = !missingRefOp ? truncateForPreview(entry?.content || '', 320) : '';
    const keys = extractKeys(entry);
    const metaPills = renderMetaPills(t, tFormat, entry, isPending, missingRefOp);
    const keysHtml = renderKeyChips(keys);

    const ringStyle = (isPending || missingRefOp)
        ? `border-color:color-mix(in srgb, var(--SmartThemeQuoteColor, #5b8def) 72%, var(--SmartThemeBorderColor, rgba(130,130,130,.3)));box-shadow:0 0 0 1px color-mix(in srgb, var(--SmartThemeQuoteColor, #5b8def) 24%, transparent);`
        : '';
    const disabledStyle = entry?.disable ? 'opacity:0.55;' : '';
    const cardStyle = `display:flex;flex-direction:column;gap:4px;padding:6px 10px;border:1px solid var(--SmartThemeBorderColor, rgba(130,130,130,.3));border-radius:10px;background:transparent;transition:border-color 180ms, box-shadow 180ms;${ringStyle}${disabledStyle}`;

    const headerStyle = 'display:flex;align-items:center;flex-wrap:wrap;gap:5px;min-width:0;';
    const titleSpanStyle = 'flex:1 1 12rem;min-width:0;font-weight:600;font-size:0.92rem;line-height:1.35;overflow-wrap:anywhere;';
    const uidStyle = 'flex:0 0 auto;opacity:0.45;font-family:var(--monoFontFamily, ui-monospace, monospace);font-size:0.7rem;';
    const stateStyle = 'flex:0 0 auto;font-size:0.95em;line-height:1;';

    const uidBadge = uid !== ''
        ? `<small style="${uidStyle}" title="${escapeHtmlLocal(tFormat('Entry UID: ${0}', uid))}">#${escapeHtmlLocal(String(uid))}</small>`
        : '';

    const contentHtml = (!missingRefOp && content)
        ? `<details style="font-size:0.83rem;line-height:1.45;opacity:0.85;">
              <summary style="cursor:pointer;opacity:0.78;list-style:none;padding:1px 0;">▸&nbsp;${escapeHtmlLocal(t('Content'))}</summary>
              <div style="white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;padding:4px 0 0;border-top:1px dashed color-mix(in srgb, var(--SmartThemeBodyColor, #888) 18%, transparent);margin-top:2px;">${escapeHtmlLocal(content)}</div>
          </details>`
        : '';

    const wrapperClasses = [
        'wi-card-entry',
        'cea_editor_preview_card',
        entry?.disable ? 'disabledWIEntry' : '',
        isPending ? 'pending-change' : '',
        missingRefOp ? 'pending-change' : '',
    ].filter(Boolean).join(' ');

    return `<article class="${wrapperClasses}" style="${cardStyle}">
        <header style="${headerStyle}">
            <span style="${stateStyle}" title="${escapeHtmlLocal(state.label)}">${state.glyph}</span>
            <strong style="${titleSpanStyle}">${escapeHtmlLocal(titleText)}</strong>
            ${uidBadge}
            ${metaPills}
        </header>
        ${keysHtml}
        ${contentHtml}
    </article>`;
}

/**
 * Render the world-book preview pane HTML.
 * @param {{name?: string, book_name?: string, entries?: object|Array}|null} worldInfo
 * @param {{messageId?: string, operations?: Array<{op: string, payload?: object, data?: object, args?: object}>}|null} pendingApproval
 * @param {Function} [tFn] Optional i18n function (string → string); defaults to identity.
 * @returns {string} HTML markup
 */
export function renderCeaEditorPreviewPane(worldInfo, pendingApproval, tFn) {
    const t = typeof tFn === 'function' ? tFn : (s) => String(s ?? '');
    const tFormat = (template, ...values) => formatTemplate(t(template), ...values);

    if (!worldInfo) {
        return `<div style="padding:14px 16px;border:1px dashed color-mix(in srgb, var(--SmartThemeBodyColor, #888) 18%, transparent);border-radius:10px;opacity:0.75;text-align:center;">${escapeHtmlLocal(t('No world book bound'))}</div>`;
    }

    const name = worldInfo.name || worldInfo.book_name || '';
    const entries = worldInfo.entries || {};
    const entryArray = Array.isArray(entries) ? entries.slice() : Object.values(entries);
    // Build a uid-keyed view of existing entries so existsInSnapshot checks
    // work whether the source was an Array (modern world-info shape) or
    // an object map (legacy). Without this, Array-shaped entries always
    // fell through the existsInSnapshot branch and rendered as drafts
    // even when the AI was targeting an existing uid (旧-7).
    const entriesObj = Array.isArray(entries)
        ? Object.fromEntries(entries.map((e) => [String(e?.uid ?? e?.id ?? ''), e]))
        : entries;

    // Identify pending entries by uid; treat anything without a matching uid
    // as a brand-new draft (rendered as a separate row at the top).
    const pendingByUid = new Map();
    const pendingNewEntries = [];
    const ops = Array.isArray(pendingApproval?.operations) ? pendingApproval.operations : [];
    for (const op of ops) {
        const payload = op?.payload || op?.data || op?.args || {};
        const uid = payload?.uid;
        const key = uid == null ? null : String(uid);
        const opName = String(op?.op || '');
        const isCreate = opName === 'upsert_entry' || opName === 'create_entry' || opName === 'add_entry';
        const existsInSnapshot = key != null && Object.prototype.hasOwnProperty.call(entriesObj, key);
        if (existsInSnapshot) {
            pendingByUid.set(key, op);
        } else if (isCreate || key != null) {
            // upsert/create on unknown uid → draft row at the top.
            // delete/update on missing uid renders as a separate
            // "referencing non-existent entry" row so the user can tell it
            // apart from a legitimate new draft.
            pendingNewEntries.push({ op: opName, payload, isCreate });
        }
    }

    const newDraftHtml = pendingNewEntries.map(({ op, payload, isCreate }) => {
        const uidLabel = payload?.uid != null ? `#${payload.uid}` : t('(new)');
        if (!isCreate) {
            return renderEntryCard(t, tFormat, payload, { isPending: true, missingRefOp: op || 'op', forceTitle: uidLabel });
        }
        return renderEntryCard(t, tFormat, payload, { isPending: true, forceTitle: uidLabel });
    }).join('');

    const entryCards = entryArray.map((entry) => {
        const uidStr = String(entry?.uid ?? entry?.id ?? '');
        const isPending = pendingByUid.has(uidStr);
        return {
            isPending,
            html: renderEntryCard(t, tFormat, entry, { isPending }),
        };
    });

    const VISIBLE_CLEAN_LIMIT = 50;
    const pendingChangedHtml = entryCards.filter((r) => r.isPending).map((r) => r.html).join('');
    const cleanCards = entryCards.filter((r) => !r.isPending);
    const visibleCleanHtml = cleanCards.slice(0, VISIBLE_CLEAN_LIMIT).map((r) => r.html).join('');
    const hiddenClean = cleanCards.slice(VISIBLE_CLEAN_LIMIT);
    const hiddenCleanHtml = hiddenClean.length > 0
        ? `<details style="border:1px dashed color-mix(in srgb, var(--SmartThemeBodyColor, #888) 18%, transparent);border-radius:10px;padding:6px 10px;">
              <summary style="cursor:pointer;opacity:0.78;padding:2px 0;">${escapeHtmlLocal(tFormat('Show ${0} more entries', String(hiddenClean.length)))}</summary>
              <div style="display:flex;flex-direction:column;gap:5px;margin-top:6px;">${hiddenClean.map((r) => r.html).join('')}</div>
          </details>`
        : '';

    const totalEntries = entryArray.length;
    const pendingCount = entryCards.filter((r) => r.isPending).length;
    const draftCount = pendingNewEntries.length;
    const summaryPills = [
        `<span style="${PILL_STYLE}">${escapeHtmlLocal(tFormat('${0} entries', String(totalEntries)))}</span>`,
        pendingCount > 0
            ? `<span style="${PILL_STYLE_ACTIVE}">${escapeHtmlLocal(tFormat('${0} pending', String(pendingCount)))}</span>`
            : '',
        draftCount > 0
            ? `<span style="${PILL_STYLE_ACTIVE}">${escapeHtmlLocal(tFormat('${0} draft', String(draftCount)))}</span>`
            : '',
    ].filter(Boolean).join('');

    const bodyRows = `${newDraftHtml}${pendingChangedHtml}${visibleCleanHtml}${hiddenCleanHtml}`
        || `<div style="padding:14px 16px;border:1px dashed color-mix(in srgb, var(--SmartThemeBodyColor, #888) 18%, transparent);border-radius:10px;opacity:0.75;text-align:center;">${escapeHtmlLocal(t('No entries yet.'))}</div>`;

    return `
        <section class="cea_editor_preview_section" style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--SmartThemeBorderColor, rgba(130,130,130,.3));border-radius:12px;">
            <header style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding-bottom:8px;border-bottom:1px dashed color-mix(in srgb, var(--SmartThemeBodyColor, #888) 16%, transparent);min-width:0;">
                <strong style="flex:1 1 12rem;min-width:0;font-size:0.96rem;overflow-wrap:anywhere;">${escapeHtmlLocal(tFormat('World book: ${0}', name))}</strong>
                ${summaryPills}
            </header>
            <div style="display:flex;flex-direction:column;gap:5px;">${bodyRows}</div>
        </section>
    `;
}

export { renderCeaEditorPreviewPane as _testOnly_renderCeaEditorPreviewPane };
