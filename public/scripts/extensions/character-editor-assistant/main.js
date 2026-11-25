// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { createCharacterEditorUi } from './editor-ui.js';
import { ensureSimulationReviewLocaleData } from '../../iteration-library/simulation-review/i18n/index.js';
import { escapeHtml } from '../../lib/html-escape.js';
import { i18n } from './i18n.js';
import { defaultSettings, ensureSettings, getSettings, refreshPresetSelectors } from './settings.js';
import { buildPostReplaceMergeAction as buildMergeActionWithDeps, registerPostReplaceMergeAction } from './post-replace/merge-action.js';

const __ctx = Luker.getContext();
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const getContext = Luker.getContext;

const UI_BLOCK_ID = 'character_editor_assistant_settings';
const STYLE_ID = 'character_editor_assistant_style';

function notifyWarning(message) {
    if (typeof toastr !== 'undefined') {
        toastr.warning(String(message || ''));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message || ''));
    }
}

export async function openCharacterEditorPopup(context = getContext(), opts = {}) {
    const character = context?.characters?.[context?.characterId] || null;
    const avatarFromCtx = String(character?.avatar || '').trim();
    const avatar = String(opts?.avatar || avatarFromCtx).trim();
    if (!avatar) {
        notifyWarning(i18n('No character selected or character has no avatar.'));
        return null;
    }
    const wb = context?.workbench || getContext()?.workbench;
    if (typeof wb?.open !== 'function') {
        notifyError(i18n('Workbench is unavailable.'));
        return null;
    }
    const openOpts = { page: 'ai', ws: 'card', scope: 'character', scopeOwner: { scope: 'character', avatar } };
    if (typeof opts?.seedSystemMessage === 'string' && opts.seedSystemMessage.trim()) {
        openOpts.seedPrompt = opts.seedSystemMessage;
    }
    if (opts?.hideSeedFromUi !== undefined) {
        openOpts.hideSeedFromUi = Boolean(opts.hideSeedFromUi);
    }
    if (opts?.autoSend !== undefined) {
        openOpts.autoSend = Boolean(opts.autoSend);
    }
    if (typeof opts?.postReplaceRollback === 'function') {
        openOpts.onCancelWithoutApply = opts.postReplaceRollback;
        openOpts.waitForClose = true;
    }
    if (opts.replaceContext) {
        openOpts.iterationContext = opts.replaceContext;
    }
    const res = await wb.open(openOpts);
    return res === null || res === false ? null : (res ?? { opened: true });
}

export function buildPostReplaceMergeAction() {
    return buildMergeActionWithDeps({ openCharacterEditorPopup });
}

const {
    ensureUi,
    refreshUiState,
} = createCharacterEditorUi({
    STYLE_ID,
    UI_BLOCK_ID,
    defaultSettings,
    escapeHtml,
    getContext,
    getSettings,
    i18n,
    openCharacterEditorPopup,
    refreshPresetSelectors,
    saveSettingsDebounced,
});

jQuery(async () => {
    ensureSimulationReviewLocaleData();
    ensureSettings();
    registerPostReplaceMergeAction(getContext(), { openCharacterEditorPopup });
    ensureUi();
    await refreshUiState();

    const eventSource = getContext().eventSource;
    const eventTypes = getContext().eventTypes;

    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, async () => {
        await refreshUiState();
    });

    eventSource.on(eventTypes.SETTINGS_UPDATED, async () => {
        await refreshUiState();
    });
});
