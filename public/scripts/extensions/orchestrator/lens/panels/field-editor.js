// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Editable blocks for one agent field in the inspector: a prompt (text) or
// a model choice (select). Edits go into the draft; the topbar's save bar
// writes them. Long prompts edit in a tall textarea; Done keeps the text in
// the draft, Cancel drops this edit.

import { h, clear, put, copyText } from '../../../lens-shared/util.js';
import { i18n, i18nFormat } from '../i18n.js';
import { iconButton, button } from '../ui/components.js';

const PREVIEW = 420;

/**
 * @param {{ app: object, title: string, value: string, original: string, editable: boolean,
 *   onChange(value: string): void, fullTitle?: string, placeholder?: string, aiAction?: () => void }} opts
 */
export function textField({ app, title, value, original, editable, onChange, fullTitle = title, placeholder = '', aiAction = null }) {
    const el = h('section', { class: 'ol-insp-section ol-field', dataset: { changed: value !== original ? 'true' : null } });
    let editing = false;

    function view() {
        clear(el);
        const text = String(value || '');
        const long = text.length > PREVIEW;
        const changed = value !== original;
        put(el,
            h('div', { class: 'ol-section-title' },
                h('span', { text: title }),
                changed ? h('span', { class: 'ol-field-dirty', text: i18n('Unsaved') }) : null,
                h('span', { class: 'ol-insp-actions' },
                    text ? iconButton('copy', i18n('Copy'), async () => { if (await copyText(text)) app.notify(i18n('Copied')); }, { className: 'ol-iconbtn-sm' }) : null,
                    long ? iconButton('fit', i18n('View full screen'), () => app.showText(fullTitle, [{ title: '', text }]), { className: 'ol-iconbtn-sm' }) : null,
                    aiAction ? iconButton('sparkle', i18n('Let the AI improve this'), aiAction, { className: 'ol-iconbtn-sm' }) : null,
                    editable ? iconButton('pen', i18n('Edit field'), () => edit(), { className: 'ol-iconbtn-sm' }) : null)),
            text
                ? h('div', { class: `ol-prompt${long ? ' is-clamped' : ''}${editable ? ' is-editable' : ''}`, text, onDblclick: editable ? () => edit() : null, title: editable ? i18n('Double-click to edit') : null })
                : h('div', { class: `ol-prompt is-empty${editable ? ' is-editable' : ''}`, text: editable ? i18n('(empty; click the pen at the top right to edit)') : i18n('(empty)'), onDblclick: editable ? () => edit() : null }),
            changed ? h('div', { class: 'ol-field-foot' }, button(i18n('Revert'), () => { value = original; onChange(original); view(); }, { iconName: 'undo', className: 'ol-btn-sm ol-btn-ghost' })) : null);
    }

    function edit() {
        if (editing) return;
        editing = true;
        clear(el);
        const area = h('textarea', {
            class: 'ol-field-input',
            spellcheck: 'false',
            placeholder,
            'aria-label': title,
            onKeydown: (event) => {
                event.stopPropagation();
                if (event.key === 'Escape') { event.preventDefault(); done(false); }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); done(true); }
            },
        });
        area.value = String(value || '');
        const done = (keep) => {
            editing = false;
            if (keep && area.value !== value) {
                value = area.value;
                onChange(value);
            }
            view();
        };
        put(el,
            h('div', { class: 'ol-section-title' }, h('span', { text: title }), h('span', { class: 'ol-insp-note', text: i18nFormat('${0} characters', area.value.length) })),
            area,
            h('div', { class: 'ol-field-foot' },
                h('span', { class: 'ol-field-hint', text: i18n('Edits go into the draft first and apply when you click "Save" at the top') }),
                button(i18n('Cancel'), () => done(false), { className: 'ol-btn-sm ol-btn-ghost' }),
                button(i18n('Done'), () => done(true), { iconName: 'check', className: 'ol-btn-sm ol-btn-primary' })));
        area.addEventListener('input', () => {
            const note = el.querySelector('.ol-insp-note');
            if (note) note.textContent = i18nFormat('${0} characters', area.value.length);
            area.style.height = 'auto';
            area.style.height = `${Math.min(Math.max(area.scrollHeight + 2, 140), 560)}px`;
        });
        requestAnimationFrame(() => {
            area.style.height = `${Math.min(Math.max(area.scrollHeight + 2, 140), 560)}px`;
            area.focus({ preventScroll: true });
            area.setSelectionRange(area.value.length, area.value.length);
        });
    }

    view();
    return el;
}

/**
 * Model routing rows (connection profile and generation preset) with selects.
 * @param {{ rows: { field: string, label: string, value: string, original: string, options: string[] }[],
 *   editable: boolean, onChange(field: string, value: string): void, fallback: string }} opts
 */
export function routingField({ rows, editable, onChange, fallback }) {
    return h('section', { class: 'ol-insp-section' },
        h('div', { class: 'ol-section-title' }, h('span', { text: i18n('AI model') })),
        h('dl', { class: 'ol-kv is-wide ol-routing' }, rows.map(row => {
            const changed = row.value !== row.original;
            if (!editable) return [h('dt', { text: row.label }), h('dd', { class: row.value ? '' : 'is-muted', text: row.value || fallback })];
            const names = [...new Set([...row.options, row.value, row.original].filter(Boolean))];
            const select = h('select', {
                class: 'ol-select',
                'aria-label': row.label,
                onChange: () => onChange(row.field, select.value),
            },
            h('option', { value: '', text: fallback }),
            names.map(name => h('option', { value: name, text: row.options.includes(name) ? name : i18nFormat('${0} (no longer exists)', name) })));
            select.value = row.value;
            return [h('dt', { text: row.label }), h('dd', { dataset: { changed: changed ? 'true' : null } }, select, changed ? h('span', { class: 'ol-field-dirty', text: i18n('Unsaved') }) : null)];
        })));
}
