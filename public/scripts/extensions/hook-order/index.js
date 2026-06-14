// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';

const MODULE_NAME = 'hook_order';
const UI_BLOCK_ID = 'hook_order_settings';
const STYLE_ID = 'hook_order_style';

const TARGET_EVENTS = [
    { key: 'GENERATION_CONTEXT_READY', label: 'Generation Context Ready' },
    { key: 'GENERATION_BEFORE_WORLD_INFO_SCAN', label: 'Before World Info Scan' },
    { key: 'GENERATION_AFTER_WORLD_INFO_SCAN', label: 'After World Info Scan' },
    { key: 'GENERATION_WORLD_INFO_FINALIZED', label: 'World Info Finalized' },
    { key: 'GENERATION_BEFORE_API_REQUEST', label: 'Before API Request' },
    { key: 'USER_MESSAGE_RENDERED', label: 'User Message Rendered' },
    { key: 'CHARACTER_MESSAGE_RENDERED', label: 'Character Message Rendered' },
    { key: 'MESSAGE_SENT', label: 'Message Sent' },
    { key: 'MESSAGE_RECEIVED', label: 'Message Received' },
    { key: 'MESSAGE_EDITED', label: 'Message Edited' },
    { key: 'MESSAGE_UPDATED', label: 'Message Updated' },
    { key: 'MESSAGE_DELETED', label: 'Message Deleted' },
    { key: 'MESSAGE_SWIPED', label: 'Message Swiped' },
    { key: 'MESSAGE_SWIPE_DELETED', label: 'Message Swipe Deleted' },
];

const defaultSettings = {
    orderByEvent: {},
    migratedFromAutoDiscover: false,
};

function i18n(text) {
    return translate(String(text || ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Hook Order': 'Hook 顺序',
        'Generation Context Ready': '生成上下文就绪',
        'Before World Info Scan': '世界书扫描前',
        'After World Info Scan': '世界书扫描后',
        'World Info Finalized': '世界书最终完成',
        'Before API Request': 'API 请求前',
        'User Message Rendered': '用户消息渲染后',
        'Character Message Rendered': '角色消息渲染后',
        'Message Sent': '消息发送后',
        'Message Received': '消息接收后',
        'Message Edited': '消息编辑后',
        'Message Updated': '消息更新后',
        'Message Deleted': '消息删除后',
        'Message Swiped': '消息切换后',
        'Message Swipe Deleted': '消息切换删除后',
        'Up': '上移',
        'Down': '下移',
        'Reset To Detected Order': '重置为检测到的顺序',
        'No extension listeners detected for this hook.': '该 Hook 未检测到扩展监听器。',
        'Hook listener list refreshed.': 'Hook 监听器列表已刷新。',
        'Core event ordering for extension listeners. Reorder plugins per hook.': '用于扩展监听器的核心事件顺序。可按 Hook 重排插件。',
        'Refresh Detected List': '刷新检测列表',
    });
    addLocaleData('zh-tw', {
        'Hook Order': 'Hook 順序',
        'Generation Context Ready': '生成上下文就緒',
        'Before World Info Scan': '世界書掃描前',
        'After World Info Scan': '世界書掃描後',
        'World Info Finalized': '世界書最終完成',
        'Before API Request': 'API 請求前',
        'User Message Rendered': '使用者訊息渲染後',
        'Character Message Rendered': '角色訊息渲染後',
        'Message Sent': '訊息送出後',
        'Message Received': '訊息接收後',
        'Message Edited': '訊息編輯後',
        'Message Updated': '訊息更新後',
        'Message Deleted': '訊息刪除後',
        'Message Swiped': '訊息切換後',
        'Message Swipe Deleted': '訊息切換刪除後',
        'Up': '上移',
        'Down': '下移',
        'Reset To Detected Order': '重設為偵測到的順序',
        'No extension listeners detected for this hook.': '此 Hook 未偵測到擴充監聽器。',
        'Hook listener list refreshed.': 'Hook 監聽器列表已刷新。',
        'Core event ordering for extension listeners. Reorder plugins per hook.': '用於擴充監聽器的核心事件順序。可按 Hook 重排插件。',
        'Refresh Detected List': '刷新偵測列表',
    });
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizeOrderList(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const item of value) {
        const id = String(item || '').trim();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        result.push(id);
    }
    return result;
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    if (!extension_settings[MODULE_NAME].orderByEvent || typeof extension_settings[MODULE_NAME].orderByEvent !== 'object') {
        extension_settings[MODULE_NAME].orderByEvent = {};
    }
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function getEventName(context, key) {
    return String(context.eventTypes?.[key] || '').trim();
}

function getEventOrderEntry(eventName) {
    const settings = getSettings();
    if (!settings.orderByEvent[eventName] || typeof settings.orderByEvent[eventName] !== 'object') {
        settings.orderByEvent[eventName] = { pluginOrder: [] };
    }
    settings.orderByEvent[eventName].pluginOrder = normalizeOrderList(settings.orderByEvent[eventName].pluginOrder);
    return settings.orderByEvent[eventName];
}

function getDiscoveredPluginsForEvent(context, eventName) {
    const meta = context.eventSource?.getListenersMeta?.(eventName);
    if (!Array.isArray(meta)) {
        return [];
    }
    const discovered = [];
    const seen = new Set();
    for (const item of meta) {
        const pluginId = String(item?.pluginId || '').trim();
        if (!pluginId || seen.has(pluginId)) {
            continue;
        }
        seen.add(pluginId);
        discovered.push(pluginId);
    }
    return discovered;
}

function getStoredPluginOrder(eventName) {
    const settings = getSettings();
    const entry = settings.orderByEvent[eventName];
    if (!entry || typeof entry !== 'object') {
        return [];
    }
    return normalizeOrderList(entry.pluginOrder);
}

function getOrderedPluginList(context, eventName) {
    const ordered = getStoredPluginOrder(eventName);
    const discovered = getDiscoveredPluginsForEvent(context, eventName);

    const finalOrder = [];
    const seen = new Set();
    for (const pluginId of ordered) {
        if (!seen.has(pluginId)) {
            seen.add(pluginId);
            finalOrder.push(pluginId);
        }
    }
    for (const pluginId of discovered) {
        if (!seen.has(pluginId)) {
            seen.add(pluginId);
            finalOrder.push(pluginId);
        }
    }

    return finalOrder;
}

function applyOrderConfig(context) {
    const settings = getSettings();
    const config = {};
    for (const [eventName, value] of Object.entries(settings.orderByEvent)) {
        const pluginOrder = normalizeOrderList(value?.pluginOrder);
        if (pluginOrder.length > 0) {
            config[eventName] = { pluginOrder };
        }
    }

    globalThis.__stEventListenerOrderConfig = config;
    if (typeof context.eventSource?.setOrderConfig === 'function') {
        context.eventSource.setOrderConfig(config);
    }
}

function movePlugin(context, eventName, pluginId, direction) {
    const entry = getEventOrderEntry(eventName);
    let order = normalizeOrderList(entry.pluginOrder);
    if (order.length === 0) {
        order = getOrderedPluginList(context, eventName);
    }
    const index = order.indexOf(pluginId);
    if (index < 0) {
        return false;
    }
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= order.length) {
        return false;
    }
    const [item] = order.splice(index, 1);
    order.splice(target, 0, item);
    entry.pluginOrder = order;
    return true;
}

function resetEventOrder(_context, eventName) {
    const settings = getSettings();
    delete settings.orderByEvent[eventName];
}

function renderEventCard(context, eventDef) {
    const eventName = getEventName(context, eventDef.key);
    if (!eventName) {
        return '';
    }
    const plugins = getOrderedPluginList(context, eventName);
    const rows = plugins.length > 0
        ? plugins.map((pluginId, index) => `
<div class="luker_hook_order_row" data-event-name="${escapeHtml(eventName)}" data-plugin-id="${escapeHtml(pluginId)}">
    <div class="luker_hook_order_plugin">${escapeHtml(pluginId)}</div>
    <div class="luker_hook_order_controls">
        <div class="menu_button" data-luker-action="move-up" ${index === 0 ? 'disabled' : ''}>${escapeHtml(i18n('Up'))}</div>
        <div class="menu_button" data-luker-action="move-down" ${index === plugins.length - 1 ? 'disabled' : ''}>${escapeHtml(i18n('Down'))}</div>
    </div>
</div>`)
            .join('')
        : `<div class="luker_hook_order_empty">${escapeHtml(i18n('No extension listeners detected for this hook.'))}</div>`;

    return `
<div class="luker_hook_order_card" data-event-name="${escapeHtml(eventName)}">
    <div class="luker_hook_order_title">${escapeHtml(i18n(eventDef.label))}</div>
    <small class="luker_hook_order_event">${escapeHtml(eventName)}</small>
    <div class="luker_hook_order_list">${rows}</div>
    <div class="flex-container">
        <div class="menu_button" data-luker-action="reset-event" data-event-name="${escapeHtml(eventName)}">${escapeHtml(i18n('Reset To Detected Order'))}</div>
    </div>
</div>`;
}

function renderUi(root, context) {
    const cards = TARGET_EVENTS.map(eventDef => renderEventCard(context, eventDef)).join('');
    root.find('#luker_hook_order_list').html(cards);
}

function bindUi() {
    const context = getContext();
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    renderUi(root, context);
    root.off('.lukerHookOrder');

    root.on('click.lukerHookOrder', '[data-luker-action]', function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const row = jQuery(this).closest('.luker_hook_order_row');
        const eventName = String(row.data('event-name') || jQuery(this).data('event-name') || '');
        const pluginId = String(row.data('plugin-id') || '');
        if (!eventName) {
            return;
        }

        if (action === 'move-up' || action === 'move-down') {
            const moved = movePlugin(context, eventName, pluginId, action === 'move-up' ? 'up' : 'down');
            if (moved) {
                applyOrderConfig(context);
                saveSettingsDebounced();
                bindUi();
            }
            return;
        }

        if (action === 'reset-event') {
            resetEventOrder(context, eventName);
            applyOrderConfig(context);
            saveSettingsDebounced();
            bindUi();
            return;
        }

        if (action === 'refresh') {
            bindUi();
            notifySuccess(i18n('Hook listener list refreshed.'));
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${STYLE_ID}`).length) {
        jQuery('head').append(`
<style id="${STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${UI_BLOCK_ID} .luker_hook_order_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
}
#${UI_BLOCK_ID} .luker_hook_order_title {
    font-weight: 600;
}
#${UI_BLOCK_ID} .luker_hook_order_event {
    opacity: 0.75;
}
#${UI_BLOCK_ID} .luker_hook_order_row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 6px;
    margin: 6px 0;
}
#${UI_BLOCK_ID} .luker_hook_order_plugin {
    word-break: break-word;
    overflow-wrap: anywhere;
}
#${UI_BLOCK_ID} .luker_hook_order_controls {
    display: flex;
    gap: 6px;
}
#${UI_BLOCK_ID} .luker_hook_order_empty {
    opacity: 0.8;
    padding: 6px 0;
}
</style>`);
    }

    if (!jQuery(`#${UI_BLOCK_ID}`).length) {
        host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Hook Order'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <small style="opacity:0.85">${escapeHtml(i18n('Core event ordering for extension listeners. Reorder plugins per hook.'))}</small>
            <div id="luker_hook_order_list" class="flex-container flexFlowColumn flexNoGap"></div>
            <div class="flex-container">
                <div class="menu_button" data-luker-action="refresh">${escapeHtml(i18n('Refresh Detected List'))}</div>
            </div>
        </div>
    </div>
</div>`);
    }

    bindUi();
}

function migrateAutoDiscoveredOrders() {
    const settings = getSettings();
    if (settings.migratedFromAutoDiscover) {
        return;
    }
    settings.orderByEvent = {};
    settings.migratedFromAutoDiscover = true;
}

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    migrateAutoDiscoveredOrders();
    applyOrderConfig(context);
    saveSettingsDebounced();
    ensureUi();

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        bindUi();
    });
});
