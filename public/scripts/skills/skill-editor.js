/**
 * Inline skill editor.
 *
 * Launched from the Skill Manager panel's "Edit" or "Create new" actions.
 * The popup body is a two-pane layout: a file tree on the left and a
 * <textarea>-based editor on the right. All persistence flows through
 * `context.skills.*`.
 *
 * Save semantics use writeFile + expectedSha256 optimistic locking. The
 * server's writeFile returns the new sha256 on success, which we cache so
 * subsequent saves continue to detect external mutations. SKILL.md gets a
 * client-side frontmatter shape check before save so the user sees an
 * inline error message instead of a 400 round-trip; the server still
 * validates fully on writeFile, so the client check is purely UX.
 *
 * v1 deliberately keeps the editor simple: plain styled textarea, no
 * markdown preview, no Codemirror, no monaco. Luker's character-editor-assistant
 * studio loads codemirror.bundle.js but only for scripted use; pulling that
 * here would mean async loading for a feature that just needs typing
 * + saving. We leave the upgrade path open (the textarea selector is the
 * only DOM coupling) — a richer editor can swap in later.
 *
 * File-delete: a per-file delete REST endpoint exists (DELETE
 * /api/skills/:scope/:name/file?path=...), exposed as
 * `context.skills.deleteFile`. We surface a "Delete" action per file in
 * the tree; SKILL.md is excluded (the server enforces this too).
 *
 * Inline-tested helpers are exported alongside `openSkillEditor`,
 * `openCreateNewSkillFlow` for the test suite (Luker's Jest runs in node
 * without jsdom, so we test the DOM rendering by parsing the produced
 * HTML strings into stub elements).
 */

import { ensureSkillI18n } from './i18n.js';
import { pickTargetScope as pickTargetScopeShared } from './scope-picker.js';

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Minimal client-side frontmatter shape check for SKILL.md. The server
 * still runs the canonical parseSkillFrontmatter on writeFile/install, so
 * this check exists purely to give the user immediate feedback instead of
 * a 400-round-trip. Returns `{ ok, name?, description?, error? }`.
 *
 * Mirrors src/skills/frontmatter-parser.js for the fields it inspects:
 *   - file must start with `---\n`
 *   - frontmatter block must close with `\n---`
 *   - `name:` value must match [a-z0-9_-]+ and be non-empty
 *   - `description:` value must be non-empty
 *
 * We do NOT parse arbitrary YAML — the regex extracts top-level scalars
 * for name/description, which is enough for the editor's pre-save check.
 *
 * @param {string} content
 * @returns {{ok: true, name: string, description: string} | {ok: false, error: string}}
 */
export function parseFrontmatterShape(content) {
    const text = String(content || '').replace(/\r\n/g, '\n');
    if (!text.startsWith('---\n')) {
        return { ok: false, error: 'SKILL.md must start with YAML frontmatter (---)' };
    }
    const rest = text.slice(4);
    const endIdx = rest.indexOf('\n---');
    if (endIdx === -1) {
        return { ok: false, error: 'SKILL.md frontmatter is not closed (---)' };
    }
    const block = rest.slice(0, endIdx);
    // Extract top-level scalar `name: foo` and `description: bar`.
    // Multi-line YAML values (folded/literal) are uncommon in SKILL.md and
    // fall through to ok=false here; the user can still save (server is
    // canonical) — but we want at minimum a string after the colon.
    const nameMatch = block.match(/^name:\s*(.+?)\s*$/m);
    const descMatch = block.match(/^description:\s*(.+?)\s*$/m);
    if (!nameMatch || !nameMatch[1]) {
        return { ok: false, error: 'SKILL.md frontmatter must include name' };
    }
    if (!descMatch || !descMatch[1]) {
        return { ok: false, error: 'SKILL.md frontmatter must include description' };
    }
    const name = String(nameMatch[1]).trim().replace(/^["']|["']$/g, '');
    const description = String(descMatch[1]).trim().replace(/^["']|["']$/g, '');
    if (!/^[a-z0-9_-]+$/.test(name)) {
        return { ok: false, error: 'SKILL.md name must match [a-z0-9_-]+' };
    }
    if (!description) {
        return { ok: false, error: 'SKILL.md frontmatter must include description' };
    }
    return { ok: true, name, description };
}

/**
 * Generate the initial SKILL.md template for a brand-new skill. Server
 * will re-validate via parseSkillFrontmatter on install; this template
 * matches the bundled-skill scaffold style.
 *
 * @param {string} name
 * @param {string} description
 * @returns {string}
 */
export function defaultSkillTemplate(name, description) {
    const safeName = String(name || 'new_skill').trim();
    const safeDesc = String(description || 'Describe what this skill does.').trim();
    return `---\nname: ${safeName}\ndescription: ${safeDesc}\n---\n\n# ${safeName}\n\n${safeDesc}\n\n## When to use\n\n- TODO\n\n## Steps\n\n1. TODO\n`;
}

/**
 * Validate a user-supplied path for a NEW file inside a skill. SKILL.md
 * is rejected so users can't accidentally overwrite the manifest with the
 * new-file flow (use the editor's tree click for SKILL.md).
 *
 * Mirrors the server's assertSafeFilePath regex so the user sees the
 * rejection client-side instead of round-tripping.
 *
 * @param {string} input
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function validateNewFilePath(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) return { ok: false, error: 'path required' };
    if (trimmed === 'SKILL.md') {
        return { ok: false, error: 'use the tree click to edit SKILL.md' };
    }
    if (trimmed.includes('..') || trimmed.startsWith('/')) {
        return { ok: false, error: 'illegal path' };
    }
    if (!/^[A-Za-z0-9._\-/]+$/.test(trimmed)) {
        return { ok: false, error: 'path may only contain letters, digits, ._-/' };
    }
    return { ok: true, path: trimmed };
}

/**
 * Render the file-tree pane for the editor popup body.
 *
 * @param {object} opts
 * @param {Array<{path:string, size:number, isBinary:boolean}>} opts.files
 * @param {string|null} opts.activePath - the currently-open file (highlighted)
 * @param {(s:string) => string} opts.t
 * @param {(s:string) => string} opts.esc
 */
export function buildFileTreeHtml({ files, activePath, t, esc }) {
    const list = Array.isArray(files) ? files : [];
    const rows = list.map(f => {
        const active = (f.path === activePath) ? ' data-file-active="true"' : '';
        const binBadge = f.isBinary
            ? ` <span class="luker_skill_editor_binary">${esc(t('binary'))}</span>`
            : '';
        // SKILL.md is excluded from rename + delete: the server refuses
        // both (would orphan / bypass the manifest), so we hide the
        // buttons rather than offer an action that always errors. Other
        // files get a small action row that's always visible — hover-only
        // hid them entirely on touch devices and at first glance.
        const editable = f.path !== 'SKILL.md';
        const actions = editable
            ? `<span class="luker_skill_editor_file_actions">
                <span class="luker_skill_editor_file_action luker_skill_editor_file_rename"
                      data-editor-action="rename-file"
                      data-file-path="${esc(f.path)}"
                      title="${esc(t('Rename file'))}">✎</span>
                <span class="luker_skill_editor_file_action luker_skill_editor_file_delete"
                      data-editor-action="delete-file"
                      data-file-path="${esc(f.path)}"
                      title="${esc(t('Delete file'))}">×</span>
            </span>`
            : '';
        return `<div class="luker_skill_editor_file" data-file-path="${esc(f.path)}"${active}>
            <span class="luker_skill_editor_file_name">${esc(f.path)}${binBadge}</span>
            ${actions}
        </div>`;
    }).join('');
    const empty = list.length === 0
        ? `<div class="luker_skill_editor_empty">${esc(t('(no files)'))}</div>`
        : '';
    return `
<div class="luker_skill_editor_tree">
    <div class="luker_skill_editor_tree_header">
        <span>${esc(t('Files'))}</span>
        <span class="menu_button menu_button_small" data-editor-action="new-file">${esc(t('+ New file'))}</span>
    </div>
    <div class="luker_skill_editor_tree_body">
        ${empty}${rows}
    </div>
</div>
    `;
}

/**
 * Render the right-pane editor for the selected file.
 *
 * @param {object} opts
 * @param {string} opts.content
 * @param {string|null} opts.path - currently-open file, or null for empty state
 * @param {string} opts.sha256 - last-known sha256 of the file on disk
 * @param {(s:string) => string} opts.t
 * @param {(s:string) => string} opts.esc
 */
export function buildEditorHtml({ content, path, sha256, t, esc }) {
    if (!path) {
        return `<div class="luker_skill_editor_pane luker_skill_editor_empty">
            <span>${esc(t('Select a file to edit, or click + New file.'))}</span>
        </div>`;
    }
    // Encode the textarea body — same as Luker's other text-area renderings.
    // The sha256 is parked on a hidden data attribute so we can read it back
    // on save without juggling extra closures.
    const body = String(content || '');
    return `
<div class="luker_skill_editor_pane">
    <div class="luker_skill_editor_pane_header">
        <span class="luker_skill_editor_pane_path">${esc(path)}</span>
        <span class="luker_skill_editor_pane_sha" data-editor-sha="${esc(sha256 || '')}" data-editor-path="${esc(path)}"></span>
        <span class="menu_button menu_button_small" data-editor-save>${esc(t('Save'))}</span>
    </div>
    <textarea
        class="text_pole luker_skill_editor_textarea"
        data-editor-textarea
        spellcheck="false">${esc(body)}</textarea>
    <div class="luker_skill_editor_pane_footer">
        <span class="luker_skill_editor_hint">${esc(t('Ctrl/Cmd+S to save'))}</span>
        <span class="luker_skill_editor_validate" data-editor-validate></span>
    </div>
</div>
    `;
}

// ── Interactive entry points ──────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
})[c]);

function toast(message, level) {
    if (typeof toastr === 'undefined') {
        console.warn('[skill-editor]', message);
        return;
    }
    if (level === 'error') toastr.error(String(message));
    else if (level === 'success') toastr.success(String(message));
    else toastr.info(String(message));
}

function isAffirmative(result) {
    return result === 1 || result === true;
}

function formatScopeLabel(scope, t = (s) => s) {
    if (!scope || typeof scope !== 'object') return t('unknown');
    switch (scope.kind) {
        case 'global': return t('global');
        case 'preset': return `${t('preset')}: ${scope.name}`;
        case 'character': return `${t('character')}: ${scope.characterFile}`;
        default: return t('unknown');
    }
}

/**
 * Open the inline editor for an existing skill.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (skills, popup, etc.)
 * @param {object} opts.scope
 * @param {string} opts.name - skill name
 * @param {(s:string) => string} [opts.t]
 * @param {() => void} [opts.onChange] - invoked after each successful save
 *   so the parent panel can refresh its list (e.g. updated description).
 * @returns {Promise<void>}
 */
export async function openSkillEditor({ context, scope, name, t = (s) => s, onChange } = {}) {
    if (!context || !context.skills) {
        throw new Error('openSkillEditor: context.skills missing');
    }
    ensureSkillI18n();

    const state = {
        files: [],
        activePath: null,
        sha256: '',
        mountId: `luker_skill_editor_${Date.now()}`,
    };

    const initialHtml = `<div id="${state.mountId}"></div>`;
    const title = `${t('Edit skill')}: ${name} (${formatScopeLabel(scope, t)})`;
    const popupPromise = context.callGenericPopup(initialHtml, context.POPUP_TYPE.TEXT, title, {
        okButton: t('Close'),
        wide: true,
        wider: true,
        large: true,
        allowVerticalScrolling: true,
    });

    function render() {
        const mount = document.getElementById(state.mountId);
        if (!mount) return;
        // Two-pane layout — the luker-studio root class lets the design
        // tokens cascade in (sidebar tree + large editor pane).
        mount.innerHTML = `
<div class="luker_skill_editor luker-studio">
    ${buildFileTreeHtml({ files: state.files, activePath: state.activePath, t, esc })}
    ${buildEditorHtml({ content: state.currentContent || '', path: state.activePath, sha256: state.sha256, t, esc })}
</div>
        `;
        bindEvents(mount);
    }

    async function refreshFiles() {
        try {
            const r = await context.skills.listFiles({ scope, name });
            state.files = Array.isArray(r?.files) ? r.files : [];
        } catch (e) {
            state.files = [];
            toast(t('Failed to list files: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function loadFile(path) {
        try {
            const r = await context.skills.readFile({ scope, name, path });
            state.activePath = path;
            state.currentContent = r?.content || '';
            state.sha256 = r?.sha256 || '';
        } catch (e) {
            toast(t('Failed to read ${0}: ${1}')
                .replace('${0}', path)
                .replace('${1}', e?.message || String(e)), 'error');
        }
    }

    async function saveActive(mount) {
        if (!state.activePath) return;
        const textarea = mount.querySelector('[data-editor-textarea]');
        if (!textarea) return;
        const content = String(textarea.value || '');

        // Client-side frontmatter check for SKILL.md. The server validates
        // canonically; this is purely a fast-fail for the user.
        if (state.activePath === 'SKILL.md') {
            const check = parseFrontmatterShape(content);
            if (!check.ok) {
                toast(t('Cannot save: ${0}').replace('${0}', check.error), 'error');
                return;
            }
        }

        try {
            const r = await context.skills.writeFile({
                scope,
                name,
                path: state.activePath,
                content,
                expectedSha256: state.sha256 || undefined,
            });
            state.sha256 = r?.sha256 || state.sha256;
            state.currentContent = content;
            toast(t('Saved ${0}').replace('${0}', state.activePath), 'success');
            // Refresh the parent panel so updated description / new files
            // become visible without manual reload.
            if (typeof onChange === 'function') {
                try { onChange(); } catch { /* swallow */ }
            }
        } catch (e) {
            const msg = e?.message || String(e);
            if (/sha256|mismatch/i.test(msg)) {
                toast(t('File changed on disk (sha256 mismatch). Close and reopen to reload.'), 'error');
            } else {
                toast(t('Save failed: ${0}').replace('${0}', msg), 'error');
            }
        }
    }

    async function createNewFile(mount) {
        const input = await context.callGenericPopup(
            t('New file path (relative to skill root, e.g. references/notes.md):'),
            context.POPUP_TYPE.INPUT,
            '',
            { okButton: t('Create'), cancelButton: t('Cancel') },
        );
        if (!input || typeof input !== 'string') return;
        const check = validateNewFilePath(input);
        if (!check.ok) {
            toast(t('Cannot create: ${0}').replace('${0}', check.error), 'error');
            return;
        }
        try {
            await context.skills.writeFile({
                scope,
                name,
                path: check.path,
                content: '',
            });
            toast(t('Created ${0}').replace('${0}', check.path), 'success');
            await refreshFiles();
            await loadFile(check.path);
            render();
            if (typeof onChange === 'function') {
                try { onChange(); } catch { /* swallow */ }
            }
        } catch (e) {
            toast(t('Create failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
        // Re-render either way (active path may have changed)
        if (mount) render();
    }

    async function deleteFile(path) {
        if (path === 'SKILL.md') {
            toast(t('Cannot delete SKILL.md from the editor — delete the whole skill from the manager.'), 'error');
            return;
        }
        const ok = await context.callGenericPopup(
            t('Delete file "${0}"? This cannot be undone.').replace('${0}', path),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: t('Delete'), cancelButton: t('Cancel') },
        );
        if (!isAffirmative(ok)) return;
        try {
            await context.skills.deleteFile({ scope, name, path });
            toast(t('Deleted ${0}').replace('${0}', path), 'success');
            // If the deleted file was active, fall back to SKILL.md.
            if (state.activePath === path) {
                state.activePath = 'SKILL.md';
                await loadFile('SKILL.md');
            }
            await refreshFiles();
            render();
            if (typeof onChange === 'function') {
                try { onChange(); } catch { /* swallow */ }
            }
        } catch (e) {
            toast(t('Delete failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function renameFile(path) {
        if (path === 'SKILL.md') {
            toast(t('Cannot rename SKILL.md from the editor — rename the whole skill from the manager.'), 'error');
            return;
        }
        const input = await context.callGenericPopup(
            t('Rename file "${0}" to:').replace('${0}', path),
            context.POPUP_TYPE.INPUT,
            path,
            { okButton: t('Rename'), cancelButton: t('Cancel') },
        );
        if (!input || typeof input !== 'string') return;
        const check = validateNewFilePath(input);
        if (!check.ok) {
            toast(t('Cannot rename: ${0}').replace('${0}', check.error), 'error');
            return;
        }
        if (check.path === path) return; // No-op
        try {
            const r = await context.skills.renameFile({
                scope, name, fromPath: path, toPath: check.path,
            });
            toast(t('Renamed: ${0} -> ${1}')
                .replace('${0}', path)
                .replace('${1}', check.path), 'success');
            // If the renamed file was active, follow it.
            if (state.activePath === path) {
                state.activePath = check.path;
                state.sha256 = r?.sha256 || '';
            }
            await refreshFiles();
            render();
            if (typeof onChange === 'function') {
                try { onChange(); } catch { /* swallow */ }
            }
        } catch (e) {
            toast(t('Rename failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    function bindEvents(root) {
        // File-tree clicks: open file in editor (but not the action buttons).
        root.querySelectorAll('[data-file-path]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const path = el.getAttribute('data-file-path');
                if (!path) return;
                // If user clicked an inline action glyph, let its own
                // listener handle it instead of opening the file.
                if (ev.target && ev.target.getAttribute) {
                    const act = ev.target.getAttribute('data-editor-action');
                    if (act === 'delete-file' || act === 'rename-file') return;
                }
                if (path === state.activePath) return;
                await loadFile(path);
                render();
            });
        });

        // Per-file delete glyph.
        root.querySelectorAll('[data-editor-action="delete-file"]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const row = el.closest('[data-file-path]');
                if (!row) return;
                const path = row.getAttribute('data-file-path');
                await deleteFile(path);
            });
        });

        // Per-file rename glyph.
        root.querySelectorAll('[data-editor-action="rename-file"]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                // The glyph itself carries data-file-path so we don't have
                // to walk up — the .closest('[data-file-path]') ancestor
                // would resolve to the row, which also works. Use the
                // glyph's own attribute to keep the contract explicit.
                const path = el.getAttribute('data-file-path')
                    || el.closest('[data-file-path]')?.getAttribute('data-file-path');
                if (!path) return;
                await renameFile(path);
            });
        });

        // "+ New file"
        const newFileBtn = root.querySelector('[data-editor-action="new-file"]');
        if (newFileBtn) {
            newFileBtn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                await createNewFile(root);
            });
        }

        // Save
        const saveBtn = root.querySelector('[data-editor-save]');
        if (saveBtn) {
            saveBtn.addEventListener('click', async (ev) => {
                ev.preventDefault();
                await saveActive(root);
            });
        }

        // Ctrl/Cmd+S
        const textarea = root.querySelector('[data-editor-textarea]');
        if (textarea) {
            textarea.addEventListener('keydown', async (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.code === 'KeyS')) {
                    if (ev.preventDefault) ev.preventDefault();
                    await saveActive(root);
                }
            });
        }
    }

    // Kick off initial render. SKILL.md is always present on existing skills,
    // so we eagerly open it.
    Promise.resolve().then(async () => {
        await refreshFiles();
        // Default-open SKILL.md if present, else first available file.
        const first = state.files.find(f => f.path === 'SKILL.md') || state.files[0];
        if (first) await loadFile(first.path);
        render();
    });

    await popupPromise;
}

/**
 * Reusable scope picker — delegates to the shared scope-picker module so
 * the create-new-skill flow uses the same dropdowns + show/hide logic as
 * the manager panel's "Move to" dialog.
 */
async function pickTargetScope(context, t, title, suggestScope) {
    return pickTargetScopeShared(context, t, title, suggestScope);
}

/**
 * Walk a user through creating a brand-new skill: prompt name → description
 * → scope, install the template via context.skills.install, then optionally
 * open the editor on the new skill.
 *
 * @param {object} opts
 * @param {object} opts.context
 * @param {(s:string) => string} [opts.t]
 * @param {() => void} [opts.onChange] - parent-panel refresh hook
 * @returns {Promise<{scope: object, name: string} | null>}
 */
export async function openCreateNewSkillFlow({ context, t = (s) => s, onChange } = {}) {
    if (!context || !context.skills) {
        throw new Error('openCreateNewSkillFlow: context.skills missing');
    }
    ensureSkillI18n();

    const nameInput = await context.callGenericPopup(
        t('Skill name (lowercase letters/digits/_/-):'),
        context.POPUP_TYPE.INPUT,
        '',
        { okButton: t('Next'), cancelButton: t('Cancel') },
    );
    if (!nameInput || typeof nameInput !== 'string') return null;
    const name = String(nameInput).trim();
    if (!/^[a-z0-9_-]+$/.test(name)) {
        toast(t('Invalid skill name: must match [a-z0-9_-]+'), 'error');
        return null;
    }

    const descInput = await context.callGenericPopup(
        t('One-line description (when should this skill be used?):'),
        context.POPUP_TYPE.INPUT,
        '',
        { okButton: t('Next'), cancelButton: t('Cancel') },
    );
    if (!descInput || typeof descInput !== 'string') return null;
    const description = String(descInput).trim();
    if (!description) {
        toast(t('Description is required.'), 'error');
        return null;
    }

    const scope = await pickTargetScope(context, t, t('Install new skill into scope:'));
    if (!scope) return null;

    const payload = {
        files: [{
            path: 'SKILL.md',
            encoding: 'utf8',
            content: defaultSkillTemplate(name, description),
        }],
    };
    try {
        await context.skills.install({ scope, payload });
        toast(t('Created skill: ${0}').replace('${0}', name), 'success');
        if (typeof onChange === 'function') {
            try { onChange(); } catch { /* swallow */ }
        }
        // Open the editor on the freshly-created skill so the user can
        // expand on the template immediately. Fire-and-forget — we don't
        // gate this function on the editor popup's lifetime; the caller
        // (e.g. the skill manager) has already moved on. Errors inside the
        // editor surface as toasts anyway.
        void openSkillEditor({ context, scope, name, t, onChange });
        return { scope, name };
    } catch (e) {
        toast(t('Create failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        return null;
    }
}
