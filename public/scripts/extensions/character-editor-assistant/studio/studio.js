/**
 * CardApp Studio - AI-powered vibe coding editor for CardApp development.
 *
 * Layout: Left panel (AI chat) | Center (real chat/CardApp) | Right panel (code editor)
 */

const __ctx = Luker.getContext();
const getRequestHeaders = __ctx.getRequestHeaders;
const saveSettingsDebounced = __ctx.saveSettingsDebounced;
const translate = __ctx.translate;
const DOMPurify = __ctx.lib.DOMPurify;
const DiffMatchPatch = __ctx.lib.DiffMatchPatch;
const showdown = __ctx.lib.showdown;
const extension_settings = __ctx.extensionSettings;
const getContext = Luker.getContext;
const getExtensionApi = __ctx.getExtensionApi;
const getCharacterState = __ctx.getCharacterState;
const updateCharacterState = __ctx.updateCharacterState;
const deleteCharacterState = __ctx.deleteCharacterState;
import { sendAIMessage, TOOL_NAMES } from './ai-chat.js';

// Markdown converter for AI messages
const mdConverter = new showdown.Converter({
    tables: true,
    strikethrough: true,
    ghCodeBlocks: true,
    tasklists: true,
    simpleLineBreaks: true,
    openLinksInNewWindow: true,
});

const MODULE_NAME = 'card-app/studio';

/** Reload CardApp via the core extension API. */
async function reloadCardApp() {
    const api = getExtensionApi('card-app');
    if (api?.reloadCardApp) await api.reloadCardApp();
}

function t(text) {
    return translate(String(text || ''));
}

function tFormat(text, ...values) {
    return t(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

/**
 * Map a state-error envelope reason to a localized toastr message describing
 * why a CardApp Studio session-write failed. Covers all 9 closed-enum reasons
 * from `state-errors.js` (VALIDATION_ARGS, VALIDATION_TARGET, VALIDATION_COMMIT,
 * INSTANCE_DESTROYED, CONFLICT, HTTP_ERROR, TRANSPORT_ERROR, REPLAY_BROKEN,
 * LOG_WRITE_FAILED). Unknown reason falls back to a generic message.
 *
 * Used only by `saveAllSessions` non-silent paths (user-initiated saves like
 * New session / Delete session / Clear chat). Autosave keeps the toast quiet
 * via `{silent: true}` because it fires on every AI turn — the warning still
 * goes to console for dev visibility.
 *
 * @param {string} reason — envelope reason
 * @param {string} [_hint] — envelope hint (reserved for future log enrichment)
 * @returns {string} Localized toast message
 */
function formatSaveSessionsError(reason, _hint) {
    switch (reason) {
        case 'VALIDATION_ARGS':
            return t('Failed to save CardApp Studio session (invalid request).');
        case 'VALIDATION_TARGET':
            return t('Failed to save CardApp Studio session (no active character).');
        case 'VALIDATION_COMMIT':
            return t('Failed to save CardApp Studio session (invalid commit).');
        case 'INSTANCE_DESTROYED':
            return t('CardApp Studio storage destroyed, reload the page.');
        case 'CONFLICT':
            return t('Failed to save CardApp Studio session (storage conflict, try again).');
        case 'HTTP_ERROR':
            return t('Failed to save CardApp Studio session (server error).');
        case 'TRANSPORT_ERROR':
            return t('Failed to save CardApp Studio session (network error).');
        case 'REPLAY_BROKEN':
            return t('Failed to save CardApp Studio session (storage corrupted, reload chat).');
        case 'LOG_WRITE_FAILED':
            return t('Failed to save CardApp Studio session (disk write failed).');
        default:
            return t('Failed to save CardApp Studio session.');
    }
}
const STUDIO_PANEL_LEFT_ID = 'card-app-studio-left';
const STUDIO_PANEL_RIGHT_ID = 'card-app-studio-right';
const STUDIO_MOBILE_TABS_ID = 'card-app-studio-mobile-tabs';

function isAutoApplyEnabled() {
    return Boolean(extension_settings?.character_editor_assistant?.autoApprove);
}

function setAutoApplyEnabled(enabled) {
    if (!extension_settings.character_editor_assistant || typeof extension_settings.character_editor_assistant !== 'object') {
        extension_settings.character_editor_assistant = {};
    }
    extension_settings.character_editor_assistant.autoApprove = Boolean(enabled);
    saveSettingsDebounced();
}

let isStudioOpen = false;
let currentCharId = null;
let currentAvatar = null;
let currentFile = null;
let fileList = [];

// CodeMirror 6 state
let cmEditor = null;
let cmModules = null;
let cmLanguageCompartment = null;

// AI chat state
let conversationMessages = [];
let isSending = false;
let activeAbortController = null;
let currentSessionId = null;

// Mobile tab state — purely UI; CSS @media handles whether the tab bar is shown.
let mobileActiveTab = 'left';

const SESSION_NAMESPACE = 'cardapp_studio_sessions';
const MAX_PERSISTED_MESSAGES = 100;
const MAX_SESSIONS = 20;
const SESSION_VERSION = 1;

// ==================== Session Persistence (Character Sidecar) ====================

/**
 * Get the current character's avatar string for sidecar storage.
 * @returns {string} The avatar URL (e.g. 'xxx.png')
 */
function getCurrentAvatar() {
    if (currentAvatar) return currentAvatar;
    const context = getContext();
    const character = context.characters?.[context.characterId];
    return String(character?.avatar || '').trim();
}

/**
 * Load all sessions from sidecar, migrate old format if needed.
 * @returns {Promise<Array>} Array of session objects
 */
async function loadAllSessions() {
    const avatar = getCurrentAvatar();
    if (!avatar) return [];
    try {
        // Envelope: `{ok, state}` on hit/empty-miss; `{ok: false, reason,
        // hint}` on transport/HTTP/validation failure. Read failures fall
        // back to `[]` so the studio still opens — autosave will recreate
        // the sidecar on the next AI turn.
        const result = await getCharacterState(avatar, SESSION_NAMESPACE);
        if (!result?.ok) {
            if (result?.reason) {
                console.warn(`[${MODULE_NAME}] loadAllSessions read failed: ${result.reason} ${result.hint || ''}`);
            }
            return [];
        }
        const data = result.state;
        if (!data) return [];

        // Migrate old single-session format to new multi-session format
        if (Array.isArray(data.messages)) {
            // Old format: { messages, updatedAt }
            const migrated = {
                version: SESSION_VERSION,
                sessions: [
                    {
                        id: generateSessionId(),
                        messages: data.messages.slice(-MAX_PERSISTED_MESSAGES),
                        updatedAt: data.updatedAt || Date.now(),
                        summary: 'Migrated session',
                    },
                ],
            };
            const migrateResult = await updateCharacterState(avatar, SESSION_NAMESPACE, () => migrated);
            if (!migrateResult?.ok) {
                // Migration write failure is non-fatal — return the in-memory
                // migrated payload so the user sees their old session this
                // run, and let the next save retry persistence.
                console.warn(`[${MODULE_NAME}] loadAllSessions migrate-write failed: ${migrateResult?.reason} ${migrateResult?.hint || ''}`);
            }
            return migrated.sessions;
        }

        // New format: { version, sessions }
        if (data.version === SESSION_VERSION && Array.isArray(data.sessions)) {
            return data.sessions;
        }

        return [];
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to load sessions from sidecar:`, err);
        return [];
    }
}

/**
 * Save all sessions to sidecar.
 *
 * `saveAllSessions` is the studio's hot persistence path — autosave invokes it
 * on every AI turn. The `silent` option keeps autosave from spamming toasts on
 * a single transient failure; user-initiated saves (new session / delete /
 * clear chat) pass `silent: false` so the user knows their click did not land.
 * In both cases the warning still goes to console so devs can chase persistence
 * issues without the UI swallowing them.
 *
 * @param {Array} sessions
 * @param {{silent?: boolean}} [options] — `silent: true` suppresses toastr but
 *   still logs to console. Defaults to `false` (toast on failure).
 */
async function saveAllSessions(sessions, { silent = false } = {}) {
    const avatar = getCurrentAvatar();
    if (!avatar) return;
    try {
        const data = {
            version: SESSION_VERSION,
            sessions: sessions.slice(-MAX_SESSIONS).map(s => ({
                ...s,
                messages: s.messages.slice(-MAX_PERSISTED_MESSAGES),
            })),
        };
        const result = await updateCharacterState(avatar, SESSION_NAMESPACE, () => data);
        if (!result?.ok) {
            console.warn(`[${MODULE_NAME}] saveAllSessions failed: ${result?.reason} ${result?.hint || ''}`);
            if (!silent && typeof toastr !== 'undefined') {
                toastr.error(formatSaveSessionsError(result?.reason, result?.hint));
            }
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to save sessions to sidecar:`, err);
        if (!silent && typeof toastr !== 'undefined') {
            toastr.error(formatSaveSessionsError(undefined));
        }
    }
}

/**
 * Load a specific session by ID.
 * @param {string} sessionId
 * @returns {Promise<Array>} Messages array
 */
async function loadSession(sessionId) {
    const sessions = await loadAllSessions();
    const session = sessions.find(s => s.id === sessionId);
    return session ? session.messages : [];
}

/**
 * Save the current session.
 * @param {string} sessionId
 * @param {Array} messages
 * @param {string} [summary]
 * @param {{silent?: boolean}} [options] — forwarded to saveAllSessions.
 *   Autosave on AI turn completion passes `silent: true`; user-initiated
 *   saves leave it false so failures surface as toasts.
 */
async function saveCurrentSession(sessionId, messages, summary = null, { silent = false } = {}) {
    const sessions = await loadAllSessions();
    const existingIndex = sessions.findIndex(s => s.id === sessionId);

    const sessionData = {
        id: sessionId,
        messages: messages.slice(-MAX_PERSISTED_MESSAGES),
        updatedAt: Date.now(),
        summary: summary || (existingIndex >= 0 ? sessions[existingIndex].summary : 'New session'),
    };

    if (existingIndex >= 0) {
        sessions[existingIndex] = sessionData;
    } else {
        sessions.push(sessionData);
    }

    await saveAllSessions(sessions, { silent });
}

/**
 * Delete a session by ID.
 * @param {string} sessionId
 */
async function deleteSession(sessionId) {
    const sessions = await loadAllSessions();
    const filtered = sessions.filter(s => s.id !== sessionId);
    await saveAllSessions(filtered);
}

/**
 * Generate a session summary from the first user message.
 * @param {Array} messages
 * @returns {string}
 */
function generateSessionSummary(messages) {
    const firstUserMsg = messages.find(m => m.role === 'user');
    if (!firstUserMsg || !firstUserMsg.content) return 'New session';
    const text = String(firstUserMsg.content).trim();
    return text.length > 50 ? text.substring(0, 47) + '...' : text;
}

/**
 * Generate a unique session ID.
 * @returns {string}
 */
function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

async function clearSession() {
    const avatar = getCurrentAvatar();
    if (!avatar) return;
    try {
        const result = await deleteCharacterState(avatar, SESSION_NAMESPACE);
        if (!result?.ok) {
            console.warn(`[${MODULE_NAME}] clearSession failed: ${result?.reason} ${result?.hint || ''}`);
            if (typeof toastr !== 'undefined') {
                toastr.error(formatSaveSessionsError(result?.reason, result?.hint));
            }
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to clear session from sidecar:`, err);
    }
}

// ==================== File API ====================

async function fetchFileList(charId) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/files`, {
 headers: getRequestHeaders(),
 cache: 'no-cache',
 });
 if (!response.ok) throw new Error(`Failed to list files: ${response.status}`);
 const data = await response.json();
 return data.files || [];
}

async function fetchFileContent(charId, filePath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 headers: getRequestHeaders(),
 cache: 'no-cache',
 });
 if (!response.ok) throw new Error(`Failed to read file: ${response.status}`);
 return await response.text();
}

async function saveFileContent(charId, filePath, content) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 method: 'PUT',
 headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
 body: JSON.stringify({ content }),
 });
 if (!response.ok) throw new Error(`Failed to save file: ${response.status}`);
 return await response.json();
}

async function deleteFile(charId, filePath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/${encodeURIComponent(filePath)}`, {
 method: 'DELETE',
 headers: getRequestHeaders(),
 });
 if (!response.ok) throw new Error(`Failed to delete file: ${response.status}`);
 return await response.json();
}

async function renameFile(charId, fromPath, toPath) {
 const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/rename`, {
 method: 'POST',
 headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
 body: JSON.stringify({ from: fromPath, to: toPath }),
 });
 if (!response.ok) throw new Error(`Failed to rename file: ${response.status}`);
 return await response.json();
}

// ==================== Skeleton Init ====================

async function ensureSkeletonFiles(charId) {
 const files = await fetchFileList(charId);
 if (files.length === 0) {
 await saveFileContent(charId, 'index.js', `/**\n * CardApp entry point.\n * @param {object} ctx - The CardApp context object\n */\nexport function init(ctx) {\n ctx.container.innerHTML = '<div style="padding:20px;">Hello from CardApp!</div>';\n}\n`);
 await saveFileContent(charId, 'style.css', '/* CardApp styles */\n');
 console.log(`[${MODULE_NAME}] Created skeleton files for ${charId}`);
 }
}

// ==================== CodeMirror 6 ====================

/**
 * Lazily load the CodeMirror 6 bundle.
 * @returns {Promise<object>} The CM6 module exports
 */
async function loadCM6() {
    if (cmModules) return cmModules;
    cmModules = await import('/codemirror.bundle.js');
    return cmModules;
}

/**
 * Get the CM6 language extension for a file path.
 * @param {string} filePath
 * @returns {object} CM6 language extension
 */
function getLanguageForFile(filePath) {
    if (!cmModules) return [];
    const ext = (filePath || '').split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'js': case 'mjs': case 'jsx': case 'ts': case 'tsx':
            return cmModules.javascript({ jsx: ext === 'jsx' || ext === 'tsx', typescript: ext === 'ts' || ext === 'tsx' });
        case 'css':
            return cmModules.css();
        case 'html': case 'htm': case 'svg':
            return cmModules.html();
        case 'json':
            return cmModules.json();
        case 'md': case 'markdown':
            return cmModules.markdown();
        default:
            return [];
    }
}

/**
 * Create a completion source for CardApp ctx API.
 * @param {object} cm - CM6 modules
 * @returns {function} Completion source function
 */
function createCtxCompletionSource(cm) {
    const ctxCompletions = [
        { label: 'ctx.sendMessage', type: 'method', info: 'Send a message (triggers AI response)', detail: '(text: string, options?: object) => void' },
        { label: 'ctx.executeSlashCommand', type: 'method', info: 'Execute a slash command', detail: '(command: string) => void' },
        { label: 'ctx.getHistory', type: 'method', info: 'Get chat history array', detail: '(limit?: number, offset?: number) => Array' },
        { label: 'ctx.getCharacterData', type: 'method', info: 'Get character data object', detail: '() => object' },
        { label: 'ctx.getVariable', type: 'method', info: 'Get a chat variable', detail: '(name: string) => any' },
        { label: 'ctx.setVariable', type: 'method', info: 'Set a chat variable (persisted)', detail: '(name: string, value: any) => void' },
        { label: 'ctx.stopGeneration', type: 'method', info: 'Stop current message generation', detail: '() => void' },
        { label: 'ctx.continueGeneration', type: 'method', info: 'Continue generating current message', detail: '() => void' },
        { label: 'ctx.swipe', type: 'method', info: 'Swipe to get alternative response', detail: '() => void' },
        { label: 'ctx.regenerate', type: 'method', info: 'Regenerate last AI message', detail: '() => void' },
        { label: 'ctx.setInterval', type: 'method', info: 'Auto-cleanup interval (safer than window.setInterval)', detail: '(fn: function, ms: number) => number' },
        { label: 'ctx.setTimeout', type: 'method', info: 'Auto-cleanup timeout (safer than window.setTimeout)', detail: '(fn: function, ms: number) => number' },
        { label: 'ctx.addEventListener', type: 'method', info: 'Auto-cleanup event listener', detail: '(target: EventTarget, event: string, handler: function, options?: object) => void' },
        { label: 'ctx.onDispose', type: 'method', info: 'Register cleanup callback when CardApp unmounts', detail: '(callback: function) => void' },
        { label: 'ctx.getChatList', type: 'method', info: 'List all chats for this character', detail: '() => Array' },
        { label: 'ctx.switchChat', type: 'method', info: 'Switch to a different chat', detail: '(id: string) => void' },
        { label: 'ctx.newChat', type: 'method', info: 'Create and switch to a new chat', detail: '() => void' },
        { label: 'ctx.closeChat', type: 'method', info: 'Close current chat', detail: '() => void' },
        { label: 'ctx.renderText', type: 'method', info: 'Render markdown/formatting to HTML', detail: '(text: string) => string' },
        { label: 'ctx.editMessage', type: 'method', info: 'Edit a message by ID', detail: '(id: number, text: string) => void' },
        { label: 'ctx.deleteMessage', type: 'method', info: 'Delete a message by ID', detail: '(id: number) => void' },
        { label: 'ctx.deleteLastMessage', type: 'method', info: 'Delete the last message', detail: '() => void' },
        { label: 'ctx.container', type: 'property', info: 'The CardApp container DOM element', detail: 'HTMLElement' },
        { label: 'ctx.charId', type: 'property', info: 'Current character ID', detail: 'string' },
        { label: 'ctx.eventSource', type: 'property', info: 'Luker event bus', detail: 'EventEmitter' },
        { label: 'ctx.lukerContext', type: 'property', info: 'Escape hatch: full Luker extension API (200+ properties). Use when ctx doesn\'t expose what you need.', detail: 'SillyTavernContext' },
        { label: 'ctx.registerRenderer', type: 'method', info: 'Register custom message renderer', detail: '({ renderMessage, removeMessage }) => void' },
        { label: 'ctx.getChatState', type: 'method', info: 'async — Read chat-bound sidecar namespace. Returns { ok, state } envelope.', detail: '(namespace: string, options?: object) => Promise<{ok: true, state: object|null} | {ok: false, state: null, reason: string, hint: string}>' },
        { label: 'ctx.updateChatState', type: 'method', info: 'async — Reducer-style write of chat-bound sidecar. Returns { ok, state, updated } envelope.', detail: '(namespace: string, updater: (current: object) => object|null, options?: object) => Promise<{ok: true, state: object|null, updated: boolean} | {ok: false, reason: string, hint: string}>' },
        { label: 'ctx.patchChatState', type: 'method', info: 'async — Apply JSON-patch ops to chat-bound sidecar. Returns { ok } envelope.', detail: '(namespace: string, operations: object[], options?: object) => Promise<{ok: true} | {ok: false, reason: string, hint: string}>' },
        { label: 'ctx.deleteChatState', type: 'method', info: 'async — Drop a chat-bound sidecar namespace. Returns { ok } envelope.', detail: '(namespace: string, options?: object) => Promise<{ok: true} | {ok: false, reason: string, hint: string}>' },
        { label: 'ctx.getCharacterState', type: 'method', info: 'async — Read character-bound sidecar (avatar auto-resolved). Returns { ok, state } envelope.', detail: '(namespace: string) => Promise<{ok: true, state: any} | {ok: false, state: null, reason: string, hint: string}>' },
        { label: 'ctx.updateCharacterState', type: 'method', info: 'async — Reducer-style write of character-bound sidecar. Returns { ok, state, updated, created? } envelope.', detail: '(namespace: string, updater: (current: object) => object|null, options?: object) => Promise<{ok: true, state: object|null, updated: boolean, created?: boolean} | {ok: false, reason: string, hint: string}>' },
        { label: 'ctx.setCharacterState', type: 'method', info: 'async — Whole-object write of character-bound sidecar (avatar auto-resolved). Pass null to delete. Prefer updateCharacterState for non-trivial payloads. Returns { ok, state } envelope.', detail: '(namespace: string, data: any) => Promise<{ok: true, state: any} | {ok: false, reason: string, hint: string}>' },
        { label: 'ctx.deleteCharacterState', type: 'method', info: 'async — Drop a character-bound sidecar namespace. Returns { ok } envelope.', detail: '(namespace: string) => Promise<{ok: true} | {ok: false, reason: string, hint: string}>' },
    ];

    return function ctxCompletion(context) {
        const word = context.matchBefore(/ctx\.\w*/);
        if (!word) return null;
        if (word.from === word.to && !context.explicit) return null;

        return {
            from: word.from,
            options: ctxCompletions,
        };
    };
}

/**
 * Create a CM6 editor instance in the given container.
 * @param {HTMLElement} container
 * @param {string} content
 * @param {string} filePath
 */
async function createCMEditor(container, content = '', filePath = '') {
    const cm = await loadCM6();
    cmLanguageCompartment = new cm.Compartment();

    const lukerTheme = cm.EditorView.theme({
        '&': {
            height: '100%',
            fontSize: '13px',
        },
        '.cm-scroller': {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            overflow: 'auto',
        },
        '.cm-gutters': {
            borderRight: '1px solid var(--SmartThemeBorderColor, #333)',
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBlurTintColor, #1e1e1e) 90%, transparent)',
        },
        '.cm-activeLineGutter': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 12%, transparent)',
        },
        '.cm-activeLine': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 6%, transparent)',
        },
        '.cm-selectionBackground': {
            backgroundColor: 'color-mix(in oklab, var(--SmartThemeBodyColor, #fff) 18%, transparent) !important',
        },
        '&.cm-focused .cm-cursor': {
            borderLeftColor: 'var(--SmartThemeBodyColor, #fff)',
        },
    }, { dark: true });

    const extensions = [
        cm.lineNumbers(),
        cm.highlightActiveLineGutter(),
        cm.highlightSpecialChars(),
        cm.history(),
        cm.foldGutter(),
        cm.drawSelection(),
        cm.dropCursor(),
        cm.EditorState.allowMultipleSelections.of(true),
        cm.indentOnInput(),
        cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
        cm.bracketMatching(),
        cm.closeBrackets(),
        cm.autocompletion(),
        cm.EditorState.languageData.of(() => [{ autocomplete: createCtxCompletionSource(cm) }]),
        cm.rectangularSelection(),
        cm.crosshairCursor(),
        cm.highlightActiveLine(),
        cm.highlightSelectionMatches(),
        cm.keymap.of([
            ...cm.closeBracketsKeymap,
            ...cm.defaultKeymap,
            ...cm.searchKeymap,
            ...cm.historyKeymap,
            ...cm.foldKeymap,
            ...cm.completionKeymap,
            ...cm.lintKeymap,
            cm.indentWithTab,
        ]),
        cmLanguageCompartment.of(getLanguageForFile(filePath)),
        cm.oneDark,
        lukerTheme,
        cm.EditorView.lineWrapping,
    ];

    cmEditor = new cm.EditorView({
        state: cm.EditorState.create({
            doc: content,
            extensions,
        }),
        parent: container,
    });
}

/**
 * Set the content of the CM6 editor.
 * @param {string} content
 * @param {string} [filePath]
 */
function setCMContent(content, filePath = '') {
    if (!cmEditor) return;
    cmEditor.dispatch({
        changes: { from: 0, to: cmEditor.state.doc.length, insert: content },
    });
    // Update language mode if file changed
    if (cmLanguageCompartment && cmModules) {
        cmEditor.dispatch({
            effects: cmLanguageCompartment.reconfigure(getLanguageForFile(filePath)),
        });
    }
}

/**
 * Get the current content from the CM6 editor.
 * @returns {string}
 */
function getCMContent() {
    if (!cmEditor) return '';
    return cmEditor.state.doc.toString();
}

/**
 * Destroy the CM6 editor instance.
 */
function destroyCMEditor() {
    if (cmEditor) {
        cmEditor.destroy();
        cmEditor = null;
    }
    cmLanguageCompartment = null;
}

// ==================== UI ====================

function escapeHtml(str) {
 const div = document.createElement('div');
 div.textContent = str;
 return div.innerHTML;
}

function getFileIcon(filePath) {
 const ext = filePath.split('.').pop()?.toLowerCase();
 const icons = {
 js: 'fa-brands fa-js',
 css: 'fa-brands fa-css3-alt',
 html: 'fa-brands fa-html5',
 json: 'fa-solid fa-brackets-curly',
 md: 'fa-solid fa-file-lines',
 png: 'fa-solid fa-image',
 jpg: 'fa-solid fa-image',
 svg: 'fa-solid fa-image',
 };
 return icons[ext] || 'fa-solid fa-file';
}

function buildLeftPanelHtml() {
 return `
<div id="${STUDIO_PANEL_LEFT_ID}" class="card-app-studio-panel left">
 <div class="card-app-studio-panel-header">
    <span class="card-app-studio-title">🤖 ${escapeHtml(t('AI Assistant'))}</span>
    <button class="card-app-studio-btn small" data-studio-action="sessions-toggle" title="${escapeHtml(t('Sessions'))}">📋</button>
    <button class="card-app-studio-btn small" data-studio-action="clear-chat" title="${escapeHtml(t('Clear chat'))}">🗑</button>
    <button class="card-app-studio-close-btn" data-studio-action="close" title="${escapeHtml(t('Close Studio'))}">✕</button>
 </div>
 <div class="card-app-studio-sessions-panel" data-studio-sessions style="display: none;">
    <div class="card-app-studio-sessions-header">
        <span>${escapeHtml(t('Sessions'))}</span>
        <button class="card-app-studio-btn small" data-studio-action="new-session">+ ${escapeHtml(t('New'))}</button>
    </div>
    <div class="card-app-studio-sessions-list" data-studio-sessions-list></div>
 </div>
 <div class="card-app-studio-chat" data-studio-chat></div>
 <div class="card-app-studio-composer">
    <textarea class="card-app-studio-input" data-studio-input placeholder="${escapeHtml(t('Describe what you want to build...'))}" rows="3"></textarea>
 <div class="card-app-studio-composer-buttons">
    <label class="card-app-studio-auto-apply" title="${escapeHtml(t('Skip the manual approve step for file changes. Writes apply immediately.'))}">
        <span class="card-app-studio-toggle">
            <input type="checkbox" data-studio-toggle="auto-apply" />
            <span class="card-app-studio-toggle-slider"></span>
        </span>
        <span>${escapeHtml(t('Auto-apply'))}</span>
    </label>
    <div class="card-app-studio-composer-actions">
        <button class="card-app-studio-btn primary" data-studio-action="send">${escapeHtml(t('Send'))}</button>
        <button class="card-app-studio-btn" data-studio-action="stop" disabled>${escapeHtml(t('Stop'))}</button>
    </div>
 </div>
 </div>
</div>`;
}

function buildRightPanelHtml() {
 return `
<div id="${STUDIO_PANEL_RIGHT_ID}" class="card-app-studio-panel right">
 <div class="card-app-studio-panel-header">
    <span class="card-app-studio-title">📝 ${escapeHtml(t('Code Editor'))}</span>
 <div class="card-app-studio-header-actions">
        <button class="card-app-studio-btn small" data-studio-action="save" title="${escapeHtml(t('Save'))} (Ctrl+S)">💾 ${escapeHtml(t('Save'))}</button>
        <button class="card-app-studio-btn small" data-studio-action="reload" title="${escapeHtml(t('Reload'))}">↻ ${escapeHtml(t('Reload'))}</button>
 </div>
 </div>
 <div class="card-app-studio-editor-area">
 <div class="card-app-studio-file-tabs" data-studio-tabs></div>
 <div class="card-app-studio-code" data-studio-code></div>
 </div>
 <div class="card-app-studio-file-tree">
 <div class="card-app-studio-file-tree-header">
        <span>📁 ${escapeHtml(t('Files'))}</span>
 <button class="card-app-studio-btn small" data-studio-action="new-file" title="New file">+</button>
 </div>
 <div class="card-app-studio-file-list" data-studio-file-list></div>
 </div>
 <div class="card-app-studio-history">
 <div class="card-app-studio-file-tree-header">
        <span>📜 ${escapeHtml(t('History'))}</span>
 <button class="card-app-studio-btn small" data-studio-action="refresh-history" title="${escapeHtml(t('Refresh'))}">↻</button>
 </div>
 <div class="card-app-studio-history-list" data-studio-history></div>
 </div>
</div>`;
}

function buildMobileTabsHtml() {
    return `
<div id="${STUDIO_MOBILE_TABS_ID}" class="card-app-studio-mobile-tabs" role="tablist">
    <button type="button" data-studio-action="mobile-tab-left" class="active" role="tab" aria-selected="true">
        <span class="mobile-tab-icon">🤖</span><span>${escapeHtml(t('AI'))}</span>
    </button>
    <button type="button" data-studio-action="mobile-tab-right" role="tab" aria-selected="false">
        <span class="mobile-tab-icon">📝</span><span>${escapeHtml(t('Code'))}</span>
    </button>
    <button type="button" data-studio-action="mobile-tab-preview" role="tab" aria-selected="false">
        <span class="mobile-tab-icon">📱</span><span>${escapeHtml(t('Preview'))}</span>
    </button>
    <button type="button" data-studio-action="close" class="mobile-tab-close" title="${escapeHtml(t('Close Studio'))}" aria-label="${escapeHtml(t('Close Studio'))}">✕</button>
</div>`;
}

/**
 * Switch the visible mobile panel. Three states:
 *   left   — AI chat panel
 *   right  — code editor panel
 *   preview — both studio panels hidden, host chat shows through
 * On desktop the body class has no visual effect (CSS rules sit inside @media),
 * so calling this is harmless regardless of viewport.
 * @param {'left'|'right'|'preview'} which
 */
function setMobileActiveTab(which) {
    mobileActiveTab = ['left', 'right', 'preview'].includes(which) ? which : 'left';
    document.body.classList.toggle('card-app-studio-mobile-tab-right', mobileActiveTab === 'right');
    document.body.classList.toggle('card-app-studio-mobile-tab-preview', mobileActiveTab === 'preview');
    const tabsEl = document.getElementById(STUDIO_MOBILE_TABS_ID);
    if (tabsEl) {
        tabsEl.querySelectorAll('button[data-studio-action^="mobile-tab-"]').forEach(btn => {
            const isActive = btn.dataset.studioAction === `mobile-tab-${mobileActiveTab}`;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
    }
    // CodeMirror needs a measure refresh after going from hidden → visible.
    if (mobileActiveTab === 'right' && cmEditor && typeof cmEditor.requestMeasure === 'function') {
        requestAnimationFrame(() => cmEditor.requestMeasure());
    }
}

function renderFileList(container) {
 const files = fileList.filter(f => f.type === 'file');
 container.innerHTML = files.length === 0
        ? `<div class="card-app-studio-empty">${escapeHtml(t('No files yet'))}</div>`
 : files.map(f => `
 <div class="card-app-studio-file-item${currentFile === f.path ? ' active' : ''}" data-studio-file="${escapeHtml(f.path)}">
 <i class="${getFileIcon(f.path)}"></i>
 <span class="card-app-studio-file-name">${escapeHtml(f.path)}</span>
 <span class="card-app-studio-file-size">${f.size > 1024 ? (f.size / 1024).toFixed(1) + 'KB' : f.size + 'B'}</span>
 </div>
 `).join('');
}

async function fetchHistory(charId) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/history`, {
        headers: getRequestHeaders(),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.commits || [];
}

async function rollbackToCommit(charId, hash) {
    const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/rollback`, {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });
    if (!response.ok) throw new Error(`Rollback failed: ${response.status}`);
    return await response.json();
}

async function renderHistory() {
    const historyEl = document.querySelector('[data-studio-history]');
    if (!historyEl || !currentCharId) return;

    historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(t('Loading...'))}</div>`;

    try {
        const commits = await fetchHistory(currentCharId);
        if (commits.length === 0) {
            historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(t('No history yet'))}</div>`;
            return;
        }
        historyEl.innerHTML = commits.map(c => {
            const timeAgo = formatTimeAgo(c.date);
            return `
            <div class="card-app-studio-history-item" data-studio-commit="${escapeHtml(c.fullHash)}">
                <div class="card-app-studio-history-info">
                    <span class="card-app-studio-history-hash">${escapeHtml(c.hash)}</span>
                    <span class="card-app-studio-history-msg">${escapeHtml(c.message)}</span>
                </div>
                <div class="card-app-studio-history-meta">
                    <span class="card-app-studio-history-time">${escapeHtml(timeAgo)}</span>
                    <button class="card-app-studio-btn small" data-studio-action="rollback" data-studio-hash="${escapeHtml(c.fullHash)}">↩</button>
                </div>
            </div>`;
        }).join('');
    } catch (err) {
        historyEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(tFormat('Error: ${0}', err.message))}</div>`;
    }
}

function formatTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

async function handleRollback(hash) {
    if (!currentCharId || !hash) return;
    if (!confirm(t('Rollback to this version? This cannot be undone.'))) return;

    try {
        await rollbackToCommit(currentCharId, hash);
        toastr.success(t('Rolled back successfully'));

        // Refresh everything
        fileList = await fetchFileList(currentCharId);
        const fileListEl = document.querySelector('[data-studio-file-list]');
        if (fileListEl) renderFileList(fileListEl);
        if (currentFile) await openFile(currentFile);
        await renderHistory();
        await reloadCardApp();
    } catch (err) {
        toastr.error(tFormat('Rollback failed: ${0}', err.message));
    }
}

async function openFile(filePath) {
 if (!currentCharId) return;

 try {
 const content = await fetchFileContent(currentCharId, filePath);
 setCMContent(content, filePath);
 currentFile = filePath;

 // Update file list highlight
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);

 // Update tab display
 const tabsEl = document.querySelector('[data-studio-tabs]');
 if (tabsEl) {
 tabsEl.innerHTML = `<div class="card-app-studio-tab active">${escapeHtml(filePath)}</div>`;
 }
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to open file:`, err);
 setCMContent(`// Error loading ${filePath}: ${err.message}`, filePath);
 }
}

async function handleSaveCurrentFile() {
 if (!currentFile || !currentCharId) return;

 try {
 await saveFileContent(currentCharId, currentFile, getCMContent());
        toastr.success(tFormat('Saved ${0}', currentFile));
 await reloadCardApp();
 } catch (err) {
 console.error(`[${MODULE_NAME}] Failed to save file:`, err);
        toastr.error(tFormat('Failed to save: ${0}', err.message));
 }
}

async function handleNewFile() {
    const name = prompt(t('New file name (e.g. utils.js):'));
 if (!name || !currentCharId) return;

 const safeName = name.trim();
 if (!safeName) return;

 try {
 await saveFileContent(currentCharId, safeName, '');
 fileList = await fetchFileList(currentCharId);
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);
 await openFile(safeName);
        toastr.success(tFormat('Created ${0}', safeName));
 } catch (err) {
        toastr.error(tFormat('Failed to create file: ${0}', err.message));
 }
}

// ==================== Studio Lifecycle ====================

// One-shot wipe of the brief-era session bucket (`cardapp_studio_sessions_v2`).
// The brief iteration-studio CardApp adapter wrote sessions to a new
// namespace because it changed the on-disk shape; reverting to the
// standalone studio means those sessions are no longer reachable, so we
// clear them once to free the sidecar slot. CardApp files on disk are
// untouched. Earlier sessions in `cardapp_studio_sessions` were already
// wiped by the brief-era adapter itself and cannot be recovered.
const SP2_WIPE_FLAG_KEY = 'cardapp_studio_sp2_wiped_v1';

async function wipeSp2EraSessionsIfNeeded(avatar) {
    try {
        if (typeof localStorage === 'undefined') return;
        if (localStorage.getItem(SP2_WIPE_FLAG_KEY)) return;
        const context = getContext();
        if (!avatar || !context?.deleteCharacterState) {
            localStorage.setItem(SP2_WIPE_FLAG_KEY, '1');
            return;
        }
        let hadSp2Data = false;
        try {
            // Envelope read — `result.state` holds the raw payload on hit,
            // null on empty miss. A real read failure (`!ok` with a reason)
            // means we can't safely decide whether to wipe; skip the flag so
            // the next open retries. An empty miss falls through normally.
            const readResult = await context.getCharacterState?.(avatar, 'cardapp_studio_sessions_v2');
            if (readResult && !readResult.ok) {
                console.warn(`[${MODULE_NAME}] SP-2 wipe read failed: ${readResult.reason} ${readResult.hint || ''}`);
                return;
            }
            const sp2 = readResult?.ok ? readResult.state : null;
            hadSp2Data = sp2 != null && Object.keys(sp2).length > 0;
        } catch { /* state may not exist */ }
        if (hadSp2Data) {
            const deleteResult = await context.deleteCharacterState(avatar, 'cardapp_studio_sessions_v2');
            if (!deleteResult?.ok) {
                // Best-effort one-shot wipe — log and skip the flag so the next
                // open retries. The user has no actionable recovery here.
                console.warn(`[${MODULE_NAME}] SP-2 wipe delete failed: ${deleteResult?.reason} ${deleteResult?.hint || ''}`);
                return;
            }
            if (typeof toastr !== 'undefined') {
                toastr.info(t('CardApp Studio reverted to its standalone UI. Brief iteration-studio sessions cleared — files on disk unchanged.'));
            }
        }
        localStorage.setItem(SP2_WIPE_FLAG_KEY, '1');
    } catch (e) {
        console.warn('[CardApp Studio] brief-era session wipe failed', e);
    }
}

export async function openCardAppStudio(charId) {
 if (isStudioOpen) {
        toastr.warning(t('CardApp Studio is already open.'));
 return;
 }

 currentCharId = charId;
 // Cache the full avatar string for sidecar session storage
 const context = getContext();
 const character = context.characters?.[context.characterId];
 currentAvatar = String(character?.avatar || '').trim();
 isStudioOpen = true;

 // One-shot wipe of brief-era session bucket.
 await wipeSp2EraSessionsIfNeeded(currentAvatar);

 // Ensure skeleton files exist
 await ensureSkeletonFiles(charId);

 // Load file list
 fileList = await fetchFileList(charId);

 // Inject CSS
 if (!document.getElementById('card-app-studio-style')) {
 const link = document.createElement('link');
 link.id = 'card-app-studio-style';
 link.rel = 'stylesheet';
 link.href = '/scripts/extensions/character-editor-assistant/studio/studio.css';
 document.head.appendChild(link);
 }

 // Create panels
 const leftPanel = document.createElement('div');
 leftPanel.innerHTML = buildLeftPanelHtml();
 document.body.appendChild(leftPanel.firstElementChild);

 const rightPanel = document.createElement('div');
 rightPanel.innerHTML = buildRightPanelHtml();
 document.body.appendChild(rightPanel.firstElementChild);

 // Mobile tab bar (CSS @media decides whether it's visible)
 const mobileTabs = document.createElement('div');
 mobileTabs.innerHTML = buildMobileTabsHtml();
 document.body.appendChild(mobileTabs.firstElementChild);

 // Sync auto-apply checkbox from persisted settings
 const autoApplyEl = document.querySelector('[data-studio-toggle="auto-apply"]');
 if (autoApplyEl) autoApplyEl.checked = isAutoApplyEnabled();

 // Add body class for margin adjustment
 document.body.classList.add('card-app-studio-active');

 // Render file list
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) renderFileList(fileListEl);

 // Initialize CodeMirror 6 editor
 const codeContainer = document.querySelector('[data-studio-code]');
 if (codeContainer) {
     await createCMEditor(codeContainer, '', '');
 }

 // Open first file
 const firstFile = fileList.find(f => f.type === 'file');
 if (firstFile) {
 await openFile(firstFile.path);
 }

 // Load or create session
 const sessions = await loadAllSessions();
 if (sessions.length > 0) {
     // Load most recent session
     sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
     currentSessionId = sessions[0].id;
     conversationMessages = sessions[0].messages || [];
 } else {
     // Create new session
     currentSessionId = generateSessionId();
     conversationMessages = [];
 }

 // Render persisted messages in chat
 const chatEl = document.querySelector('[data-studio-chat]');
 if (chatEl && conversationMessages.length > 0) {
     for (const msg of conversationMessages) {
         if (msg.role === 'user') {
             renderChatMessage('user', msg.content);
         } else if (msg.role === 'assistant' && msg.content) {
             renderChatMessage('assistant', msg.content);
         }
     }
 }

 // Load history
 renderHistory();

 // Bind events
 bindStudioEvents();

 console.log(`[${MODULE_NAME}] Studio opened for ${charId}`);
}

export async function closeCardAppStudio() {
 if (!isStudioOpen) return;

 // Destroy CM6 editor
 destroyCMEditor();

 // Remove panels
 document.getElementById(STUDIO_PANEL_LEFT_ID)?.remove();
 document.getElementById(STUDIO_PANEL_RIGHT_ID)?.remove();
 document.getElementById(STUDIO_MOBILE_TABS_ID)?.remove();

 // Remove body classes
 document.body.classList.remove(
     'card-app-studio-active',
     'card-app-studio-mobile-tab-right',
     'card-app-studio-mobile-tab-preview',
 );

 mobileActiveTab = 'left';

    // Save conversation before clearing state
    if (currentSessionId && conversationMessages.length > 0) {
        const summary = generateSessionSummary(conversationMessages);
        await saveCurrentSession(currentSessionId, conversationMessages, summary);
    }
    isStudioOpen = false;
    currentCharId = null;
    currentAvatar = null;
    currentFile = null;
    fileList = [];
    conversationMessages = [];
    currentSessionId = null;
    isSending = false;
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
    document.removeEventListener('click', handleStudioClick);
    document.removeEventListener('keydown', handleStudioKeydown);

    console.log(`[${MODULE_NAME}] Studio closed`);
}

function bindStudioEvents() {
 // Delegated click handler for both panels
 document.addEventListener('click', handleStudioClick);

 // Keyboard shortcuts
 document.addEventListener('keydown', handleStudioKeydown);

 // Auto-apply toggle (persist to extension_settings)
 const autoApplyEl = document.querySelector('[data-studio-toggle="auto-apply"]');
 if (autoApplyEl) {
     autoApplyEl.addEventListener('change', (e) => {
         setAutoApplyEnabled(Boolean(e.target.checked));
     });
 }

 // File list click
 const fileListEl = document.querySelector('[data-studio-file-list]');
 if (fileListEl) {
 fileListEl.addEventListener('click', async (e) => {
 const fileItem = e.target.closest('[data-studio-file]');
 if (fileItem) {
 const filePath = fileItem.dataset.studioFile;
 if (filePath) await openFile(filePath);
 }
 });
 }
}

// ==================== AI Chat UI ====================

/**
 * Render markdown content to sanitized HTML.
 * @param {string} text
 * @returns {string}
 */
function renderMarkdown(text) {
    if (!text) return '';
    const html = mdConverter.makeHtml(text);
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/**
 * Generate a simple unified diff view.
 * @param {string|null} oldContent
 * @param {string} newContent
 * @param {string} filePath
 * @returns {string} HTML string
 */
function generateDiffPreview(oldContent, newContent, filePath) {
    const isNewFile = oldContent === null || oldContent === undefined;
    const headerLabel = isNewFile ? t('New file') : t('Modified');

    if (isNewFile) {
        // New file — show all lines as additions
        const lines = String(newContent).split('\n');
        const maxShow = 30;
        const preview = lines.slice(0, maxShow).map((line, i) =>
            `<tr class="diff-row diff-add"><td class="diff-ln">${i + 1}</td><td class="diff-text"><span class="diff-marker">+</span>${escapeHtml(line) || '&nbsp;'}</td></tr>`,
        ).join('');
        const more = lines.length > maxShow
            ? `<tr class="diff-row diff-more"><td colspan="2">${escapeHtml(tFormat('...${0} more lines', lines.length - maxShow))}</td></tr>`
            : '';
        return `<div class="card-app-studio-diff-preview">
            <div class="diff-header"><span class="diff-badge add">${escapeHtml(headerLabel)}</span> <strong>${escapeHtml(filePath)}</strong></div>
            <table class="diff-table">${preview}${more}</table>
        </div>`;
    }

    // Existing file — compute line-level diff with DiffMatchPatch
    const dmp = new DiffMatchPatch();
    const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(String(oldContent), String(newContent));
    const diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);

    const rows = [];
    let oldLineNum = 1;
    let newLineNum = 1;
    let totalRows = 0;
    const maxRows = 60;

    for (const [op, text] of diffs) {
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();

        for (const line of lines) {
            if (totalRows >= maxRows) break;
            if (op === 0) {
                rows.push(`<tr class="diff-row diff-eq"><td class="diff-ln">${oldLineNum}</td><td class="diff-ln">${newLineNum}</td><td class="diff-text">${escapeHtml(line) || '&nbsp;'}</td></tr>`);
                oldLineNum++;
                newLineNum++;
            } else if (op === -1) {
                rows.push(`<tr class="diff-row diff-del"><td class="diff-ln">${oldLineNum}</td><td class="diff-ln"></td><td class="diff-text"><span class="diff-marker">−</span>${escapeHtml(line) || '&nbsp;'}</td></tr>`);
                oldLineNum++;
            } else if (op === 1) {
                rows.push(`<tr class="diff-row diff-add"><td class="diff-ln"></td><td class="diff-ln">${newLineNum}</td><td class="diff-text"><span class="diff-marker">+</span>${escapeHtml(line) || '&nbsp;'}</td></tr>`);
                newLineNum++;
            }
            totalRows++;
        }
        if (totalRows >= maxRows) break;
    }

    const totalOldLines = String(oldContent).split('\n').length;
    const totalNewLines = String(newContent).split('\n').length;
    const remaining = Math.max(totalOldLines, totalNewLines) - totalRows;
    const more = remaining > 0
        ? `<tr class="diff-row diff-more"><td colspan="3">${escapeHtml(tFormat('...${0} more lines', remaining))}</td></tr>`
        : '';

    return `<div class="card-app-studio-diff-preview">
        <div class="diff-header"><span class="diff-badge mod">${escapeHtml(headerLabel)}</span> <strong>${escapeHtml(filePath)}</strong></div>
        <table class="diff-table">${rows.join('')}${more}</table>
    </div>`;
}

/**
 * Get a human-readable label for a tool name.
 * @param {string} name
 * @returns {{ icon: string, label: string }}
 */
function getToolDisplay(name) {
    const map = {
        cardapp_list_files: { icon: '📂', label: 'List files' },
        cardapp_read_file: { icon: '📖', label: 'Read file' },
        cardapp_write_file: { icon: '✏️', label: 'Write file' },
        cardapp_patch_file: { icon: '🩹', label: 'Patch file' },
        cardapp_delete_file: { icon: '🗑️', label: 'Delete file' },
        cardapp_rename_file: { icon: '📝', label: 'Rename file' },
        cardapp_set_enabled: { icon: '🔌', label: 'Toggle CardApp' },
    };
    return map[name] || { icon: '🔧', label: name };
}

function renderChatMessage(role, content, toolInfo = null) {
    const chatEl = document.querySelector('[data-studio-chat]');
    if (!chatEl) return;
    const msgEl = document.createElement('div');
    msgEl.className = `card-app-studio-chat-msg ${role}`;
    if (toolInfo) {
        const display = getToolDisplay(toolInfo.name);
        msgEl.innerHTML = `<div class="card-app-studio-tool-call">
            <span class="tool-icon">${toolInfo.ok ? '✅' : '❌'}</span>
            <span class="tool-label">${escapeHtml(display.icon)} ${escapeHtml(display.label)}</span>
            ${toolInfo.detail ? `<span class="tool-detail">${escapeHtml(toolInfo.detail)}</span>` : ''}
        </div>`;
    } else if (role === 'assistant') {
        msgEl.innerHTML = `<div class="card-app-studio-msg-content">${renderMarkdown(content)}</div>`;
    } else if (role === 'user') {
        const pre = document.createElement('pre');
        pre.textContent = content;
        msgEl.appendChild(pre);
    } else {
        msgEl.textContent = content;
    }
    chatEl.appendChild(msgEl);
    chatEl.scrollTop = chatEl.scrollHeight;
}

/**
 * Render a pending approval request for a batch of file modifications.
 * @param {object} batch - { items: [{edit, displayPath, tool}, ...], live, newLive }
 * @returns {Promise<boolean>} Promise that resolves to true if approved, false if rejected
 */
function renderPendingApproval(batch) {
    return new Promise((resolve) => {
        const chatEl = document.querySelector('[data-studio-chat]');
        if (!chatEl) {
            resolve(false);
            return;
        }

        const msgEl = document.createElement('div');
        msgEl.className = 'card-app-studio-chat-msg approval';

        const items   = Array.isArray(batch?.items) ? batch.items : [];
        const live    = batch?.live    || { files: {} };
        const newLive = batch?.newLive || { files: {} };

        const parseBarePath = (opPath) => {
            const m = /^files\["?([^"\]]+)"?\]$/.exec(String(opPath || ''));
            return m ? m[1] : String(opPath || '');
        };

        const sections = items.map(item => {
            const edit = item.edit;
            const displayPath = item.displayPath || '';
            if (edit.op === 'set') {
                const bare = parseBarePath(edit.path);
                const oldContent = bare in (live.files || {}) ? live.files[bare] : null;
                return generateDiffPreview(oldContent, edit.newValue, displayPath);
            }
            if (edit.op === 'cardapp_patch_file') {
                const oldContent = edit.path in (live.files || {}) ? live.files[edit.path] : null;
                const newContent = newLive.files?.[edit.path] ?? '';
                return generateDiffPreview(oldContent, newContent, displayPath);
            }
            if (edit.op === 'unset') {
                return `<div class="card-app-studio-diff-preview">
                    <div class="diff-header"><span class="diff-badge del">${escapeHtml(t('Delete'))}</span> <strong>${escapeHtml(displayPath)}</strong></div>
                </div>`;
            }
            if (edit.op === 'cardapp_rename_file') {
                return `<div class="card-app-studio-diff-preview">
                    <div class="diff-header"><span class="diff-badge mod">${escapeHtml(t('Rename'))}</span> <strong>${escapeHtml(displayPath)}</strong></div>
                </div>`;
            }
            return '';
        }).join('');

        const headerText = items.length === 1
            ? t('Approve file change?')
            : tFormat('Approve ${0} file changes?', items.length);

        msgEl.innerHTML = `
            <div class="card-app-studio-approval-header">
                <span>🔔 ${escapeHtml(headerText)}</span>
            </div>
            ${sections}
            <div class="card-app-studio-approval-actions">
                <button class="card-app-studio-btn small primary" data-approval-action="approve">${escapeHtml(t('Approve'))}</button>
                <button class="card-app-studio-btn small" data-approval-action="reject">${escapeHtml(t('Reject'))}</button>
            </div>
        `;

        chatEl.appendChild(msgEl);
        chatEl.scrollTop = chatEl.scrollHeight;

        const approveBtn = msgEl.querySelector('[data-approval-action="approve"]');
        const rejectBtn = msgEl.querySelector('[data-approval-action="reject"]');

        const handleApprove = () => {
            approveBtn.disabled = true;
            rejectBtn.disabled = true;
            msgEl.classList.add('approved');
            resolve(true);
        };

        const handleReject = () => {
            approveBtn.disabled = true;
            rejectBtn.disabled = true;
            msgEl.classList.add('rejected');
            resolve(false);
        };

        approveBtn.addEventListener('click', handleApprove, { once: true });
        rejectBtn.addEventListener('click', handleReject, { once: true });
    });
}

function showLoadingMessage() {
    const chatEl = document.querySelector('[data-studio-chat]');
    if (!chatEl) return null;
    const msgEl = document.createElement('div');
    msgEl.className = 'card-app-studio-chat-msg assistant loading';
    msgEl.innerHTML = `<div class="card-app-studio-loading-dots">
        <span></span><span></span><span></span>
    </div>
    <span class="card-app-studio-loading-text">${escapeHtml(t('Thinking...'))}</span>`;
    chatEl.appendChild(msgEl);
    chatEl.scrollTop = chatEl.scrollHeight;
    return msgEl;
}

function syncComposerState() {
    const sendBtn = document.querySelector('[data-studio-action="send"]');
    const stopBtn = document.querySelector('[data-studio-action="stop"]');
    const input = document.querySelector('[data-studio-input]');
    if (sendBtn) sendBtn.disabled = isSending;
    if (stopBtn) stopBtn.disabled = !isSending;
    if (input) input.disabled = isSending;
}

/**
 * Render the session list UI.
 */
async function renderSessionList() {
    const listEl = document.querySelector('[data-studio-sessions-list]');
    if (!listEl) return;
    
    const sessions = await loadAllSessions();
    
    if (sessions.length === 0) {
        listEl.innerHTML = `<div class="card-app-studio-empty">${escapeHtml(t('No sessions yet'))}</div>`;
        return;
    }
    
    // Sort by updatedAt descending
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    
    listEl.innerHTML = sessions.map(session => {
        const isCurrent = session.id === currentSessionId;
        const timeAgo = formatTimeAgo(new Date(session.updatedAt).toISOString());
        return `
            <div class="card-app-studio-session-item ${isCurrent ? 'current' : ''}" data-session-id="${escapeHtml(session.id)}">
                <div class="session-info">
                    <span class="session-summary">${escapeHtml(session.summary)}</span>
                    <span class="session-time">${escapeHtml(timeAgo)}</span>
                </div>
                <div class="session-actions">
                    ${isCurrent ? `<span class="session-badge">${escapeHtml(t('Current'))}</span>` : `<button class="card-app-studio-btn small" data-studio-action="load-session" data-session-id="${escapeHtml(session.id)}">${escapeHtml(t('Load'))}</button>`}
                    <button class="card-app-studio-btn small" data-studio-action="delete-session" data-session-id="${escapeHtml(session.id)}" title="${escapeHtml(t('Delete'))}">🗑</button>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * Toggle the sessions panel visibility.
 */
function toggleSessionsPanel() {
    const panel = document.querySelector('[data-studio-sessions]');
    if (!panel) return;
    
    const isVisible = panel.style.display !== 'none';
    panel.style.display = isVisible ? 'none' : 'flex';
    
    if (!isVisible) {
        renderSessionList();
    }
}

/**
 * Create a new session.
 */
async function createNewSession() {
    // Save current session if it has messages
    if (currentSessionId && conversationMessages.length > 0) {
        const summary = generateSessionSummary(conversationMessages);
        await saveCurrentSession(currentSessionId, conversationMessages, summary);
    }
    
    // Create new session
    currentSessionId = generateSessionId();
    conversationMessages = [];
    
    // Clear chat UI
    const chatEl = document.querySelector('[data-studio-chat]');
    if (chatEl) chatEl.innerHTML = '';
    
    // Update session list
    await renderSessionList();
    
    toastr.info(t('New session created'));
}

/**
 * Load a session by ID.
 * @param {string} sessionId
 */
async function loadSessionById(sessionId) {
    try {
        // Save current session if it has messages
        if (currentSessionId && conversationMessages.length > 0) {
            const summary = generateSessionSummary(conversationMessages);
            await saveCurrentSession(currentSessionId, conversationMessages, summary);
        }
        
        // Load new session
        const messages = await loadSession(sessionId);
        currentSessionId = sessionId;
        conversationMessages = messages;
        
        // Clear and re-render chat
        const chatEl = document.querySelector('[data-studio-chat]');
        if (chatEl) {
            chatEl.innerHTML = '';
            for (const msg of conversationMessages) {
                if (msg.role === 'user') {
                    renderChatMessage('user', msg.content);
                } else if (msg.role === 'assistant' && msg.content) {
                    renderChatMessage('assistant', msg.content);
                }
            }
        }
        
        // Update session list
        await renderSessionList();
        
        toastr.success(t('Session loaded'));
    } catch (err) {
        toastr.error(tFormat('Load failed: ${0}', err.message));
    }
}

/**
 * Delete a session by ID.
 * @param {string} sessionId
 */
async function deleteSessionById(sessionId) {
    if (!confirm(t('Delete this session?'))) return;
    
    try {
        await deleteSession(sessionId);
        
        // If deleting current session, create a new one
        if (sessionId === currentSessionId) {
            currentSessionId = generateSessionId();
            conversationMessages = [];
            const chatEl = document.querySelector('[data-studio-chat]');
            if (chatEl) chatEl.innerHTML = '';
        }
        
        await renderSessionList();
        toastr.success(t('Session deleted'));
    } catch (err) {
        toastr.error(tFormat('Delete failed: ${0}', err.message));
    }
}

async function handleAISend() {
    const input = document.querySelector('[data-studio-input]');
    if (!input || !currentCharId) return;
    const userText = input.value.trim();
    if (!userText || isSending) return;
    input.value = '';
    isSending = true;
    const controller = new AbortController();
    activeAbortController = controller;
    syncComposerState();
    renderChatMessage('user', userText);
    let loadingEl = showLoadingMessage();
    try {
        // Read preset config from CEA settings
        const ceaSettings = extension_settings?.character_editor_assistant || {};
        const llmPresetName = String(ceaSettings.requestLlmPresetName || '').trim();
        const apiProfileName = String(ceaSettings.requestApiPresetName || '').trim();
        const result = await sendAIMessage(currentCharId, conversationMessages, userText, {
            abortSignal: controller.signal,
            llmPresetName,
            apiPresetName: apiProfileName,
            systemPrompt: ceaSettings.cardAppStudioSystemPrompt,
            onAssistantText: (text) => {
                if (loadingEl?.parentNode) loadingEl.remove();
                renderChatMessage('assistant', text);
                loadingEl = showLoadingMessage();
            },
            onToolCall: (name, args, toolResult) => {
                let detail = '';
                if (name === TOOL_NAMES.READ_FILE) detail = args.path;
                else if (name === TOOL_NAMES.WRITE_FILE) detail = args.path;
                else if (name === TOOL_NAMES.PATCH_FILE) detail = args.path;
                else if (name === TOOL_NAMES.DELETE_FILE) detail = args.path;
                else if (name === TOOL_NAMES.RENAME_FILE) detail = `${args.from_path} → ${args.to_path}`;
                else if (name === TOOL_NAMES.LIST_FILES) detail = `${toolResult?.files?.length || 0} files`;
                else if (name === TOOL_NAMES.REGEX_LIST_SCRIPTS) {
                    const scope = String(args?.scope || 'all');
                    if (scope === 'all') {
                        const cc = toolResult?.character?.length || 0;
                        const gc = toolResult?.global?.length || 0;
                        detail = `character: ${cc}, global: ${gc}`;
                    } else {
                        detail = `${scope}: ${toolResult?.scripts?.length || 0}`;
                    }
                }
                else if (name === TOOL_NAMES.REGEX_CREATE_SCRIPT) detail = `${args?.scope || '?'} / ${args?.scriptName || '(unnamed)'}`;
                else if (name === TOOL_NAMES.REGEX_UPDATE_SCRIPT) detail = `${args?.scope || '?'} / ${args?.id || '?'}`;
                else if (name === TOOL_NAMES.REGEX_DELETE_SCRIPT) detail = `${args?.scope || '?'} / ${args?.id || '?'}`;
                renderChatMessage('tool', '', { name, detail, ok: toolResult.ok });
            },
            onPendingApproval: isAutoApplyEnabled() ? null : async (batch) => {
                return await renderPendingApproval(batch);
            },
        });
        if (loadingEl?.parentNode) loadingEl.remove();
        if (result.modifiedFiles.length > 0) {
            fileList = await fetchFileList(currentCharId);
            const fileListEl = document.querySelector('[data-studio-file-list]');
            if (fileListEl) renderFileList(fileListEl);
            if (currentFile && result.modifiedFiles.includes(currentFile)) await openFile(currentFile);
            await reloadCardApp();
        }
    } catch (err) {
        if (loadingEl?.parentNode) loadingEl.remove();
        renderChatMessage('assistant', err.message === 'Request aborted' ? t('(Request cancelled)') : tFormat('Error: ${0}', err.message));
    } finally {
        if (activeAbortController === controller) activeAbortController = null;
        isSending = false;
        syncComposerState();
        // Auto-save conversation with summary. Hot path — fires on every AI
        // turn — so suppress the toastr error to avoid spamming the user on
        // a single transient failure. The warning still hits the console.
        if (currentCharId && currentSessionId && conversationMessages.length > 0) {
            const summary = generateSessionSummary(conversationMessages);
            await saveCurrentSession(currentSessionId, conversationMessages, summary, { silent: true });
            await renderSessionList();
        }
    }
}

function handleAIStop() {
    if (activeAbortController && !activeAbortController.signal.aborted) {
        activeAbortController.abort();
        syncComposerState();
    }
}

async function handleStudioClick(e) {
    const actionEl = e.target.closest('[data-studio-action]');
    if (!actionEl) return;

    const action = actionEl.dataset.studioAction;
    switch (action) {
        case 'close':
            closeCardAppStudio();
            break;
        case 'save':
            handleSaveCurrentFile();
            break;
        case 'reload':
            reloadCardApp();
            break;
        case 'new-file':
            handleNewFile();
            break;
        case 'send':
            handleAISend();
            break;
        case 'stop':
            handleAIStop();
            break;
        case 'clear-chat': {
            conversationMessages = [];
            if (currentSessionId) {
                await deleteSession(currentSessionId);
                currentSessionId = generateSessionId();
            }
            const chatEl = document.querySelector('[data-studio-chat]');
            if (chatEl) chatEl.innerHTML = '';
            await renderSessionList();
            break;
        }
        case 'sessions-toggle':
            toggleSessionsPanel();
            break;
        case 'new-session':
            await createNewSession();
            break;
        case 'load-session': {
            const sessionId = actionEl.dataset.sessionId;
            if (sessionId) await loadSessionById(sessionId);
            break;
        }
        case 'delete-session': {
            const sessionId = actionEl.dataset.sessionId;
            if (sessionId) await deleteSessionById(sessionId);
            break;
        }
        case 'refresh-history':
            renderHistory();
            break;
        case 'rollback': {
            const hash = actionEl.dataset.studioHash;
            if (hash) handleRollback(hash);
            break;
        }
        case 'mobile-tab-left':
            setMobileActiveTab('left');
            break;
        case 'mobile-tab-right':
            setMobileActiveTab('right');
            break;
        case 'mobile-tab-preview':
            setMobileActiveTab('preview');
            break;
    }
}

function handleStudioKeydown(e) {
    if (!isStudioOpen) return;

    // Ctrl+S: Save current file
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveCurrentFile();
        return;
    }

    // Enter behavior in the AI input is the textarea default (newline).
    // Sending is via the Send button only, matching iteration-studio /
    // completion-preset-assistant. Mobile keyboards have no Ctrl key,
    // so an Enter-to-send shortcut here would always lose newlines for
    // touch users.

    // Escape: Close studio (only if not focused in AI input textarea or CM6 editor)
    if (e.key === 'Escape' && document.activeElement?.tagName !== 'TEXTAREA' && !document.activeElement?.closest('.cm-editor')) {
        closeCardAppStudio();
        return;
    }
}

// Export file API for AI tool execution (Commit 4)
export { fetchFileList, fetchFileContent, saveFileContent, deleteFile, renameFile };
