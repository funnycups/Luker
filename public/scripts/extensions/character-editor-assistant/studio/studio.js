/**
 * CardApp Studio — entry point and helper module.
 *
 * As of SP-2, `openCardAppStudio(charId)` is a thin entry that builds the
 * CardApp adapter (see `adapter.js`) and delegates the popup, session
 * persistence, LLM round-trip, diff preview and approval flow to the shared
 * iteration-studio shell.
 *
 * The CRUD helpers (`fetchFileList`, `fetchFileContent`, `saveFileContent`,
 * `deleteFile`, `renameFile`) remain exported here so they can be imported by
 * both the adapter (via deps) and the adapter's tool runner in `ai-chat.js`.
 *
 * The CodeMirror 6 setup and the file-tree / history mount helpers below are
 * kept as exports for a follow-up task that will wire them into the shell's
 * `renderPreviewPane` slots via `adapter.handleAction(...)`. They are NOT
 * invoked by `openCardAppStudio` anymore.
 */

import { getRequestHeaders } from '../../../../script.js';
import { translate } from '../../../i18n.js';
import {
    extension_settings,
    getExtensionApi,
    getCharacterState,
    setCharacterState,
} from '../../../extensions.js';
import { openIterationStudio } from '../../../iteration-studio/index.js';
import { i18n, i18nFormat } from '../../../iteration-studio/i18n.js';

import { createCardAppStudioAdapter } from './adapter.js';

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

// ==================== File API ====================
// These five helpers are imported by `ai-chat.js` and consumed by the adapter
// via its deps. Keep them stable and self-contained.

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
        const skeletonIndexJs = [
            '/**',
            ' * CardApp entry point.',
            ' * @param {object} ctx - The CardApp context object',
            ' */',
            'export function init(ctx) {',
            // eslint-disable-next-line quotes -- inline HTML uses double quotes around the style attribute
            "    ctx.container.innerHTML = '<div style=\"padding:20px;\">Hello from CardApp!</div>';",
            '}',
            '',
        ].join('\n');
        await saveFileContent(charId, 'index.js', skeletonIndexJs);
        await saveFileContent(charId, 'style.css', '/* CardApp styles */\n');
        console.log(`[${MODULE_NAME}] Created skeleton files for ${charId}`);
    }
}

// ==================== CSS injection ====================

function ensureStudioStylesheet() {
    if (document.getElementById('card-app-studio-style')) return;
    const link = document.createElement('link');
    link.id = 'card-app-studio-style';
    link.rel = 'stylesheet';
    link.href = '/scripts/extensions/character-editor-assistant/studio/studio.css';
    document.head.appendChild(link);
}

// ==================== escapeHtml helper ====================
// Exposed as a dep to the adapter for renderMessageCard / renderHistoryItem.

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
}

// ==================== Preview pane helpers (kept for follow-up wiring) ====================
//
// TODO: A future task will mount these into the shell's renderPreviewPane
// slots (`data-iter-slot="file-tree"` and `data-iter-slot="editor"`) via
// `adapter.handleAction(...)`. They are intentionally kept here as exports
// rather than deleted so that wiring stays a pure UI task and does not need
// to re-derive the CM6 setup.

// CodeMirror 6 module cache + active instance.
let cmEditor = null;
let cmModules = null;
let cmLanguageCompartment = null;

async function loadCM6() {
    if (cmModules) return cmModules;
    cmModules = await import('/codemirror.bundle.js');
    return cmModules;
}

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
        { label: 'ctx.getChatState', type: 'method', info: 'async — Read chat-bound sidecar namespace', detail: '(namespace: string, options?: object) => Promise<object|null>' },
        { label: 'ctx.updateChatState', type: 'method', info: 'async — Reducer-style write of chat-bound sidecar', detail: '(namespace: string, updater: (current: object) => object|null, options?: object) => Promise<{ok: boolean, state: object|null, updated: boolean}>' },
        { label: 'ctx.patchChatState', type: 'method', info: 'async — Apply JSON-patch ops to chat-bound sidecar', detail: '(namespace: string, operations: object[], options?: object) => Promise<boolean>' },
        { label: 'ctx.deleteChatState', type: 'method', info: 'async — Drop a chat-bound sidecar namespace', detail: '(namespace: string, options?: object) => Promise<boolean>' },
        { label: 'ctx.getCharacterState', type: 'method', info: 'async — Read character-bound sidecar (avatar auto-resolved)', detail: '(namespace: string) => Promise<any>' },
        { label: 'ctx.setCharacterState', type: 'method', info: 'async — Write character-bound sidecar (avatar auto-resolved). Pass null to delete.', detail: '(namespace: string, data: any) => Promise<void>' },
    ];

    return function ctxCompletion(context) {
        const word = context.matchBefore(/ctx\.\w*/);
        if (!word) return null;
        if (word.from === word.to && !context.explicit) return null;
        return { from: word.from, options: ctxCompletions };
    };
}

async function createCMEditor(container, content = '', filePath = '') {
    const cm = await loadCM6();
    cmLanguageCompartment = new cm.Compartment();

    const lukerTheme = cm.EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
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
        state: cm.EditorState.create({ doc: content, extensions }),
        parent: container,
    });
    return cmEditor;
}

function setCMContent(content, filePath = '') {
    if (!cmEditor) return;
    cmEditor.dispatch({
        changes: { from: 0, to: cmEditor.state.doc.length, insert: content },
    });
    if (cmLanguageCompartment && cmModules) {
        cmEditor.dispatch({
            effects: cmLanguageCompartment.reconfigure(getLanguageForFile(filePath)),
        });
    }
}

function getCMContent() {
    if (!cmEditor) return '';
    return cmEditor.state.doc.toString();
}

function destroyCMEditor() {
    if (cmEditor) {
        cmEditor.destroy();
        cmEditor = null;
    }
    cmLanguageCompartment = null;
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

// ==================== Entry point ====================

/**
 * Open the CardApp Studio popup for the given character.
 *
 * Constructs the v2 CardApp adapter and hands it to the shared
 * iteration-studio shell, which owns the popup, session persistence,
 * LLM round-trip, diff preview and approval flow.
 *
 * @param {string} charId
 */
export async function openCardAppStudio(charId) {
    if (!charId) {
        console.warn(`[${MODULE_NAME}] openCardAppStudio called without a charId`);
        return;
    }

    // Ensure CardApp scaffolding exists so the adapter's first `live()` call
    // returns something useful.
    try {
        await ensureSkeletonFiles(charId);
    } catch (err) {
        console.warn(`[${MODULE_NAME}] ensureSkeletonFiles failed:`, err);
    }

    // CSS is still injected here for now. The shell's `ensureStyles` hook is
    // not used because that hook is keyed on popupClassName and would not
    // pick up our existing stylesheet path. Keeping this idempotent ensures
    // the second-open path is a no-op.
    ensureStudioStylesheet();

    const context = (typeof SillyTavern !== 'undefined' && SillyTavern?.getContext)
        ? SillyTavern.getContext()
        : null;
    const settings = context?.extensionSettings?.character_editor_assistant
        ?? extension_settings?.character_editor_assistant
        ?? {};

    const adapter = createCardAppStudioAdapter({
        charId,
        i18n,
        i18nFormat,
        escapeHtml,
        fetchFileList,
        fetchFileContent,
        saveFileContent,
        deleteFile,
        renameFile,
        getCharacterState,
        setCharacterState,
        reloadCardApp: () => reloadCardApp(),
    });

    await openIterationStudio(adapter, context, settings);

    console.log(`[${MODULE_NAME}] Studio session ended for ${charId}`);
}

// ==================== Exports ====================

// CRUD helpers — consumed by adapter (via deps) and by `ai-chat.js`.
export {
    fetchFileList,
    fetchFileContent,
    saveFileContent,
    deleteFile,
    renameFile,
};

// CardApp reload + helpers — exported for the follow-up preview-pane wiring.
export {
    reloadCardApp,
    escapeHtml,
    ensureStudioStylesheet,
    ensureSkeletonFiles,
    createCMEditor,
    setCMContent,
    getCMContent,
    destroyCMEditor,
    getFileIcon,
    t,
    tFormat,
};
