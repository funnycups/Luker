/**
 * @file Variable operation panel
 *
 * The panel exposes a per-message view of `extra.var_ops`. Users can:
 *   • see exactly what variable operations the AI (or themselves) recorded
 *     for this message
 *   • edit an op's key or value
 *   • delete an op
 *   • add a new op (which lands on the message's var_ops)
 *
 * After any mutation we trigger a full rebuild — same path that
 * MESSAGE_DELETED takes — so the variables cache reflects the new op-log
 * without any drift.
 *
 * The panel UI is rendered inside ST's generic popup. We don't create our
 * own modal stack — keeps styling consistent and key handling correct.
 */

import { chat, chat_metadata, eventSource, event_types, saveChatConditional } from '../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../popup.js';
import { t, translate } from '../i18n.js';
import { rebuildVariablesFromChat } from './index.js';

const OP_TYPES = ['setvar', 'addvar', 'incvar', 'decvar', 'deletevar', 'pushvar', 'popvar'];

/** @returns {boolean} true if op type carries a value field */
function opHasValue(opType) {
    return opType === 'setvar' || opType === 'addvar' || opType === 'pushvar';
}

/**
 * Render the panel for a given message id and open it as a modal popup.
 * Returns when the user closes the popup.
 *
 * @param {number} messageId
 */
export async function openVarOpsPanel(messageId) {
    const message = chat[messageId];
    if (!message) return;

    if (!message.extra) message.extra = {};
    if (!Array.isArray(message.extra.var_ops)) message.extra.var_ops = [];

    const root = $('<div class="var-ops-panel"></div>');
    const header = $('<div class="var-ops-panel__header"></div>');
    $('<div class="var-ops-panel__title"></div>')
        .text(t`Variable operations on message #${messageId}`)
        .appendTo(header);
    $('<div class="var-ops-panel__hint"></div>')
        .text(translate('Changes apply when you click Save. The variables cache will be rebuilt from all surviving ops.'))
        .appendTo(header);
    const list = $('<div class="var-ops-panel__list"></div>');
    const addBar = $('<div class="var-ops-panel__add-bar"></div>');
    const addButton = $('<div class="menu_button var-ops-panel__add-button"><i class="fa-solid fa-plus"></i> </div>');
    addButton[0].appendChild(document.createTextNode(translate('Add operation')));
    addBar.append(addButton);

    root.append(header).append(list).append(addBar);

    // Local working copy — only commit on Save
    let workingOps = JSON.parse(JSON.stringify(message.extra.var_ops));

    function renderList() {
        list.empty();
        if (workingOps.length === 0) {
            list.append($('<div class="var-ops-panel__empty"></div>')
                .text(translate('No variable operations on this message.')));
            return;
        }
        workingOps.forEach((op, idx) => {
            const row = renderOpRow(op, idx, () => {
                workingOps.splice(idx, 1);
                renderList();
            }, (next) => {
                workingOps[idx] = next;
                renderList();
            });
            list.append(row);
        });
    }

    function renderOpRow(op, idx, onDelete, onChange) {
        const row = $('<div class="var-ops-panel__row"></div>');

        const opSelect = $('<select class="var-ops-panel__op text_pole"></select>');
        for (const opType of OP_TYPES) {
            opSelect.append(`<option value="${opType}"${opType === op.op ? ' selected' : ''}>${opType}</option>`);
        }
        opSelect.on('change', function () {
            /** @type {any} */
            const next = { op: this.value, key: op.key };
            if (op.path) next.path = op.path;
            if (opHasValue(this.value)) next.value = op.value ?? '';
            onChange(next);
        });

        const keyInput = $('<input type="text" class="var-ops-panel__key text_pole"/>')
            .attr('placeholder', translate('key', 'var_ops_panel.placeholder.key'))
            .val(op.key ?? '');
        keyInput.on('change', function () {
            const next = { ...op, key: String(this.value).trim() };
            onChange(next);
        });

        const pathInput = $('<input type="text" class="var-ops-panel__path text_pole"/>')
            .attr('placeholder', translate('path', 'var_ops_panel.placeholder.path'))
            .val(op.path ?? '');
        pathInput.on('change', function () {
            const trimmed = String(this.value).trim();
            const next = { ...op };
            if (trimmed) next.path = trimmed;
            else delete next.path;
            onChange(next);
        });

        const row1 = $('<div class="var-ops-panel__row-line"></div>')
            .append($('<span class="var-ops-panel__label"></span>').text(translate('op', 'var_ops_panel.label.op')))
            .append(opSelect)
            .append($('<span class="var-ops-panel__label"></span>').text(translate('key', 'var_ops_panel.label.key')))
            .append(keyInput)
            .append($('<span class="var-ops-panel__label"></span>').text(translate('path', 'var_ops_panel.label.path')))
            .append(pathInput);

        row.append(row1);

        if (opHasValue(op.op)) {
            const valueInput = $('<textarea class="var-ops-panel__value text_pole" rows="1"></textarea>')
                .attr('placeholder', translate('value', 'var_ops_panel.placeholder.value'))
                .val(op.value ?? '');
            valueInput.on('change', function () {
                const next = { ...op, value: String(this.value) };
                onChange(next);
            });
            const row2 = $('<div class="var-ops-panel__row-line"></div>')
                .append($('<span class="var-ops-panel__label"></span>').text(translate('value', 'var_ops_panel.label.value')))
                .append(valueInput);
            row.append(row2);
        }

        const delBtn = $('<div class="menu_button var-ops-panel__delete"><i class="fa-solid fa-trash"></i> </div>');
        delBtn[0].appendChild(document.createTextNode(translate('Remove')));
        delBtn.on('click', () => onDelete());
        const actions = $('<div class="var-ops-panel__row-actions"></div>').append(delBtn);
        row.append(actions);

        return row;
    }

    addButton.on('click', () => {
        workingOps.push({ op: 'setvar', key: '', value: '' });
        renderList();
    });

    renderList();

    const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
    });

    if (!result) return;

    // Sanitize — drop ops with empty keys, normalize value field
    const cleaned = workingOps
        .map(op => {
            const out = {
                op: OP_TYPES.includes(op.op) ? op.op : 'setvar',
                key: typeof op.key === 'string' ? op.key.trim() : '',
            };
            const pathVal = typeof op.path === 'string' ? op.path.trim() : '';
            if (pathVal) out.path = pathVal;
            if (opHasValue(out.op)) out.value = op.value ?? '';
            return out;
        })
        .filter(op => op.key.length > 0);

    message.extra.var_ops = cleaned;

    // Mirror to swipe_info if applicable
    if (typeof message.swipe_id === 'number' &&
        Array.isArray(message.swipe_info) &&
        message.swipe_id >= 0 &&
        message.swipe_id < message.swipe_info.length) {
        const slot = message.swipe_info[message.swipe_id];
        if (slot) slot.extra = structuredClone(message.extra);
    }

    rebuildVariablesFromChat();
    await saveChatConditional();
    await eventSource.emit(event_types.MESSAGE_EDITED, messageId);
}

/**
 * Wire up event delegation for the per-message Variable button. Should be
 * called once during init, after the DOM is ready.
 */
export function initVarOpsPanelHandler() {
    $(document).on('click', '.mes_var_ops', async function () {
        const mes = $(this).closest('.mes');
        const idStr = mes.attr('mesid');
        if (!idStr) return;
        const messageId = parseInt(idStr, 10);
        if (Number.isNaN(messageId)) return;
        await openVarOpsPanel(messageId);
    });

    // Toggle button visibility per message: show only when the message has
    // any var_ops, OR when the user is in some "show all" mode (omitted
    // here — keep things simple: button is visible when var_ops is non-empty).
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, refreshButtonVisibility);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, refreshButtonVisibility);
    eventSource.on(event_types.MESSAGE_RECEIVED, refreshButtonVisibility);
    eventSource.on(event_types.MESSAGE_SENT, refreshButtonVisibility);
    eventSource.on(event_types.MESSAGE_EDITED, refreshButtonVisibility);
    eventSource.on(event_types.MESSAGE_SWIPED, refreshAllButtons);
    eventSource.on(event_types.MESSAGE_DELETED, refreshAllButtons);
    eventSource.on(event_types.MESSAGE_SWIPE_DELETED, refreshAllButtons);
    eventSource.on(event_types.CHAT_CHANGED, refreshAllButtons);
}

function refreshButtonVisibility(messageId) {
    if (typeof messageId !== 'number') return;
    const message = chat[messageId];
    if (!message) return;
    const hasOps = Array.isArray(message?.extra?.var_ops) && message.extra.var_ops.length > 0;
    const $btn = $(`.mes[mesid="${messageId}"] .mes_var_ops`);
    $btn.toggle(hasOps);
}

function refreshAllButtons() {
    $('.mes').each(function () {
        const idStr = $(this).attr('mesid');
        if (!idStr) return;
        const id = parseInt(idStr, 10);
        if (Number.isNaN(id)) return;
        refreshButtonVisibility(id);
    });
}
