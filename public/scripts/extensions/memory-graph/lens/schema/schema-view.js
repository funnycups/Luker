// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory structure view: a visual editor for memory-graph's node-type schema.
// Left: memory types. Right: the selected type's record items, behavior switches,
// and advanced schema fields (including primaryKeyColumns and compression tuning).
// Saving shows a change summary first and offers undo afterwards.

import { h, clear, put, prefersReducedMotion, scrollChildIntoView } from '../../../../lens-shared/util.js';
import { createBehaviorSummary } from '../../../../lens-shared/behavior-summary.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';
import { typeVisual } from '../model.js';
import { button, iconButton, emptyState, segmented, checkRow, sectionTitle } from '../ui/components.js';
import {
    toDrafts, fromDraft, newColumn, newTypeDraft, labelsFromDrafts, validateDrafts,
    describeChanges, draftsEqual, cloneDrafts,
} from './schema-model.js';
import { buildMgSchemaTypeModel } from '../settings/behavior-summary-models.js';
import { TEMPLATES, buildTemplate, templateTypeNames } from './templates.js';
import { openFilterDialog } from '../filter/filter-panel.js';

const UNDO_MS = 12000;
const IDENTITY_CANDIDATES = ['title', 'name', 'aliases'];

function resolvePrimaryKeys(draft) {
    const raw = draft.raw || {};
    const keys = draft.columns.map(c => c.key);
    const keySet = new Set(keys);
    let identity = (Array.isArray(raw.primaryKeyColumns) ? raw.primaryKeyColumns : [])
        .map(v => String(v ?? '').trim())
        .filter(k => k && keySet.has(k));
    if (draft.latestOnly && !identity.length) {
        identity = IDENTITY_CANDIDATES.filter(k => keySet.has(k));
        if (!identity.length && keys.length) identity = [keys[0]];
    }
    return identity;
}

export function createSchemaView(app, source, { onDirtyChange = null } = {}) {
    const access = source.schema || null;
    let lastNotifiedDirty = false;
    const bar = h('header', { class: 'ml-schema-bar' });
    const list = h('aside', { class: 'ml-schema-list', 'aria-label': i18n('Memory types') });
    const editor = h('section', { class: 'ml-schema-editor' });
    const body = h('div', { class: 'ml-schema-body' }, list, editor);
    const aiAccess = source.ai || null;
    const toast = h('div', { class: 'ml-schema-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    const root = h('div', { class: 'ml-schema' }, bar, body, toast);

    let status = 'idle'; // idle | loading | ready | error | unsupported
    let errorText = '';
    let info = null;
    let base = [];
    let drafts = [];
    let selectedUid = '';
    let pane = 'list';
    let scopeCharacter = false;
    let saving = false;
    let undoSnapshot = null;
    let undoTimer = null;
    let needsReload = true;
    let modal = null;
    let modalCancel = null;
    let errors = [];
    const openItems = new Set();

    const selected = () => drafts.find(d => d.uid === selectedUid) || null;
    const nodeCount = (id) => app.model()?.typeCounts.get(id) || 0;
    const scopeChanged = () => Boolean(info?.hasCharacter) && scopeCharacter !== (info.scope === 'character');
    const isDirty = () => status === 'ready' && (!draftsEqual(base, drafts) || scopeChanged());

    const typeSummary = createBehaviorSummary({
        id: 'mg-schema-type',
        ariaLabel: i18n('Memory type behavior summary'),
        build: () => {
            const draft = selected();
            return draft
                ? buildMgSchemaTypeModel({ draft, globalSettings: info?.globalSettings || {} })
                : { tone: 'dormant', rows: [] };
        },
    });

    function syncGlobalSettingsFromSource() {
        if (!info || typeof source.settings?.read !== 'function') return;
        try {
            const latest = source.settings.read();
            info.globalSettings = {
                autoCompressionEnabled: Boolean(latest?.values?.autoCompressionEnabled),
                persistentInjectionMaxSeqDistance: Math.max(0, Math.floor(Number(latest?.advanced?.values?.persistentInjectionMaxSeqDistance) || 0)),
                recallMethod: String(latest?.values?.recallMethod || 'llm'),
                ragDefaultPerTypeK: Math.max(0, Math.floor(Number(latest?.values?.ragDefaultPerTypeK) || 0)),
            };
        } catch {
            // Keep existing globalSettings if settings read is unavailable.
        }
    }

    const unsubscribeSettings = source.settings?.subscribe?.(() => {
        if (status !== 'ready') return;
        syncGlobalSettingsFromSource();
        typeSummary.update();
    }) || (() => {});

    const workbenchOpen = (extra = {}) => {
        const wb = globalThis.Luker?.getContext?.()?.workbench;
        if (typeof wb?.open !== 'function') return;
        wb.open({
            page: 'ai',
            ws: 'memory',
            scope: scopeCharacter ? 'character' : 'global',
            ...extra,
        });
    };

    // ----- Data -----------------------------------------------------------
    async function load() {
        needsReload = false;
        if (!access) {
            status = 'unsupported';
            paint();
            return;
        }
        const keepId = selected()?.id || '';
        status = 'loading';
        paint();
        try {
            info = await access.read();
            base = toDrafts(info.types, info.labels, info.defaults);
            drafts = cloneDrafts(base);
            scopeCharacter = info.scope === 'character';
            selectedUid = (drafts.find(d => d.id === keepId) || drafts[0])?.uid || '';
            errors = [];
            status = 'ready';
        } catch (err) {
            status = 'error';
            errorText = String(err?.message || err);
        }
        paint();
    }

    // ----- Painting -------------------------------------------------------
    function paint() {
        root.classList.toggle('is-pane-editor', pane === 'editor');
        paintBar();
        clear(list);
        clear(editor);
        if (status === 'loading' || status === 'idle') {
            typeSummary.bindScope(null);
            put(editor, h('div', { class: 'ml-loading' }, h('div', { class: 'ml-spinner', 'aria-hidden': 'true' }), h('span', { text: i18n('Reading memory…') })));
            return;
        }
        if (status === 'error') {
            typeSummary.bindScope(null);
            put(editor, emptyState('alert', i18n('Failed to read'), errorText, button(i18n('Refresh'), () => load(), { iconName: 'refresh' })));
            return;
        }
        paintList();
        paintEditor();
    }

    function paintBar() {
        clear(bar);
        const dirty = isDirty();
        if (dirty !== lastNotifiedDirty) {
            lastNotifiedDirty = dirty;
            onDirtyChange?.(dirty);
        }
        const statusLine = saving
            ? h('span', { class: 'ml-schema-state', text: i18n('Saving…') })
            : dirty ? h('span', { class: 'ml-schema-state is-dirty' }, h('span', { class: 'ml-schema-dot', 'aria-hidden': 'true' }), h('span', { text: i18n('Unsaved changes') })) : null;
        const charName = info?.characterName || i18n('No character selected');
        const scope = status === 'ready' && info?.hasCharacter
            ? h('div', { class: 'ml-schema-scope' },
                h('span', { class: 'ml-schema-scope-label', text: i18n('Applies to') }),
                segmented([
                    { value: 'global', label: i18n('All characters') },
                    { value: 'character', label: i18nFormat('Only "${0}"', charName), title: i18nFormat('Only "${0}"', charName) },
                ], scopeCharacter ? 'character' : 'global', (value) => {
                    scopeCharacter = value === 'character';
                    paintBar();
                }, { ariaLabel: i18n('Applies to'), className: 'ml-seg-sm ml-schema-scope-seg' }),
                info.scope === 'character' && !scopeCharacter
                    ? h('span', { class: 'ml-schema-scope-note', text: i18n('After saving, this character switches to the shared structure') })
                    : null,
                info.scope === 'character' && !dirty
                    ? h('button', { type: 'button', class: 'ml-linkbtn ml-schema-scope-note', onClick: () => useGlobal() }, h('span', { text: i18n('Switch back to the shared structure') }))
                    : null)
            : h('div', { class: 'ml-schema-scope' }, h('span', { class: 'ml-schema-scope-label', text: i18n('Changes apply to all characters') }));
        const hasWorkbenchAi = typeof globalThis.Luker?.getContext?.()?.workbench?.open === 'function';
        put(bar,
            scope,
            h('div', { class: 'ml-schema-actions' },
                statusLine,
                source.filter ? filterButton() : null,
                hasWorkbenchAi && status === 'ready'
                    ? button(i18n('AI assistant'), () => workbenchOpen(), { iconName: 'sparkle', className: 'ml-schema-aibtn' })
                    : null,
                dirty && !saving ? button(i18n('Discard changes'), () => discard(), { className: 'ml-btn-ghost' }) : null,
                button(i18n('Save'), () => save(), { iconName: 'check', className: 'ml-btn-primary', disabled: !dirty || saving })),
        );
        if (errors.length) {
            put(bar, h('div', { class: 'ml-schema-errors', role: 'alert' },
                icon('alert', { size: 14 }),
                h('span', { text: errors[0].message }),
                errors.length > 1 ? h('span', { class: 'ml-schema-errors-more', text: i18nFormat('${0} in total', errors.length) }) : null));
        }
    }

    function filterButton() {
        let on = false;
        try { on = Boolean(source.filter.read().enabled); } catch { on = false; }
        return button(on ? i18n('Tag filter · On') : i18n('Tag filter'), () => openFilterDialog({
            access: source.filter,
            aiAccess,
            confirmModal: (opts) => { confirmModal(opts); },
            showToast: (text, opts) => { showToast(text, opts); paintBar(); },
        }), { iconName: 'filter', className: `ml-schema-filterbtn ${on ? 'is-on' : ''}`.trim(), title: i18n('Only hand what matters to memory extraction and recall') });
    }

    function typeMeta(draft) {
        const count = nodeCount(draft.id);
        return `${i18nFormat('${0} items', draft.columns.length)} · ${count ? i18nFormat('${0} in the current chat', count) : i18n('None in the current chat yet')}`;
    }

    function typeChanged(draft) {
        const prev = base.find(b => b.id === draft.id);
        return !prev || JSON.stringify(fromDraft(prev)) !== JSON.stringify(fromDraft(draft))
            || JSON.stringify(labelsFromDrafts([prev])) !== JSON.stringify(labelsFromDrafts([draft]));
    }

    function paintList() {
        clear(list);
        put(list,
            sectionTitle(i18n('Memory types')),
            h('div', { class: 'ml-schema-types', role: 'listbox', 'aria-label': i18n('Memory types') },
                drafts.map(draft => {
                    const hasError = errors.some(e => e.uid === draft.uid);
                    return h('button', {
                        type: 'button',
                        role: 'option',
                        class: `ml-schema-type ${hasError ? 'has-error' : ''}`.trim(),
                        'aria-selected': String(draft.uid === selectedUid),
                        dataset: { uid: draft.uid, tone: typeVisual(draft.id).tone },
                        onClick: () => {
                            selectedUid = draft.uid;
                            pane = 'editor';
                            paint();
                        },
                    },
                    h('span', { class: 'ml-dot', dataset: { tone: typeVisual(draft.id).tone, shape: typeVisual(draft.id).shape }, style: { '--ml-dot-size': '12px' } }),
                    h('span', { class: 'ml-schema-type-main' },
                        h('span', { class: 'ml-schema-type-name', text: draft.name.trim() || i18n('New memory type') }),
                        h('span', { class: 'ml-schema-type-meta', text: typeMeta(draft) })),
                    typeChanged(draft) ? h('span', { class: 'ml-schema-dot', title: i18n('Unsaved changes'), 'aria-label': i18n('Unsaved changes') }) : null,
                    icon('chevronRight', { size: 14, className: 'ml-schema-type-chev' }));
                })),
            h('div', { class: 'ml-schema-list-actions' },
                button(i18n('New type'), () => addType(), { iconName: 'plus' }),
                button(i18n('Apply template'), () => pickTemplate(), { iconName: 'layers', className: 'ml-btn-ghost' }),
                access.importFile || access.exportFile
                    ? h('div', { class: 'ml-schema-io' },
                        access.importFile ? button(i18n('Import'), () => importSchema(), { iconName: 'upload', className: 'ml-btn-ghost' }) : null,
                        access.exportFile ? button(i18n('Export'), () => exportSchema(), { iconName: 'download', className: 'ml-btn-ghost' }) : null)
                    : null,
                button(i18n('Restore defaults'), () => resetDefaults(), { iconName: 'undo', className: 'ml-btn-ghost' })),
        );
    }

    function paintEditor() {
        const scroll = editor.scrollTop;
        clear(editor);
        const draft = selected();
        if (!draft) return;
        const count = nodeCount(draft.id);
        const nameInput = h('input', {
            type: 'text',
            class: 'ml-schema-input ml-schema-typename',
            value: draft.name,
            placeholder: i18n('For example: Item'),
            'aria-label': i18n('Name'),
            'aria-invalid': errors.some(e => e.uid === draft.uid && !e.column && e.field === 'name') ? 'true' : null,
            maxlength: 40,
            onInput: (event) => {
                draft.name = event.target.value;
                event.target.removeAttribute('aria-invalid');
                touched();
                const label = list.querySelector(`[data-uid="${draft.uid}"] .ml-schema-type-name`);
                if (label) label.textContent = draft.name.trim() || i18n('New memory type');
            },
        });
        const intro = promptBlock({
            note: i18n('The AI uses this to decide what belongs to this type'),
            compact: true,
            value: draft.intro,
            placeholder: draft.usesDefaultIntro ? i18n('Use the default description') : i18n('One sentence on what this type records (optional)'),
            label: i18n('What this memory type is'),
            className: 'ml-schema-intro',
            onInput: (value) => { draft.intro = value; touched(); },
        });
        const hasWorkbenchAi = typeof globalThis.Luker?.getContext?.()?.workbench?.open === 'function';
        const suggestBtn = hasWorkbenchAi
            ? button(i18n('Improve this type'), () => workbenchOpen({
                draft: i18nFormat('Improve the "${0}" memory type', draft.name.trim() || draft.id),
            }), { iconName: 'sparkle', className: 'ml-btn-sm ml-schema-suggest', title: i18n('Let the AI add record items, write the prompts and choose how it is recorded') })
            : null;
        const items = h('ol', { class: 'ml-schema-items' }, draft.columns.map(column => itemRow(draft, column)));
        const editorInner = h('div', { class: 'ml-schema-editor-inner' },
            h('button', { type: 'button', class: 'ml-schema-back', onClick: () => { pane = 'list'; paint(); } },
                icon('chevronLeft', { size: 16 }), h('span', { text: i18n('Memory types') })),
            h('div', { class: 'ml-schema-typehead', dataset: { tone: typeVisual(draft.id).tone } },
                h('span', { class: 'ml-dot', dataset: { tone: typeVisual(draft.id).tone, shape: typeVisual(draft.id).shape }, style: { '--ml-dot-size': '14px' } }),
                nameInput,
                h('span', { class: 'ml-schema-usage', text: count ? i18nFormat('${0} in the current chat', count) : i18n('None in the current chat yet') }),
                suggestBtn,
                draft.deletable ? iconButton('trash', i18n('Delete this type'), () => deleteType(draft), { className: 'ml-schema-danger' }) : null),
            typeSummary.el,
            intro,
            h('section', { class: 'ml-schema-section' },
                sectionTitle(`${i18n('Record items')} · ${draft.columns.length}`),
                items,
                button(i18n('Add an item'), () => addItem(draft), { iconName: 'plus', className: 'ml-btn-ghost ml-schema-additem' })),
            h('section', { class: 'ml-schema-section' },
                sectionTitle(i18n('How it is recorded')),
                h('div', { class: 'ml-schema-flags' },
                    flag(draft, 'alwaysInject', i18n('Always visible to the AI'), i18n('Sent with every reply, without waiting for recall. Best for a few important things like plot threads and rules.')),
                    flag(draft, 'latestOnly', i18n('Keep only the latest per name'), i18n('Only one entry stays for the same character or place, new content replaces the old.')),
                    flag(draft, 'compression', i18n('Merge into summaries automatically'), i18n('Once there are many entries, several are merged into one summary to save space.')))),
            advancedSection(draft),
        );
        put(editor, editorInner);
        typeSummary.bindScope(editorInner);
        typeSummary.update();
        editor.scrollTop = scroll;
        if (draft.isNew && !draft.name) requestAnimationFrame(() => nameInput.focus({ preventScroll: true }));
    }

    function advancedSection(draft) {
        const raw = draft.raw;
        const compression = (raw.compression ||= {});
        const text = (target, key, label, rows = 0, fieldKey = '') => h('label', { class: 'ml-aiset-field', dataset: fieldKey ? { fieldKey } : null }, h('span', { class: 'ml-aiset-label', text: label }),
            h(rows ? 'textarea' : 'input', { class: 'ml-schema-input', rows: rows || null, type: rows ? null : 'text', ...(rows ? { text: String(target[key] ?? '') } : { value: String(target[key] ?? '') }), onInput: (event) => { target[key] = event.target.value; touched(); } }));
        const listField = (key, label) => h('label', { class: 'ml-aiset-field' }, h('span', { class: 'ml-aiset-label', text: label }),
            h('input', { class: 'ml-schema-input', type: 'text', value: (raw[key] || []).join(', '), onInput: (event) => { raw[key] = event.target.value.split(',').map(s => s.trim()).filter(Boolean); touched(); } }));
        const number = (target, key, label, min, extra = {}) => h('label', { class: 'ml-aiset-field', dataset: { fieldKey: key } }, h('span', { class: 'ml-aiset-label', text: label }),
            h('input', { class: 'ml-schema-input', type: 'number', min, step: 1, value: String(target[key] ?? ''), ...extra, onInput: (event) => { target[key] = event.target.value === '' ? undefined : Number(event.target.value); touched(); } }));
        const check = (key, label, onAfter = null) => {
            const node = checkRow({
                checked: raw[key],
                label,
                onChange: (value) => {
                    raw[key] = value;
                    onAfter?.(value);
                    touched();
                },
            });
            if (node instanceof Element) node.dataset.fieldKey = key;
            return node;
        };
        const searchable = () => (Array.isArray(raw.embeddingColumns) ? raw.embeddingColumns : draft.columns.map(c => c.key));
        const primaryKeys = () => resolvePrimaryKeys(draft);
        return h('section', { class: 'ml-schema-section' },
            sectionTitle(i18n('Advanced Settings')),
            h('div', { class: 'ml-aiset' },
                h('div', { class: 'ml-aiset-fields' },
                    text(raw, 'tableName', i18n('Table Name'), 0, 'tableName'),
                    listField('keywords', i18n('Keywords (comma separated)')),
                    number(raw, 'extractEveryN', i18n('Extract Every N Floors'), 1, { disabled: Boolean(raw.forceUpdate) }),
                    number(raw, 'ragPerTypeK', i18n('RAG per-type quota override'), 0)),
                check('forceUpdate', i18n('Force Update (must appear each extraction batch)'), () => paintEditor()),
                check('editable', i18n('Editable (enable edit/delete tools and graph edit context)')),
                h('div', { class: 'ml-aiset-field', dataset: { fieldKey: 'primaryKeyColumns' } }, h('span', { class: 'ml-aiset-label', text: i18n('Primary Key Columns') }),
                    draft.columns.map(column => checkRow({
                        checked: primaryKeys().includes(column.key),
                        label: column.label || column.key,
                        onChange: (value) => {
                            const next = primaryKeys().filter(key => key !== column.key);
                            raw.primaryKeyColumns = value ? [...next, column.key] : next;
                            raw.primaryKeyColumns = resolvePrimaryKeys(draft);
                            paintEditor();
                            touched();
                        },
                    }))),
                h('div', { class: 'ml-aiset-field' }, h('span', { class: 'ml-aiset-label', text: i18n('Embedding Columns') }),
                    draft.columns.map(column => checkRow({
                        checked: searchable().includes(column.key),
                        label: column.label || column.key,
                        onChange: (value) => {
                            const next = searchable().filter(key => key !== column.key);
                            raw.embeddingColumns = value ? [...next, column.key] : next;
                            touched();
                        },
                    }))),
                text(raw, 'extractionInstructions', i18n('Extraction Instructions'), 4),
                h('div', { class: 'ml-aiset-fields' },
                    number(compression, 'threshold', i18n('Threshold'), 2),
                    number(compression, 'fanIn', i18n('Fan-In'), 2),
                    number(compression, 'maxDepth', i18n('Max Depth'), 1),
                    number(compression, 'keepRecentLeaves', i18n('Keep Recent Leaves'), 0)),
                text(compression, 'rule', i18n('Compression Rule (optional)'), 2, 'rule'),
                text(compression, 'summarizeInstruction', i18n('Summarize Instruction'), 4, 'summarizeInstruction')));
    }

    function flag(draft, key, title, hint) {
        const card = h('button', {
            type: 'button',
            role: 'switch',
            class: 'ml-schema-flag',
            dataset: { fieldKey: key },
            'aria-checked': String(Boolean(draft[key])),
            onClick: () => {
                draft[key] = !draft[key];
                card.setAttribute('aria-checked', String(draft[key]));
                if (key === 'latestOnly') {
                    draft.raw.primaryKeyColumns = resolvePrimaryKeys(draft);
                    paintEditor();
                }
                touched();
            },
        },
        h('span', { class: 'ml-schema-flag-text' },
            h('span', { class: 'ml-schema-flag-title', text: title }),
            h('span', { class: 'ml-schema-flag-hint', text: hint })),
        h('span', { class: 'lw-switch-track' }, h('span', { class: 'lw-switch-thumb' })));
        return card;
    }

    function itemRow(draft, column) {
        const invalid = errors.some(e => e.column === column.uid);
        const open = openItems.has(column.uid);
        const nameInput = h('input', {
            type: 'text',
            class: 'ml-schema-input ml-schema-itemname',
            value: column.label,
            placeholder: column.isNew ? i18n('For example: Identity') : i18n('Unnamed item, give it a name'),
            'aria-label': i18n('Name'),
            'aria-invalid': invalid ? 'true' : null,
            maxlength: 30,
            onInput: (event) => {
                column.label = event.target.value;
                event.target.removeAttribute('aria-invalid');
                touched();
            },
        });
        const preview = column.hint.trim() || (column.usesDefaultHint ? i18n('Use the default description') : i18n('Add a description'));
        const toggle = h('button', {
            type: 'button',
            class: `ml-schema-hintbtn ${column.hint.trim() ? '' : 'is-empty'}`.trim(),
            'aria-expanded': String(open),
            title: i18n('Item description'),
            onClick: () => {
                if (openItems.has(column.uid)) openItems.delete(column.uid);
                else openItems.add(column.uid);
                paintEditor();
                if (openItems.has(column.uid)) requestAnimationFrame(() => editor.querySelector(`[data-uid="${column.uid}"] .ml-schema-itemhint`)?.focus({ preventScroll: true }));
            },
        },
        h('span', { class: 'ml-schema-ai-mark', title: i18n('Prompt for the AI'), 'aria-label': i18n('Prompt for the AI') }, icon('sparkle', { size: 11 })),
        h('span', { class: 'ml-schema-hintbtn-text', text: open ? i18n('Editing the prompt for the AI') : preview }),
        icon(open ? 'chevronUp' : 'chevronDown', { size: 13 }));
        const required = h('button', {
            type: 'button',
            role: 'switch',
            class: 'ml-schema-req',
            'aria-checked': String(Boolean(column.required)),
            disabled: column.locked,
            title: column.locked ? i18n('This item is the body of the event and cannot be deleted') : i18n('Must be filled in'),
            onClick: () => {
                column.required = !column.required;
                required.setAttribute('aria-checked', String(column.required));
                touched();
            },
        }, h('span', { text: i18n('Required') }));
        const grip = h('button', {
            type: 'button',
            class: 'ml-schema-grip',
            'aria-label': i18n('Drag to reorder item'),
            title: i18n('Drag to reorder item'),
            onPointerdown: (event) => startDrag(event, row, draft),
            onKeydown: (event) => {
                if (event.key === 'ArrowUp') { event.preventDefault(); moveItem(draft, column, -1, true); }
                if (event.key === 'ArrowDown') { event.preventDefault(); moveItem(draft, column, 1, true); }
            },
        }, icon('grip', { size: 14 }));
        const row = h('li', { class: `ml-schema-item ${column.isNew ? 'is-new' : ''} ${open ? 'is-open' : ''}`.trim(), dataset: { uid: column.uid } },
            h('div', { class: 'ml-schema-item-line' },
                grip,
                nameInput,
                toggle,
                required,
                iconButton('trash', column.locked ? i18n('This item is the body of the event and cannot be deleted') : i18n('Delete'), () => removeItem(draft, column), { className: 'ml-iconbtn-sm ml-schema-danger', disabled: column.locked })),
            open ? promptBlock({
                value: column.hint,
                placeholder: column.usesDefaultHint ? i18n('Use the default description') : i18n('Tell the AI what to write for this item'),
                label: i18n('Item description'),
                note: i18n('The AI follows this when it records this item'),
                className: 'ml-schema-itemhint',
                onInput: (value) => { column.hint = value; touched(); },
            }) : null);
        return row;
    }

    function promptBlock({ value, placeholder, label, note, className = '', compact = false, onInput }) {
        const area = autoTextarea({ value, placeholder, label, className, onInput });
        return h('div', { class: `ml-prompt ${compact ? 'is-compact' : ''}`.trim() },
            h('div', { class: 'ml-prompt-head' },
                h('span', { class: 'ml-prompt-tag' }, icon('sparkle', { size: 11 }), h('span', { text: i18n('Prompt for the AI') })),
                h('span', { class: 'ml-prompt-note', text: note })),
            area);
    }

    function autoTextarea({ value, placeholder, label, className = '', onInput }) {
        const area = h('textarea', {
            class: `ml-schema-input ml-schema-textarea ${className}`.trim(),
            rows: 1,
            placeholder,
            'aria-label': label,
            onInput: (event) => { fit(); onInput(event.target.value); },
        });
        area.value = value;
        const fit = () => {
            area.style.height = 'auto';
            // cap-ok: auto-grow textarea viewport height ceiling before inner scrollbar activates
            area.style.height = `${Math.min(area.scrollHeight + 2, 220)}px`;
        };
        requestAnimationFrame(fit);
        return area;
    }

    // ----- Edits ----------------------------------------------------------
    let touchedFrame = 0;
    function touched() {
        typeSummary.update();
        if (errors.length) {
            errors = validateDrafts(drafts).filter(e => errors.some(prev => prev.uid === e.uid));
        }
        cancelAnimationFrame(touchedFrame);
        touchedFrame = requestAnimationFrame(() => {
            paintBar();
            for (const draft of drafts) {
                const item = list.querySelector(`[data-uid="${draft.uid}"]`);
                if (!item) continue;
                const meta = item.querySelector('.ml-schema-type-meta');
                if (meta) meta.textContent = typeMeta(draft);
                const dot = item.querySelector('.ml-schema-dot');
                const changed = typeChanged(draft);
                if (changed && !dot) item.insertBefore(h('span', { class: 'ml-schema-dot', 'aria-label': i18n('Unsaved changes') }), item.lastChild);
                if (!changed && dot) dot.remove();
                item.classList.toggle('has-error', errors.some(e => e.uid === draft.uid));
            }
        });
    }

    function addItem(draft) {
        const column = newColumn(draft, '');
        draft.columns.push(column);
        paintEditor();
        touched();
        requestAnimationFrame(() => {
            const input = editor.querySelector(`[data-uid="${column.uid}"] .ml-schema-itemname`);
            input?.focus({ preventScroll: true });
            scrollChildIntoView(editor, input, { block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        });
    }

    function removeItem(draft, column) {
        if (column.locked) return;
        draft.columns = draft.columns.filter(c => c !== column);
        draft.raw.primaryKeyColumns = resolvePrimaryKeys(draft);
        paintEditor();
        touched();
    }

    function moveItem(draft, column, delta, keepFocus = false) {
        const index = draft.columns.indexOf(column);
        const next = index + delta;
        if (index < 0 || next < 0 || next >= draft.columns.length) return;
        draft.columns.splice(index, 1);
        draft.columns.splice(next, 0, column);
        paintEditor();
        touched();
        if (keepFocus) requestAnimationFrame(() => editor.querySelector(`[data-uid="${column.uid}"] .ml-schema-grip`)?.focus({ preventScroll: true }));
    }

    function startDrag(event, row, draft) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const grip = event.currentTarget;
        const container = row.parentElement;
        row.classList.add('is-dragging');
        grip.setPointerCapture?.(event.pointerId);
        const move = (e) => {
            const siblings = [...container.children].filter(x => x !== row);
            let before = null;
            for (const sibling of siblings) {
                const rect = sibling.getBoundingClientRect();
                if (e.clientY < rect.top + rect.height / 2) { before = sibling; break; }
            }
            if (before) {
                if (before !== row.nextSibling) container.insertBefore(row, before);
            } else if (container.lastChild !== row) {
                container.appendChild(row);
            }
        };
        const end = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            row.classList.remove('is-dragging');
            const order = [...container.children].map(x => x.dataset.uid);
            const before = draft.columns.map(c => c.uid).join('|');
            draft.columns.sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid));
            if (draft.columns.map(c => c.uid).join('|') !== before) {
                paintEditor();
                touched();
            }
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    }

    function addType() {
        const draft = newTypeDraft(drafts);
        drafts.push(draft);
        selectedUid = draft.uid;
        pane = 'editor';
        paint();
    }

    function deleteType(draft) {
        const count = nodeCount(draft.id);
        confirmModal({
            title: i18n('Delete this type'),
            lines: [i18nFormat('Delete "${0}"? ${1}', draft.name.trim() || i18n('New memory type'), count ? i18nFormat('The current chat has ${0} memories of this type, they stay stored but are no longer shown or recorded.', count) : '')],
            okLabel: i18n('Delete this type'),
            danger: true,
            onOk: () => {
                const index = drafts.indexOf(draft);
                drafts = drafts.filter(d => d !== draft);
                selectedUid = (drafts[Math.max(0, index - 1)] || drafts[0])?.uid || '';
                pane = 'list';
                paint();
            },
        });
    }

    function discard() {
        drafts = cloneDrafts(base);
        scopeCharacter = info?.scope === 'character';
        errors = [];
        if (!drafts.some(d => d.uid === selectedUid)) selectedUid = drafts[0]?.uid || '';
        paint();
    }

    function resetDefaults() {
        confirmModal({
            title: i18n('Restore defaults'),
            lines: [i18n('Restore Luker\'s default memory structure? Unsaved changes will be lost.')],
            okLabel: i18n('Restore defaults'),
            onOk: () => {
                const fresh = toDrafts(info.defaults, {}, info.defaults);
                for (const draft of fresh) {
                    const prev = drafts.find(d => d.id === draft.id);
                    if (prev) draft.uid = prev.uid;
                }
                drafts = fresh;
                errors = [];
                if (!drafts.some(d => d.uid === selectedUid)) selectedUid = drafts[0]?.uid || '';
                paint();
            },
        });
    }

    function replaceTypes(types, labels = {}) {
        const fresh = toDrafts(types, { ...(info.labels || {}), ...labels }, info.defaults);
        for (const draft of fresh) {
            const prev = drafts.find(d => d.id === draft.id);
            if (prev) draft.uid = prev.uid;
        }
        drafts = fresh;
        errors = [];
        if (!drafts.some(d => d.uid === selectedUid)) selectedUid = drafts[0]?.uid || '';
        pane = 'list';
        paint();
    }

    function pickTemplate() {
        let chosen = TEMPLATES[0].id;
        const nameOf = (id) => {
            const spec = drafts.find(d => d.id === id) || null;
            return spec?.name.trim() || toDrafts([info.defaults.find(d => d.id === id) || { id }])[0].name;
        };
        const cards = TEMPLATES.map(tpl => h('button', {
            type: 'button',
            role: 'radio',
            class: 'ml-tpl',
            'aria-checked': String(tpl.id === chosen),
            dataset: { id: tpl.id },
            onClick: () => {
                chosen = tpl.id;
                for (const el of wrap.querySelectorAll('.ml-tpl')) el.setAttribute('aria-checked', String(el.dataset.id === chosen));
            },
        },
        h('span', { class: 'ml-tpl-radio', 'aria-hidden': 'true' }),
        h('span', { class: 'ml-tpl-main' },
            h('span', { class: 'ml-tpl-name', text: tpl.name }),
            h('span', { class: 'ml-tpl-note', text: tpl.note }),
            h('span', { class: 'ml-tpl-types' }, templateTypeNames(tpl, nameOf).map(name => h('span', { class: 'ml-tpl-type', text: name }))))));
        const wrap = h('div', { class: 'ml-tpls' },
            h('p', { class: 'ml-ask-text', text: i18n('Replaces the memory types on the left (Event stays as it is). Nothing is saved yet, press Discard changes if you do not like it.') }),
            h('div', { role: 'radiogroup', 'aria-label': i18n('Pick a memory structure template'), class: 'ml-tpl-list' }, cards));
        confirmModal({
            title: i18n('Pick a memory structure template'),
            content: wrap,
            okLabel: i18n('Use template'),
            focus: cards[0],
            onOk: () => {
                const tpl = TEMPLATES.find(x => x.id === chosen);
                const { types, labels } = buildTemplate(tpl, drafts.map(fromDraft), info.defaults);
                replaceTypes(types, labels);
                showToast(i18nFormat('Applied "${0}". Review it, then press Save.', tpl.name), { tone: 'ok' });
            },
        });
    }

    async function importSchema() {
        const run = async () => {
            try {
                const result = await access.importFile();
                if (!result) return;
                replaceTypes(result.types, result.labels);
                showToast(i18n('Imported into the editor. Review it, then press Save.'), { tone: 'ok' });
            } catch (err) {
                showToast(i18nFormat('Operation failed: ${0}', String(err?.message || err)));
            }
        };
        if (!isDirty()) { run(); return; }
        confirmModal({ title: i18n('Import'), lines: [i18n('Importing replaces unsaved changes in the editor. Continue?')], okLabel: i18n('Import'), onOk: run });
    }

    async function exportSchema() {
        try {
            const name = await access.exportFile(drafts.map(fromDraft), currentLabels());
            showToast(i18nFormat('Downloaded: ${0}', name), { tone: 'ok' });
        } catch (err) {
            showToast(i18nFormat('Operation failed: ${0}', String(err?.message || err)));
        }
    }

    function useGlobal() {
        confirmModal({
            title: i18n('Switch back to the shared structure'),
            lines: [i18nFormat('Switch "${0}" back to the shared memory structure?', info.characterName)],
            okLabel: i18n('Switch back to the shared structure'),
            onOk: async () => {
                try {
                    await access.clearCharacter();
                    await load();
                    app.reload();
                } catch (err) {
                    showToast(i18nFormat('Save failed: ${0}', String(err?.message || err)));
                }
            },
        });
    }

    function currentLabels() {
        const labels = {};
        for (const draft of drafts) {
            for (const column of draft.columns) {
                if (column.label.trim()) (labels[draft.id] ||= {})[column.key] = column.label.trim();
            }
        }
        return labels;
    }

    // ----- Save / undo ----------------------------------------------------
    function save() {
        if (saving) return;
        errors = validateDrafts(drafts);
        if (errors.length) {
            const first = drafts.find(d => d.uid === errors[0].uid);
            if (first) selectedUid = first.uid;
            pane = 'editor';
            paint();
            requestAnimationFrame(() => editor.querySelector('[aria-invalid="true"]')?.focus({ preventScroll: true }));
            return;
        }
        const changes = describeChanges(base, drafts, app.model()?.typeCounts || new Map());
        if (scopeChanged()) {
            changes.push({
                name: i18n('Scope of effect'),
                kind: 'changed',
                lines: [scopeCharacter
                    ? i18nFormat('Applies only to "${0}", other characters are not affected', info.characterName)
                    : i18nFormat('"${0}" switches back to the shared structure, changes apply to all characters', info.characterName)],
            });
        }
        if (!changes.length) return;
        confirmModal({
            title: i18n('Confirm save'),
            changes,
            okLabel: i18n('Save'),
            onOk: () => doWrite(),
        });
    }

    async function doWrite() {
        saving = true;
        paintBar();
        try {
            const labels = { ...(info.labels || {}) };
            const next = labelsFromDrafts(drafts);
            for (const id of new Set([...base.map(d => d.id), ...drafts.map(d => d.id)])) {
                if (next[id]) labels[id] = next[id];
                else delete labels[id];
            }
            const previous = await access.write(drafts.map(fromDraft), {
                scope: scopeCharacter ? 'character' : 'global',
                expectedAvatar: info?.avatar || '',
                labels,
            });
            saving = false;
            setUndo(previous);
            await load();
            app.reload();
        } catch (err) {
            saving = false;
            paintBar();
            showToast(i18nFormat('Save failed: ${0}', String(err?.message || err)));
        }
    }

    function setUndo(previous) {
        undoSnapshot = previous;
        clearTimeout(undoTimer);
        showToast(i18n('Saved'), {
            action: i18n('Undo'),
            onAction: async () => {
                const snapshot = undoSnapshot;
                undoSnapshot = null;
                hideToast();
                if (!snapshot) return;
                try {
                    await access.restore(snapshot);
                    await load();
                    app.reload();
                    showToast(i18n('Undone'), { tone: 'ok' });
                } catch (err) {
                    showToast(i18nFormat('Save failed: ${0}', String(err?.message || err)));
                }
            },
        });
        undoTimer = setTimeout(() => { undoSnapshot = null; hideToast(); }, UNDO_MS);
    }

    function showToast(text, { action = '', onAction = null, tone = '' } = {}) {
        const isError = !action && tone !== 'ok';
        if (typeof app.showToast === 'function') {
            app.showToast(text, { action, onAction, error: isError, duration: action ? UNDO_MS : 3500 });
            return;
        }
        clear(toast);
        toast.classList.toggle('is-error', isError);
        put(toast,
            icon(action || tone === 'ok' ? 'check' : 'alert', { size: 15 }),
            h('span', { text }),
            action ? h('button', { type: 'button', class: 'ml-schema-toast-btn', onClick: onAction }, icon('undo', { size: 14 }), h('span', { text: action })) : null);
        toast.hidden = false;
        if (!action) {
            clearTimeout(undoTimer);
            undoTimer = setTimeout(hideToast, 3500);
        }
    }

    function hideToast() {
        toast.hidden = true;
    }

    // ----- Modal ----------------------------------------------------------
    function confirmModal({ title, lines = [], changes = null, content: custom = null, okLabel, danger = false, onOk, onCancel = null, focus = null, className = '' }) {
        closeModal();
        const content = custom || (changes
            ? h('ul', { class: 'ml-schema-changes' }, changes.map(change => h('li', { dataset: { kind: change.kind } },
                h('div', { class: 'ml-schema-change-name' }, h('span', { class: 'ml-schema-change-kind', text: change.kind === 'added' ? i18n('New') : change.kind === 'removed' ? i18n('Delete') : i18n('Modify') }), h('span', { text: change.name || i18n('New memory type') })),
                h('ul', null, change.lines.map(line => h('li', { text: line }))))))
            : h('div', { class: 'ml-schema-confirm-text' }, lines.filter(Boolean).map(line => h('p', { text: line }))));
        modalCancel = onCancel;
        const ok = button(okLabel, async () => { modalCancel = null; closeModal(); await onOk(); }, { className: danger ? 'ml-btn-danger' : 'ml-btn-primary' });
        const panel = h('div', { class: `ml-dialog ml-schema-modal ${custom ? 'is-wide' : ''} ${className}`.trim(), role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
            h('header', { class: 'ml-dialog-head' }, h('h3', { class: 'ml-dialog-title', text: title })),
            h('div', { class: 'ml-dialog-body' }, content),
            h('footer', { class: 'ml-schema-modal-foot' }, button(i18n('Cancel'), () => closeModal(), { className: 'ml-btn-ghost' }), ok));
        modal = h('div', {
            class: 'ml-dialog-backdrop',
            onMousedown: (event) => { if (event.target === modal) closeModal(); },
            onKeydown: (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') closeModal();
            },
        }, panel);
        app.root.appendChild(modal);
        requestAnimationFrame(() => (focus || ok).focus({ preventScroll: true }));
    }

    function closeModal() {
        if (!modal) return false;
        modal.remove();
        modal = null;
        const cancel = modalCancel;
        modalCancel = null;
        cancel?.();
        return true;
    }

    return {
        id: 'schema',
        el: root,
        render() {
            if (status === 'idle' || (needsReload && !isDirty())) {
                load();
                return;
            }
            if (status === 'ready') touched();
        },
        onShow() {
            if (status === 'idle' || (needsReload && !isDirty())) {
                load();
                return;
            }
            if (status === 'ready') {
                syncGlobalSettingsFromSource();
                typeSummary.update();
            }
        },
        invalidate() {
            needsReload = true;
        },
        onEscape() {
            if (closeModal()) return true;
            const active = document.activeElement;
            if (active && root.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
                active.blur();
                root.focus?.();
                return true;
            }
            if (app.isCompact() && pane === 'editor') {
                pane = 'list';
                paint();
                return true;
            }
            return false;
        },
        isDirty,
        destroy() {
            cancelAnimationFrame(touchedFrame);
            clearTimeout(undoTimer);
            closeModal();
            typeSummary.destroy();
            unsubscribeSettings();
        },
    };
}
