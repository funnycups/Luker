/**
 * CardApp Extension - enables character cards to carry custom frontend UI.
 */

import { eventSource, event_types, getRequestHeaders } from '../../../script.js';
import { getContext, registerExtensionApi, getCharacterState, setCharacterState } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { createContainer, destroyContainer, injectScopedCSS, loadEntryModule, showError } from './loader.js';
import { buildContext } from './context.js';
import { activateRendererBridge, deactivateRendererBridge } from './renderer.js';

const MODULE_NAME = 'card-app';

// Namespace owned by character-editor-assistant Studio. CardApp init errors are
// appended here as a system message so the next Studio session can self-diagnose
// without the user having to read DevTools or paste stack traces.
const STUDIO_SESSION_NAMESPACE = 'cardapp_studio_sessions';

function t(text) {
    return translate(String(text || ''));
}

// Register i18n locale data (core runtime only; Studio i18n lives in the editor plugin)
addLocaleData('zh-cn', {
    'Enable CardApp': '启用 CardApp',
    'Entry file': '入口文件',
});
addLocaleData('zh-tw', {
    'Enable CardApp': '啟用 CardApp',
    'Entry file': '入口檔案',
});

// State
let isCardAppActive = false;
let currentCardApp = null;
let currentCtx = null;

/**
 * Check if the current character has a CardApp enabled.
 * @returns {object|null} The card_app config or null
 */
function getCardAppConfig() {
    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return null;
    const character = context.characters[context.characterId];
    if (!character) return null;
    const cardApp = character?.data?.extensions?.card_app;
    if (!cardApp?.enabled) return null;
    return cardApp;
}

/**
 * Get the character's avatar-based ID (without .png extension).
 * @returns {string|null}
 */
function getCharId() {
    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return null;
    const character = context.characters[context.characterId];
    if (!character?.avatar) return null;
    return character.avatar.replace('.png', '');
}

/**
 * Activate CardApp for the current character.
 */
async function activateCardApp() {
    const config = getCardAppConfig();
    const charId = getCharId();
    if (!config || !charId) return;

    console.log(`[${MODULE_NAME}] Activating CardApp for character: ${charId}`);

    // 1. Create container and hide default chat UI
    const container = createContainer();

    // 2. Load and inject scoped CSS (if any CSS files exist)
    try {
        const cssFiles = await findCSSFiles(charId, config);
        for (const cssContent of cssFiles) {
            injectScopedCSS(cssContent);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to load CSS:`, err);
    }

    // 3. Build context object
    const ctx = buildContext(container, charId, config);
    currentCtx = ctx;

    // 4. Load entry JS module and call init(ctx)
    const entry = config.entry || 'index.js';
    try {
        const module = await loadEntryModule(charId, entry);

        if (typeof module.init !== 'function') {
            throw new Error(`CardApp entry module does not export an init() function`);
        }

        await module.init(ctx);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to initialize CardApp:`, err);
        showError(container, err, () => deactivateCardApp());
        // Record the error so the next CardApp Studio session can read it as a
        // diagnostic system message and self-correct without the user having to
        // copy stack traces out of DevTools.
        try {
            await recordCardAppInitErrorForStudio(charId, entry, err);
        } catch (recordErr) {
            console.warn(`[${MODULE_NAME}] Failed to record CardApp init error for Studio:`, recordErr);
        }
        // Still mark as active so deactivate can clean up
    }

    // 5. Activate renderer bridge to push messages to CardApp
    activateRendererBridge(ctx);

    isCardAppActive = true;
    currentCardApp = { charId, config };
}

/**
 * Append a diagnostic system message to the latest CardApp Studio session for
 * this character so the next Studio AI run sees the failure and can fix it
 * without the user having to inspect DevTools.
 *
 * @param {string} charId
 * @param {string} entry Entry filename that failed (e.g. 'index.js')
 * @param {Error} err
 */
async function recordCardAppInitErrorForStudio(charId, entry, err) {
    const context = getContext();
    const character = context?.characters?.[context.characterId];
    const avatar = String(character?.avatar || '').trim();
    if (!avatar) return;

    const errorName = String(err?.name || 'Error');
    const errorMessage = String(err?.message || err || 'Unknown error');
    const stack = String(err?.stack || '').slice(0, 4000);
    const timestamp = new Date().toISOString();

    const content = [
        `CardApp init failed at ${timestamp}.`,
        `Entry: ${entry}`,
        `Error: ${errorName}: ${errorMessage}`,
        '',
        'Stack:',
        stack,
        '',
        'This is an automatic diagnostic from the CardApp loader. The CardApp on disk does not run as written. Please read the failing file, identify the cause from the stack above, and patch the file so init() completes without throwing.',
    ].join('\n');

    const diagnosticMessage = {
        role: 'system',
        content,
    };

    const data = await getCharacterState(avatar, STUDIO_SESSION_NAMESPACE);
    let sessions = [];
    let nextData = data;

    if (data && Array.isArray(data.sessions)) {
        sessions = data.sessions;
    } else if (data && Array.isArray(data.messages)) {
        // Migrate legacy single-session format inline so we don't lose history.
        sessions = [{
            id: `migrated_${Date.now()}`,
            messages: data.messages,
            updatedAt: data.updatedAt || Date.now(),
            summary: 'Migrated session',
        }];
    }

    if (sessions.length === 0) {
        sessions.push({
            id: `cardapp_error_${Date.now()}`,
            messages: [diagnosticMessage],
            updatedAt: Date.now(),
            summary: 'CardApp init error',
        });
    } else {
        const latest = sessions[sessions.length - 1];
        if (!Array.isArray(latest.messages)) latest.messages = [];
        latest.messages.push(diagnosticMessage);
        latest.updatedAt = Date.now();
    }

    nextData = { version: 1, sessions };
    await setCharacterState(avatar, STUDIO_SESSION_NAMESPACE, nextData);
}

/**
 * Find and fetch CSS files for a CardApp.
 * @param {string} charId
 * @param {object} config
 * @returns {Promise<string[]>} Array of CSS content strings
 */
async function findCSSFiles(charId, config) {
    const cssFiles = [];

    // Check for style.css by convention
    try {
        const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/style.css`, {
            headers: getRequestHeaders(),
        });
        if (response.ok) {
            cssFiles.push(await response.text());
        }
    } catch {
        // No style.css, that's fine
    }

    return cssFiles;
}

/**
 * Deactivate the current CardApp.
 */
async function deactivateCardApp() {
    if (!isCardAppActive) return;

    console.log(`[${MODULE_NAME}] Deactivating CardApp`);

    // Deactivate renderer bridge
    deactivateRendererBridge();

    // Dispose context (cleans up intervals, timeouts, event listeners, user callbacks)
    if (currentCtx) {
        try {
            currentCtx._dispose();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Context dispose error:`, err);
        }
        currentCtx = null;
    }

    // Remove container and restore default UI
    destroyContainer();

    isCardAppActive = false;
    currentCardApp = null;
}

/**
 * Handle chat changed event - check if we need to activate/deactivate CardApp.
 */
async function onChatChanged() {
    // Always deactivate first
    await deactivateCardApp();

    // Check if new character has CardApp
    const config = getCardAppConfig();
    if (config) {
        await activateCardApp();
    }
}

/**
 * Hot-reload the CardApp (deactivate then reactivate).
 * Used by CardApp Studio after file modifications.
 */
export async function reloadCardApp() {
    await deactivateCardApp();
    const config = getCardAppConfig();
    if (config) {
        await activateCardApp();
    }
}

/**
 * Check if a CardApp is currently active.
 * @returns {boolean}
 */
export function isActive() {
    return isCardAppActive;
}

// Register event listeners
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

// Expose public API for plugins (e.g. character-editor-assistant's CardApp Studio)
registerExtensionApi('card-app', {
    reloadCardApp,
    isActive,
    getCardAppConfig,
    getCharId,
});

console.log(`[${MODULE_NAME}] Extension loaded`);
