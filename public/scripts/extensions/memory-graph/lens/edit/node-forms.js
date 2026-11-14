// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Forms for creating and deleting memories and managing their relationships.

import { h } from '../../../lens-shared/util.js';
import { i18n, i18nFormat, typeLabel, fieldLabel, relationOptionLabel, relationTypes } from '../i18n.js';
import { button, checkRow, iconButton } from '../ui/components.js';
import { confirmText, formField, openModal, selectInput } from '../panels/modal.js';

const nodeOptions = (model, { exclude = '', empty = null } = {}) => [
    ...(empty === null ? [] : [{ value: '', label: empty }]),
    ...[...model.nodes.values()]
        .filter(node => node.id !== exclude)
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(node => ({ value: node.id, label: `${node.title} · ${typeLabel(node.type)}` })),
];

const typeOptions = (model, current = '') => [...new Set([...model.typeList, ...(current ? [current] : [])])]
    .map(type => ({ value: type, label: typeLabel(type) }));

const textArea = (rows = 2) => h('textarea', { class: 'ml-schema-input', rows });
const textInput = (value = '') => h('input', { class: 'ml-schema-input', type: 'text', value });

export function openCreateNode(app) {
    const model = app.model();
    if (!model) { app.notify(i18n('Open a chat first.')); return; }
    const columnsBox = h('div', { class: 'ml-aiset' });
    let inputs = new Map();
    let titleInput = null;
    const paint = (type) => {
        columnsBox.replaceChildren();
        inputs = new Map();
        const columns = model.schemaColumns.get(type) || [];
        titleInput = columns.includes('title') ? null : textInput();
        if (titleInput) columnsBox.append(formField(i18n('Name'), titleInput));
        for (const key of columns) {
            const input = textArea();
            inputs.set(key, input);
            columnsBox.append(formField(fieldLabel(key, type), input));
        }
    };
    const types = typeOptions(model).filter(option => model.schemaColumns.has(option.value));
    const typeSelect = selectInput(types, types[0]?.value || '', paint);
    paint(typeSelect.value);
    openModal(app, {
        title: i18n('New memory'),
        content: h('div', { class: 'ml-aiset' }, formField(i18n('Type'), typeSelect), columnsBox),
        okLabel: i18n('Create'),
        async onOk() {
            const fields = {};
            for (const [key, input] of inputs) {
                const value = input.value.trim();
                if (value) fields[key] = value;
            }
            const title = titleInput ? titleInput.value.trim() : String(fields.title || '');
            if (!title && !Object.keys(fields).length) { app.notify(i18n('Fill in at least one item')); return false; }
            const snapshot = await app.applyEdit(edit => edit.createNode({ type: typeSelect.value, title, fields }), i18n('Created'), model.chatKey);
            if (snapshot?.result) app.select(snapshot.result);
            return true;
        },
    });
}

function countSubtree(model, node) {
    let count = 0;
    const seen = new Set();
    const walk = (current) => {
        for (const id of current.childrenIds) {
            if (seen.has(id) || !model.nodes.has(id)) continue;
            seen.add(id);
            count += 1;
            walk(model.nodes.get(id));
        }
    };
    walk(node);
    return count;
}

export function confirmDeleteNode(app, node) {
    const model = app.model();
    const descendants = countSubtree(model, node);
    confirmText(app, {
        title: i18n('Delete'),
        lines: [
            i18nFormat('Delete "${0}"?', node.title),
            descendants ? i18nFormat('This also deletes ${0} memories under it, and all related relationships.', descendants) : i18n('All related relationships are deleted with it.'),
        ],
        okLabel: i18n('Delete'),
        danger: true,
        async onOk() {
            const snapshot = await app.applyEdit(edit => edit.removeNode(node.id), i18n('Deleted'), model.chatKey);
            if (snapshot) app.select('');
        },
    });
}

export function openNodeProperties(app, node) {
    const model = app.model();
    const typeSelect = selectInput(typeOptions(model, node.type), node.type);
    const level = node.rawLevel || 'semantic';
    const levelSelect = selectInput([
        { value: 'semantic', label: i18n('Semantic') },
        ...(level === 'semantic' ? [] : [{ value: level, label: level }]),
    ], level);
    const titleInput = textInput(node.rawTitle);
    const seqInput = h('input', { class: 'ml-schema-input', type: 'number', step: 1, value: node.seqTo >= 0 ? String(node.seqTo) : '' });
    const parentSelect = selectInput(nodeOptions(model, { exclude: node.id, empty: i18n('(none)') }), node.parentId);
    let archived = node.archived;
    openModal(app, {
        title: i18n('Node properties'),
        content: h('div', { class: 'ml-aiset' },
            h('div', { class: 'ml-aiset-fields' },
                formField(i18n('Type'), typeSelect),
                formField(i18n('Level'), levelSelect),
                formField(i18n('Name'), titleInput),
                formField(i18n('Floor'), seqInput)),
            formField(i18n('Parent'), parentSelect),
            checkRow({ checked: archived, label: i18n('Archived'), onChange: (value) => { archived = value; } })),
        okLabel: i18n('Save'),
        async onOk() {
            const patch = {};
            if (typeSelect.value !== node.type) patch.type = typeSelect.value;
            if (levelSelect.value !== level) patch.level = levelSelect.value;
            if (titleInput.value.trim() !== node.rawTitle) patch.title = titleInput.value;
            const seqText = seqInput.value.trim();
            const seq = seqText === '' ? null : Number(seqText);
            if ((seq ?? -1) !== node.seqTo) patch.seqTo = seq;
            if (archived !== node.archived) patch.archived = archived;
            if (parentSelect.value !== node.parentId) patch.parentId = parentSelect.value;
            if (Object.keys(patch).length) await app.applyEdit(edit => edit.updateNode(node, patch), i18n('Modified'), model.chatKey);
            return true;
        },
    });
}

/** Stored edges touching this node; a mirrored pair is two stored edges. */
export function storedEdgesOf(model, id) {
    const seen = new Set();
    const out = [];
    const add = (from, to, type) => {
        const key = `${type}|${from}|${to}`;
        if (!seen.has(key)) { seen.add(key); out.push({ from, to, type }); }
    };
    for (const edge of model.adjacency.get(id) || []) {
        add(edge.from, edge.to, edge.type);
        if (edge.mirrored) add(edge.to, edge.from, edge.type);
    }
    return out;
}

const nodeTitle = (model, id) => model.nodes.get(id)?.title || id;
const edgeText = (model, edge) => `${nodeTitle(model, edge.from)} → ${nodeTitle(model, edge.to)}`;

function openEdgeForm(app, model, node, edge = null) {
    const typeValues = [...new Set([...relationTypes(), ...model.edges.map(item => item.type), ...(edge ? [edge.type] : [])])];
    const fromSelect = selectInput(nodeOptions(model), edge?.from || node.id);
    const toSelect = selectInput(nodeOptions(model), edge?.to || '');
    const typeSelect = selectInput(typeValues.map(type => ({ value: type, label: relationOptionLabel(type) })), edge?.type || 'related');
    if (!edge) toSelect.selectedIndex = -1;
    openModal(app, {
        title: edge ? i18n('Edit relationship') : i18n('Add relationship'),
        content: h('div', { class: 'ml-aiset' },
            formField(i18n('From'), fromSelect),
            formField(i18n('To'), toSelect),
            formField(i18n('Type'), typeSelect)),
        okLabel: i18n('Save'),
        async onOk() {
            const next = { from: fromSelect.value, to: toSelect.value, type: typeSelect.value };
            if (!next.to) { app.notify(i18n('Choose both memories')); return false; }
            if (edge) await app.applyEdit(item => item.updateEdge(edge, next), i18n('Modified'), model.chatKey);
            else await app.applyEdit(item => item.addEdge(next), i18n('Created'), model.chatKey);
            return true;
        },
    });
}

export function openEdgeManager(app, node) {
    const model = app.model();
    const edges = storedEdgesOf(model, node.id);
    const reverseStored = (edge) => edges.some(item => item.from === edge.to && item.to === edge.from && item.type === edge.type);
    let closeList = null;
    const askDelete = (edge) => {
        closeList?.();
        confirmText(app, {
            title: i18n('Delete relationship'),
            lines: [
                `${edgeText(model, edge)} · ${relationOptionLabel(edge.type)}`,
                reverseStored(edge) ? i18n('Only this direction is deleted; the reverse relationship stays.') : '',
            ],
            okLabel: i18n('Delete'),
            danger: true,
            onOk: () => { void app.applyEdit(item => item.removeEdge(edge), i18n('Deleted'), model.chatKey); },
        });
    };
    const rows = edges.map(edge => h('div', { class: 'ml-edge-row' },
        h('span', { class: 'ml-edge-text', text: edgeText(model, edge) }),
        h('span', { class: 'ml-tag-muted', text: relationOptionLabel(edge.type) }),
        iconButton('gear', i18n('Edit relationship'), () => { closeList?.(); openEdgeForm(app, model, node, edge); }, { className: 'ml-iconbtn-sm' }),
        iconButton('trash', i18n('Delete relationship'), () => askDelete(edge), { className: 'ml-iconbtn-sm' })));
    closeList = openModal(app, {
        title: i18n('Relationships'),
        content: h('div', { class: 'ml-edge-list' }, rows, button(i18n('Add relationship'), () => { closeList?.(); openEdgeForm(app, model, node); }, { iconName: 'plus', className: 'ml-btn-ghost' })),
    });
}
