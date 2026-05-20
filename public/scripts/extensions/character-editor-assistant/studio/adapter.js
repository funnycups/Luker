import { defineAdapter } from '../../../iteration-studio/index.js';
import { buildCardAppStudioTools, buildCardAppStudioSystemPrompt, buildCardAppStudioUserPrompt, executeCardAppControlToolCall } from './ai-chat.js';
import { renderLineDiff } from './diff-render.js';

// Re-export so Task 11 mount code can share the diff renderer without
// reaching into the helper module path directly.
export { renderLineDiff };

const WRITE_TOOL_NAMES = new Set(['cardapp_write_file', 'cardapp_patch_file', 'cardapp_delete_file', 'cardapp_rename_file']);
const READ_TOOL_NAMES = new Set(['cardapp_list_files', 'cardapp_read_file']);

function bracketPath(filename) {
    // Filenames may contain dots / slashes — lodash bracket notation handles all of them safely.
    const escaped = String(filename).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `files["${escaped}"]`;
}

function parseArgs(call) {
    try { return JSON.parse(call?.function?.arguments ?? '{}'); }
    catch { return null; }
}

function describeAppliedEdits(edits) {
    if (!Array.isArray(edits) || edits.length === 0) return '';
    const ops = edits.map(e => String(e?.op || '?')).join(', ');
    return `${edits.length} edit${edits.length === 1 ? '' : 's'}: ${ops}`;
}

function formatTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(); }
    catch { return String(ts); }
}

function fallbackEscapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function createCardAppStudioAdapter(deps) {
    const { charId, i18n, i18nFormat } = deps;

    let previousCommitSnapshot = null;

    const SESSION_NAMESPACE_V2 = 'cardapp_studio_sessions_v2';

    function readBucket() {
        const state = deps.getCharacterState(deps.charId, SESSION_NAMESPACE_V2) || {};
        return state.sessions || {};
    }
    function writeBucket(sessions) {
        deps.setCharacterState(deps.charId, SESSION_NAMESPACE_V2, { sessions });
    }

    return defineAdapter({
        id: `cea_cardapp_${charId}`,
        title: i18n('CardApp Studio'),
        mode: 'cea_cardapp',
        layout: 'split',
        popupClassName: 'luker_cea_cardapp_popup',
        i18n, i18nFormat,

        live: async () => {
            const list = await deps.fetchFileList(deps.charId);
            const files = {};
            for (const path of list) {
                files[path] = await deps.fetchFileContent(deps.charId, path);
            }
            return { files, metadata: { charId: deps.charId } };
        },
        commit: async (newLive) => {
            const before = previousCommitSnapshot ?? { files: {} };
            const beforeFiles = before.files || {};
            const afterFiles = newLive.files || {};

            // Deletes
            for (const path of Object.keys(beforeFiles)) {
                if (!(path in afterFiles)) {
                    await deps.deleteFile(deps.charId, path);
                }
            }
            // Creates + updates
            for (const path of Object.keys(afterFiles)) {
                if (afterFiles[path] !== beforeFiles[path]) {
                    await deps.saveFileContent(deps.charId, path, afterFiles[path]);
                }
            }

            previousCommitSnapshot = structuredClone(newLive);
            deps.reloadCardApp();
        },

        sessionScope: () => `char_${charId}`,
        listSessions: async () => {
            const bucket = readBucket();
            return Object.values(bucket).map(s => ({
                id: s.id, title: s.title || '', updatedAt: s.updatedAt || 0, summary: s.summary || '',
            })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        },
        loadSession: async (_scope, id) => {
            const bucket = readBucket();
            const s = bucket[id];
            return s ? structuredClone(s) : null;
        },
        saveSession: async (_scope, session) => {
            const bucket = readBucket();
            bucket[session.id] = structuredClone(session);
            writeBucket(bucket);
        },
        deleteSession: async (_scope, id) => {
            const bucket = readBucket();
            delete bucket[id];
            writeBucket(bucket);
        },
        clearObsoleteSessions: async () => {
            // SP-2 wipes the v1 character-sidecar bucket; live files on disk are untouched.
            deps.setCharacterState(deps.charId, 'cardapp_studio_sessions', null);
        },

        buildToolCatalog: () => buildCardAppStudioTools(),

        classifyToolCall: (call) => {
            const name = call?.function?.name;
            return READ_TOOL_NAMES.has(name) ? 'control' : 'editable';
        },

        executeControlToolCall: async (call, ctx, signal) => executeCardAppControlToolCall(call, ctx, signal, deps),

        normalizeToolCallToEdit: async (call, ctx) => {
            const name = call?.function?.name;
            const args = parseArgs(call);
            if (args === null) return null;
            const live = ctx?.live ?? { files: {} };
            const files = live.files || {};

            if (name === 'cardapp_write_file') {
                const path = String(args.path || '');
                const content = String(args.content ?? '');
                return [{ op: 'set', path: bracketPath(path), oldValue: files[path], newValue: content }];
            }
            if (name === 'cardapp_patch_file') {
                const path = String(args.path || '');
                return [{ op: 'str_replace', path: bracketPath(path), find: String(args.old_text ?? ''), replace: String(args.new_text ?? '') }];
            }
            if (name === 'cardapp_delete_file') {
                const path = String(args.path || '');
                return [{ op: 'unset', path: bracketPath(path), expected_value: files[path] }];
            }
            if (name === 'cardapp_rename_file') {
                const from = String(args.from_path || '');
                const to = String(args.to_path || '');
                const content = files[from];
                return [
                    { op: 'unset', path: bracketPath(from), expected_value: content },
                    { op: 'set', path: bracketPath(to), oldValue: undefined, newValue: content },
                ];
            }
            // read tools: control-classified, normalizer returns [] (no edits)
            return [];
        },

        buildSystemPrompt: (session) => buildCardAppStudioSystemPrompt(session, deps),
        buildUserPrompt: (session, userText, opts) => buildCardAppStudioUserPrompt(session, userText, opts),

        renderMessageCard: (message, _state) => {
            const escapeHtml = deps.escapeHtml || fallbackEscapeHtml;
            const role = String(message?.role || 'assistant');
            const summary = describeAppliedEdits(message?.appliedEdits || []);
            return `<div class="luker-studio-message luker-studio-message-${escapeHtml(role)}">
    <div class="luker-studio-message-body">${escapeHtml(message?.content || '')}</div>
    ${summary ? `<details class="luker-studio-message-edits"><summary>${escapeHtml(summary)}</summary></details>` : ''}
</div>`;
        },

        renderHistoryItem: (meta) => {
            const escapeHtml = deps.escapeHtml || fallbackEscapeHtml;
            const id = String(meta?.id || '');
            const title = String(meta?.title || meta?.id || '');
            return `<div class="luker-studio-history-item" data-iter-action="load-history" data-id="${escapeHtml(id)}">
    <div class="luker-studio-history-title">${escapeHtml(title)}</div>
    <div class="luker-studio-history-time">${escapeHtml(formatTime(meta?.updatedAt))}</div>
</div>`;
        },

        renderPreviewPane: (_state) => {
            const escapeHtml = deps.escapeHtml || fallbackEscapeHtml;
            const note = i18n('Live preview shows behind this popup. Use the reload button to refresh.');
            return `<div class="card-app-studio-pane">
    <div class="card-app-studio-file-tree" data-iter-slot="file-tree"></div>
    <div class="card-app-studio-editor-wrap" data-iter-slot="editor"></div>
    <div class="card-app-studio-preview-meta">${escapeHtml(note)}</div>
</div>`;
        },

        renderToolbarSlots: (_state) => {
            const escapeHtml = deps.escapeHtml || fallbackEscapeHtml;
            const label = i18n('Reload preview');
            return {
                end: `<button class="menu_button" data-iter-action="cardapp-reload-preview">${escapeHtml(label)}</button>`,
            };
        },

        handleAction: async (actionId, _ctx) => {
            if (actionId === 'cardapp-reload-preview') {
                if (typeof deps.reloadCardApp === 'function') deps.reloadCardApp();
                return;
            }
            // File-tree / editor wiring is mounted by studio.js bind code (Task 11).
        },
    });
}
