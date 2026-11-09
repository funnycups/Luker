// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Data source backed by Luker's orchestrator extension.
//
// Settings live in `extension_settings.orchestrator`; a character card may
// carry its own preset library under `data.extensions.orchestrator`. We
// resolve the effective profile the same way the orchestrator does
// (card preset > global preset > factory default), but without its lazy
// migrations / default seeding, so opening the lens never writes anything.
//
// The live run comes from the orchestrator's run-panel store, the instance
// the runtimes write to.

import { i18n, i18nFormat } from './i18n.js';
import runStore from '../run-state/store.js';
import { getPreset } from '../preset-library.js';
import { createFactoryPresetForMode } from '../defaults.js';
import { getLoadedAnchorMap } from '../snapshot-cache.js';
import { invalidateSkillInventory } from '../skill-resolution.js';
import { createProfileAccess, createAiAccess } from './source-write.js';

const MODES = ['spec', 'single', 'agenda', 'loop', 'director'];
const CHAT_EVENTS = ['CHAT_CHANGED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED'];
const CONFIG_EVENTS = ['SETTINGS_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_REPLACED', 'CHARACTER_FIELDS_UPDATED'];
const MESSAGE_EVENTS = ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED'];
const RESULT_EVENT = 'luker.orchestrator.result';

export class SourceError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const getContext = () => Luker.getContext();

function settingsOf(ctx) {
    const settings = ctx.extensionSettings?.orchestrator;
    if (!settings || typeof settings !== 'object') throw new SourceError('no-extension');
    return settings;
}

const normalizeMode = (value) => (MODES.includes(String(value)) ? String(value) : 'spec');

function currentCharacter(ctx) {
    if (ctx.groupId) return null;
    return ctx.characters?.[ctx.characterId] || null;
}

function chatKeyOf(ctx) {
    if (ctx.groupId) return `group:${ctx.groupId}`;
    const avatar = String(currentCharacter(ctx)?.avatar || '').trim();
    const chatId = String(ctx.chatId || ctx.getCurrentChatId?.() || '').trim();
    return avatar && chatId ? `char:${avatar}:${chatId}` : '';
}

function chatLabelOf(ctx) {
    try {
        if (ctx.groupId) return (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId))?.name || '';
        return ctx.name2 || currentCharacter(ctx)?.name || '';
    } catch {
        return '';
    }
}

/** Translates the "Default" and "Default (...)" names of shipped presets. */
export function presetDisplayName(name) {
    const value = String(name || '').trim();
    const match = /^Default\b\s*(.*)$/i.exec(value);
    if (!match) return value;
    const rest = match[1];
    if (!rest) return i18n('Default profile');
    const inner = /^\((.*)\)$/.exec(rest);
    return inner ? i18nFormat('Default profile (${0})', inner[1]) : i18nFormat('Default profile ${0}', rest);
}

function resolveProfile(ctx, settings) {
    const mode = normalizeMode(settings.executionMode);
    const character = currentCharacter(ctx);
    if (mode === 'single') {
        return {
            mode,
            source: 'global',
            presetId: '',
            presetName: '',
            profile: {
                spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
                presets: { single_agent: { systemPrompt: settings.singleAgentSystemPrompt, userPromptTemplate: settings.singleAgentUserPromptTemplate } },
            },
        };
    }

    if (mode === 'agenda') {
        const override = settings.chatOverrides?.[chatKeyOf(ctx)]?.agenda;
        if (override?.enabled) return { mode, source: 'chat', presetId: '', presetName: '', profile: override };
    }

    const sanitize = (scope, id, raw) => {
        try {
            const clean = getPreset(settings, mode, scope, id, { context: ctx, avatar: character?.avatar });
            if (clean) return clean;
        } catch { /* fall back to the stored copy */ }
        return raw;
    };

    const ext = character?.data?.extensions?.orchestrator;
    const cardId = String(ext?.activePresetIds?.[mode] || '');
    const cardRaw = cardId ? ext?.presetLibraries?.[mode]?.[cardId] : null;
    if (cardRaw) {
        return { mode, source: 'character', presetId: cardId, presetName: presetDisplayName(cardRaw.name), profile: sanitize('character', cardId, cardRaw) };
    }

    const library = settings.presetLibraries?.[mode] || {};
    let id = String(settings.activePresetIds?.[mode] || '');
    if (!library[id]) id = Object.keys(library)[0] || '';
    if (id && library[id]) {
        return { mode, source: 'global', presetId: id, presetName: presetDisplayName(library[id].name), profile: sanitize('global', id, library[id]) };
    }

    let factory = createFactoryPresetForMode(mode) || null;
    if (Array.isArray(factory)) factory = factory[0];
    // Nothing stored yet: editing needs the orchestrator to seed a preset first.
    return { mode, source: 'factory', presetId: '', presetName: presetDisplayName(factory?.name || 'Default'), profile: factory || {} };
}

/** Message index (mesid) of the last user message — the floor a run belongs to. */
function lastUserFloor(ctx) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.is_user && !chat[i]?.is_system) return i;
    }
    return -1;
}

/** playableFloor (1-based among non-system messages) → mesid. */
function playableToIndex(ctx, playable) {
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    let seq = 0;
    for (let i = 0; i < chat.length; i++) {
        if (!chat[i] || chat[i].is_system) continue;
        seq += 1;
        if (seq === playable) return i;
    }
    return -1;
}

function readAnchors(ctx) {
    try {
        const map = getLoadedAnchorMap(ctx) || {};
        return Object.entries(map)
            .map(([key, entry]) => ({ floor: playableToIndex(ctx, Number(key)), capsuleText: String(entry?.capsuleText || ''), stageOutputs: Array.isArray(entry?.stageOutputs) ? entry.stageOutputs : [] }))
            .filter(item => item.floor >= 0 && item.capsuleText)
            .sort((a, b) => b.floor - a.floor);
    } catch {
        return [];
    }
}

export function createLukerSource() {
    let lastPresetName = '';
    const host = () => {
        const ctx = getContext();
        return { ctx, settings: settingsOf(ctx) };
    };
    return {
        kind: 'luker',
        edit: createProfileAccess(host),
        ai: createAiAccess(host),
        locale() {
            return getContext().getCurrentLocale() || navigator.language;
        },

        async load() {
            const ctx = getContext();
            const settings = settingsOf(ctx);
            const resolved = resolveProfile(ctx, settings);
            lastPresetName = resolved.presetName;
            const character = currentCharacter(ctx);
            return {
                chatKey: chatKeyOf(ctx),
                chatId: String(ctx.chatId || ''),
                chatLabel: chatLabelOf(ctx),
                characterName: String(character?.name || ''),
                enabled: Boolean(settings.enabled),
                mode: resolved.mode,
                source: resolved.source === 'factory' ? 'global' : resolved.source,
                target: { mode: resolved.mode, scope: resolved.source, presetId: resolved.presetId, avatar: String(character?.avatar || ''), chatKey: chatKeyOf(ctx) },
                presetName: resolved.presetName,
                profile: resolved.profile,
                cardPinnedMode: character?.data?.extensions?.orchestrator?.override?.mode || '',
                settings: { reviewRerunMaxRounds: settings.reviewRerunMaxRounds },
                anchors: readAnchors(ctx),
            };
        },

        runStore() {
            return runStore;
        },

        /** Captured when a run starts, so history entries know their chat. */
        runContext(from = 'orchestrator') {
            const ctx = getContext();
            return { chatId: String(ctx.chatId || ''), chatLabel: chatLabelOf(ctx), floor: lastUserFloor(ctx), presetName: from === 'orchestrator' ? lastPresetName : '' };
        },

        subscribe(onChange) {
            const offs = [];
            try {
                const ctx = getContext();
                const events = ctx.eventSource;
                const types = ctx.eventTypes;
                const on = (name, kind) => {
                    if (!name) return;
                    const handler = () => onChange(kind);
                    events.on(name, handler);
                    offs.push(() => events.removeListener(name, handler));
                };
                for (const key of CHAT_EVENTS) on(types[key], 'chat');
                for (const key of CONFIG_EVENTS) on(types[key], 'config');
                for (const key of MESSAGE_EVENTS) on(types[key], 'message');
                on(RESULT_EVENT, 'result');
            } catch { /* host gone: nothing to unsubscribe */ }
            return () => offs.forEach(off => { try { off(); } catch { /* ignore */ } });
        },

        // The native panel keeps its own copy of these fields in the DOM;
        // drive its controls when present so both stay in step (its handlers
        // also refresh dependent panels). Otherwise write settings directly.
        async setEnabled(value) {
            const ctx = getContext();
            const settings = settingsOf(ctx);
            const box = $('#luker_orch_enabled');
            if (box.length) {
                box.prop('checked', Boolean(value)).trigger('input');
                return;
            }
            settings.enabled = Boolean(value);
            ctx.saveSettingsDebounced();
        },

        async setMode(mode) {
            const next = normalizeMode(mode);
            const ctx = getContext();
            const settings = settingsOf(ctx);
            const select = $('#luker_orch_execution_mode');
            if (select.length) {
                select.val(next).trigger('change');
                return;
            }
            settings.executionMode = next;
            settings.singleAgentModeEnabled = next === 'single';
            invalidateSkillInventory();
            ctx.saveSettingsDebounced();
        },

        openNative() {
            const block = document.getElementById('orchestrator_settings');
            if (!block) return false;
            const drawer = document.getElementById('rm_extensions_block');
            if (drawer?.classList.contains('closedDrawer')) {
                document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
            }
            const content = block.querySelector('.inline-drawer-content');
            if (content && getComputedStyle(content).display === 'none') block.querySelector('.inline-drawer-toggle')?.click();
            setTimeout(() => block.scrollIntoView({ block: 'start', behavior: 'smooth' }), 120);
            return true;
        },
    };
}
