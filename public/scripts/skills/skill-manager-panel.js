/**
 * Skill manager subpanel.
 *
 * A popup launched from the orchestrator config that lists installed skills
 * across all three scopes (global, preset, character), grouped by scope, with
 * per-row actions (View, Edit, Move to, Rename, Delete) plus a top toolbar
 * for import operations (bundled, file, URL) and create-new.
 *
 * All write paths flow through `context.skills.*` — the JS API. The panel
 * never touches `fetch` directly; this keeps the CSRF / auth concerns
 * centralized in the JS API and lets the skill-resolution cache invalidate
 * uniformly via the REST layer.
 *
 * Inline-tested helpers are exported for use by the test suite without
 * needing a DOM (Luker's Jest config runs in node, not jsdom). The
 * interactive `openSkillManagerPanel` entry point is exported for use by
 * orchestrator's main.js.
 *
 * Edit + Create-new wire through to `openSkillEditor` / `openCreateNewSkillFlow`
 * from skill-editor.js. Editor's `onChange` callback refreshes the manager
 * so updated descriptions / new skills show up without reload.
 */

import { openSkillEditor, openCreateNewSkillFlow } from './skill-editor.js';
import { renderBundledBrowser, describeBundledImportResult } from './bundled-browser.js';
import { ensureSkillI18n } from './i18n.js';
import { pickTargetScope as pickTargetScopeImpl } from './scope-picker.js';

// ── Pure helpers (exported for tests) ─────────────────────────────────────

/**
 * Format a SkillScope object as a short user-facing label.
 * Mirrors `src/skills/scope.js` scopeLabel — duplicated here to avoid
 * pulling node-only modules into the browser bundle.
 *
 * @param {object} scope
 * @returns {string}
 */
export function formatScopeLabel(scope, t = (s) => s) {
    if (!scope || typeof scope !== 'object') return t('unknown');
    switch (scope.kind) {
        case 'global': return t('global');
        case 'preset': return `${t('preset')}: ${scope.name}`;
        case 'character': return `${t('character')}: ${scope.characterFile}`;
        default: return t('unknown');
    }
}

/**
 * Compare two scopes for equality. Used for collision detection and to
 * shortcut a no-op move-scope.
 *
 * @param {object} a
 * @param {object} b
 */
export function scopesEqual(a, b) {
    if (!a || !b) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'global') return true;
    if (a.kind === 'preset') return a.name === b.name;
    if (a.kind === 'character') return a.characterFile === b.characterFile;
    return false;
}

/**
 * Stable JSON-string key for a scope. Lets us group skills via Map keys.
 *
 * @param {object} scope
 * @returns {string}
 */
export function scopeKey(scope) {
    if (!scope || typeof scope !== 'object') return '';
    switch (scope.kind) {
        case 'global': return 'global';
        case 'preset': return `preset/${scope.name}`;
        case 'character': return `character/${scope.characterFile}`;
        default: return '';
    }
}

/**
 * Group a flat skill-index list into ordered groups keyed by scope, in the
 * order: global → preset → character. Within each kind, alphabetize the
 * sub-keys (preset name, character file). Within a group, skills are
 * sorted by name.
 *
 * @param {Array} skills - flat list as returned by `context.skills.list({scope:'all'})`
 * @returns {Array<{scope: object, label: string, skills: Array}>}
 */
export function groupSkillsByScope(skills) {
    const groups = new Map();
    for (const s of Array.isArray(skills) ? skills : []) {
        if (!s || !s.scope) continue;
        const key = scopeKey(s.scope);
        if (!key) continue;
        if (!groups.has(key)) {
            groups.set(key, { scope: s.scope, label: formatScopeLabel(s.scope), skills: [] });
        }
        groups.get(key).skills.push(s);
    }
    // Within each group, sort skills by name.
    for (const g of groups.values()) {
        g.skills.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    // Sort groups by kind priority then by key.
    const kindOrder = { global: 0, preset: 1, character: 2 };
    return Array.from(groups.values()).sort((a, b) => {
        const ka = kindOrder[a.scope.kind] ?? 99;
        const kb = kindOrder[b.scope.kind] ?? 99;
        if (ka !== kb) return ka - kb;
        return scopeKey(a.scope).localeCompare(scopeKey(b.scope));
    });
}

/**
 * Filter a grouped list by an optional scope filter. The filter is either
 * the sentinel `'all'`, a stringified scope key, or a SkillScope object.
 *
 * @param {Array} groups - output of groupSkillsByScope
 * @param {'all'|string|object} filter
 * @returns {Array}
 */
export function filterGroups(groups, filter) {
    if (!filter || filter === 'all') return groups;
    const key = typeof filter === 'string' ? filter : scopeKey(filter);
    if (!key) return groups;
    return groups.filter(g => scopeKey(g.scope) === key);
}

/**
 * Detect the import payload shape from a filename + raw bytes (string or
 * Uint8Array). Used by "Import from file..." to decide whether to wrap the
 * bytes as an archive-base64-v1 item or parse as a full embed payload JSON.
 *
 * Returns one of:
 *   - `{ kind: 'embed-json', payload }` — the file is a parsed embed payload
 *     already (e.g. a `.json` file with `{ version: 1, items: [...] }`).
 *   - `{ kind: 'archive', defaultName, contentBase64 }` — the file is a zip
 *     bundle; caller must wrap into a single-item embed payload.
 *   - `{ kind: 'unknown', reason }` — could not classify.
 *
 * Caller is responsible for sha256 computation; the panel passes that on to
 * the server which verifies during materialize.
 *
 * @param {string} filename
 * @param {Uint8Array|ArrayBuffer|string} bytes
 * @returns {{kind:'embed-json',payload:object}|{kind:'archive',defaultName:string,contentBase64:string}|{kind:'unknown',reason:string}}
 */
export function inferImportFormat(filename, bytes) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    if (ext === 'json') {
        try {
            const text = typeof bytes === 'string'
                ? bytes
                : new TextDecoder('utf-8').decode(bytes);
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.items)) {
                return { kind: 'embed-json', payload: parsed };
            }
            return { kind: 'unknown', reason: 'JSON missing { version: 1, items: [...] }' };
        } catch (e) {
            return { kind: 'unknown', reason: `invalid JSON: ${e.message}` };
        }
    }
    if (ext === 'zip') {
        // Strip extension for the default skill name; server-side materialize
        // overrides this from the SKILL.md frontmatter anyway, so the value
        // here only shows up in conflict-preview UI.
        const base = String(filename || '').replace(/\.zip$/i, '') || 'imported';
        const defaultName = base.replace(/[^A-Za-z0-9._-]/g, '-');
        const contentBase64 = encodeBase64(bytes);
        return { kind: 'archive', defaultName, contentBase64 };
    }
    return { kind: 'unknown', reason: `unsupported file extension: ${ext}` };
}

/**
 * Build an embed payload wrapping a single archive item. Used after
 * `inferImportFormat` returns 'archive' so the panel can hand it to
 * `executeExtractEmbed` (which handles archive-base64-v1 + sha256).
 *
 * @param {string} name
 * @param {string} contentBase64
 * @param {string} [sha256]
 * @returns {{version:1, items:Array}}
 */
export function buildArchiveEmbedPayload(name, contentBase64, sha256) {
    const item = {
        bundleFormat: 'archive-base64-v1',
        name: String(name || 'imported'),
        contentBase64: String(contentBase64 || ''),
    };
    if (sha256) item.sha256 = String(sha256);
    return { version: 1, items: [item] };
}

/**
 * Base64-encode bytes from any reasonable input shape. Browsers don't have
 * a built-in Uint8Array → base64 path (`btoa` only takes strings); we walk
 * the bytes 32KB at a time to avoid blowing the stack on large archives.
 *
 * The Node fallback exists only to support unit tests; production code
 * runs under `public/` where `btoa` is always defined.
 *
 * @param {Uint8Array|ArrayBuffer|string} input
 * @returns {string}
 */
export function encodeBase64(input) {
    const NodeBuffer = typeof globalThis !== 'undefined' ? globalThis.Buffer : undefined;
    if (typeof input === 'string') {
        if (typeof btoa === 'function') return btoa(input);
        return NodeBuffer.from(input, 'binary').toString('base64');
    }
    const bytes = input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
    if (typeof btoa === 'function') {
        let out = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
            out += String.fromCharCode(...slice);
        }
        return btoa(out);
    }
    return NodeBuffer.from(bytes).toString('base64');
}

/**
 * Detect a rename collision: would renaming a skill to `newName` in
 * `scope` overwrite an existing skill?
 *
 * @param {Array} skills - flat skill-index list
 * @param {object} scope
 * @param {string} oldName - the skill currently being renamed
 * @param {string} newName - the desired new name
 * @returns {boolean}
 */
export function hasRenameCollision(skills, scope, oldName, newName) {
    if (!newName || newName === oldName) return false;
    return Array.isArray(skills) && skills.some(s =>
        s && s.name === newName && scopesEqual(s.scope, scope),
    );
}

/**
 * Detect a move-scope collision: would moving a skill into `toScope`
 * overwrite an existing skill of the same name there?
 *
 * @param {Array} skills - flat skill-index list
 * @param {string} name
 * @param {object} fromScope
 * @param {object} toScope
 * @returns {boolean}
 */
export function hasMoveScopeCollision(skills, name, fromScope, toScope) {
    if (scopesEqual(fromScope, toScope)) return false;
    return Array.isArray(skills) && skills.some(s =>
        s && s.name === name && scopesEqual(s.scope, toScope),
    );
}

/**
 * Build the panel's main HTML body from a grouped + filtered list. The
 * caller wires events via delegation on the root container.
 *
 * The tab strip (Installed / Browse bundled) is always rendered so users can
 * see what's available even when the chosen tab body is empty. The bundled
 * tab is rendered by `bundled-browser.js` into the same body container.
 *
 * @param {Array} groups - filterGroups(groupSkillsByScope(...), filter)
 * @param {Array} allScopes - list of scopes that appear anywhere in the
 *   inventory (used to populate the filter dropdown)
 * @param {string} selectedFilterKey - currently-selected filter ('all' or
 *   a scope key)
 * @param {'installed'|'bundled'} activeTab
 * @param {(s: string) => string} t - i18n helper
 * @param {(s: string) => string} esc - html-escape helper
 * @returns {string}
 */
export function buildPanelHtml(groups, allScopes, selectedFilterKey, activeTab, t, esc) {
    const filterOptions = [
        `<option value="all"${selectedFilterKey === 'all' ? ' selected' : ''}>${esc(t('All scopes'))}</option>`,
        ...allScopes.map(s => {
            const key = scopeKey(s);
            return `<option value="${esc(key)}"${selectedFilterKey === key ? ' selected' : ''}>${esc(formatScopeLabel(s, t))}</option>`;
        }),
    ].join('');

    const scopeBadge = (scope) => {
        const kind = scope?.kind || 'unknown';
        const kindClass = `luker_skill_scope_badge_${esc(kind)}`;
        const kindName = esc(t(kind === 'global' ? 'Global' : kind === 'preset' ? 'Preset' : 'Character'));
        // For preset / character scopes the second segment carries the
        // identifying detail (preset name or character file). Global has no
        // sub-identifier, so the badge stops at the kind name — rendering
        // "Global · Global" would just be redundant noise.
        const kindLabel = kind === 'preset'
            ? esc(scope.name || '?')
            : kind === 'character'
                ? esc(scope.characterFile || '?')
                : null;
        const tail = kindLabel
            ? `<span class="luker_skill_scope_badge_sep">·</span><span class="luker_skill_scope_badge_id">${kindLabel}</span>`
            : '';
        return `<span class="luker_skill_scope_badge ${kindClass}" title="${esc(formatScopeLabel(scope, t))}">
            <span class="luker_skill_scope_badge_kind">${kindName}</span>
            ${tail}
        </span>`;
    };

    const renderRow = (skill) => {
        const scopeStr = JSON.stringify(skill.scope);
        const fileLabel = t('${0} files').replace('${0}', String(skill.fileCount ?? 0));
        return `
            <div class="luker_skill_row" data-skill-name="${esc(skill.name)}" data-skill-scope="${esc(scopeStr)}">
                <div class="luker_skill_row_main">
                    <div class="luker_skill_row_head">
                        <div class="luker_skill_row_name" title="${esc(skill.name)}">${esc(skill.name)}</div>
                        <div class="luker_skill_row_meta">
                            <span class="luker_skill_meta_chip">${esc(fileLabel)}</span>
                            ${skill.hasScripts ? `<span class="luker_skill_meta_chip luker_skill_meta_chip_warn" title="${esc(t('has scripts'))}">${esc(t('has scripts'))}</span>` : ''}
                            ${skill.hasBinary ? `<span class="luker_skill_meta_chip" title="${esc(t('binary'))}">${esc(t('binary'))}</span>` : ''}
                        </div>
                    </div>
                    <div class="luker_skill_row_desc">${esc(skill.description || t('(no description)'))}</div>
                </div>
                <div class="luker_skill_row_actions">
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="view" title="${esc(t('View'))}">${esc(t('View'))}</div>
                        <div class="menu_button menu_button_small luker_skill_row_btn luker_skill_row_btn_primary" data-skill-action="edit" title="${esc(t('Edit'))}">${esc(t('Edit'))}</div>
                    </div>
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="move" title="${esc(t('Move to...'))}">${esc(t('Move to...'))}</div>
                        <div class="menu_button menu_button_small luker_skill_row_btn" data-skill-action="rename" title="${esc(t('Rename'))}">${esc(t('Rename'))}</div>
                    </div>
                    <div class="luker_skill_row_actions_group">
                        <div class="menu_button menu_button_small luker_skill_row_btn luker_skill_row_btn_danger luker_skill_row_delete" data-skill-action="delete" title="${esc(t('Delete'))}">${esc(t('Delete'))}</div>
                    </div>
                </div>
            </div>
        `;
    };

    const renderGroup = (g) => `
        <section class="luker_skill_group" data-scope-key="${esc(scopeKey(g.scope))}">
            <header class="luker_skill_group_header">
                ${scopeBadge(g.scope)}
                <span class="luker_skill_group_count">${esc(t('${0} skills').replace('${0}', String(g.skills.length)))}</span>
            </header>
            <div class="luker_skill_group_rows">
                ${g.skills.length === 0
        ? `<div class="luker_skill_empty">${esc(t('(no skills in this scope)'))}</div>`
        : g.skills.map(renderRow).join('')}
            </div>
        </section>
    `;

    const installedBody = groups.length === 0
        ? `<div class="luker_skill_empty luker_skill_empty_root">
              <div class="luker_skill_empty_title">${esc(t('No skills installed yet.'))}</div>
              <div class="luker_skill_empty_hint">${esc(t('Use Import or Create to add some.'))}</div>
           </div>`
        : groups.map(renderGroup).join('');

    const installedActive = activeTab !== 'bundled';
    const tabStrip = `
        <div class="luker_skill_manager_tabs" role="tablist">
            <div class="luker_skill_tab${installedActive ? ' luker_skill_tab_active' : ''}" data-skill-tab="installed" role="tab">${esc(t('Installed'))}</div>
            <div class="luker_skill_tab${installedActive ? '' : ' luker_skill_tab_active'}" data-skill-tab="bundled" role="tab">${esc(t('Browse bundled'))}</div>
        </div>
    `;

    // For the bundled tab, leave an empty mount that renderBundledBrowser
    // paints into asynchronously — keeps buildPanelHtml synchronous and
    // unit-testable while still supporting the live tab.
    const bundledMount = '<div class="luker_skill_manager_bundled_mount"></div>';

    const tabBody = installedActive
        ? `
    <div class="luker_skill_manager_toolbar">
        <label class="luker_skill_filter_label">
            <span class="luker_skill_filter_label_text">${esc(t('Filter by scope:'))}</span>
            <select class="text_pole luker_skill_filter_select" data-skill-filter>${filterOptions}</select>
        </label>
        <div class="luker_skill_manager_toolbar_actions">
            <div class="luker_skill_toolbar_group">
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="import-bundled" title="${esc(t('Import bundled'))}">${esc(t('Import bundled'))}</div>
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="import-file" title="${esc(t('Import from file...'))}">${esc(t('Import from file...'))}</div>
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="import-url" title="${esc(t('Import from URL...'))}">${esc(t('Import from URL...'))}</div>
            </div>
            <div class="luker_skill_toolbar_group">
                <div class="menu_button menu_button_small luker_skill_toolbar_btn luker_skill_toolbar_btn_primary" data-skill-toolbar="create" title="${esc(t('Create new'))}">${esc(t('Create new'))}</div>
                <div class="menu_button menu_button_small luker_skill_toolbar_btn" data-skill-toolbar="refresh" title="${esc(t('Refresh'))}">${esc(t('Refresh'))}</div>
            </div>
        </div>
    </div>
    <div class="luker_skill_manager_body">${installedBody}</div>
        `
        : bundledMount;

    return `
<div class="luker_skill_manager luker-studio">
    ${tabStrip}
    ${tabBody}
</div>
    `;
}

// ── Interactive popup entry point ─────────────────────────────────────────

/**
 * Open the Skill Manager popup. Resolves once the user closes the popup.
 *
 * @param {object} opts
 * @param {object} opts.context - SillyTavern context (must expose
 *   `context.skills`, `context.callGenericPopup`, `context.POPUP_TYPE`,
 *   `context.POPUP_RESULT`).
 * @param {object|null} [opts.initialScope] - if provided, seed the scope
 *   filter to this scope (e.g. when launching from the Preset Assistant
 *   "Bundle skills with this preset" link the panel opens already filtered
 *   to the current preset). Pass null or omit for default 'all'.
 * @param {'installed'|'bundled'} [opts.initialTab='installed'] - which tab to
 *   show first. Pass 'bundled' to land directly on the bundled browser.
 * @param {(s: string) => string} [opts.t] - i18n helper; defaults to identity.
 * @returns {Promise<void>}
 */
export async function openSkillManagerPanel({ context, initialScope = null, initialTab = 'installed', t = (s) => s } = {}) {
    if (!context || !context.skills) {
        throw new Error('openSkillManagerPanel: context.skills missing');
    }
    // Self-register Skills UI translations so any caller (orchestrator,
    // completion-preset-assistant, future extensions) gets zh-CN / zh-TW
    // strings without having to copy our locale table into their own setup.
    ensureSkillI18n();
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    })[c]);

    const state = {
        skills: [],
        filterKey: initialScope ? scopeKey(initialScope) : 'all',
        tab: initialTab === 'bundled' ? 'bundled' : 'installed',
        mountId: `luker_skill_manager_${Date.now()}`,
    };

    // Defer DOM ops until after the popup mounts. The popup body uses a
    // unique id we paint into the initial HTML; we re-render into that
    // element on every refresh().
    const initialHtml = `<div id="${state.mountId}"></div>`;
    const popupPromise = context.callGenericPopup(initialHtml, context.POPUP_TYPE.TEXT, t('Skill Manager'), {
        okButton: t('Close'),
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    /**
     * Re-fetch the inventory and re-render the panel body. Errors surface as
     * a toast — the panel stays open so the user can retry.
     *
     * When `state.tab === 'bundled'`, the body is handed off to
     * `renderBundledBrowser` which manages its own data fetches; we still
     * render the tab strip first so the user can switch back. We always fetch
     * the installed list anyway because the filter dropdown needs the live
     * scope set even on the bundled tab.
     */
    async function refresh() {
        const mount = document.getElementById(state.mountId);
        if (!mount) return;
        try {
            const skills = await context.skills.list({ scope: 'all' });
            state.skills = Array.isArray(skills) ? skills : [];
        } catch (e) {
            state.skills = [];
            toast(t('Failed to load skills: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
        const grouped = groupSkillsByScope(state.skills);
        const allScopes = dedupeScopes(state.skills.map(s => s.scope));
        // If filterKey points at a scope that's currently empty (e.g. CPA
        // opened the manager for a brand-new preset that has no skills yet),
        // the dropdown can't render the scope as selected and the body would
        // appear blank. Fall back to 'all' so the user sees something.
        if (state.filterKey !== 'all' && !allScopes.some(s => scopeKey(s) === state.filterKey)) {
            state.filterKey = 'all';
        }
        const filtered = filterGroups(grouped, state.filterKey);
        mount.innerHTML = buildPanelHtml(filtered, allScopes, state.filterKey, state.tab, t, esc);
        bindEvents(mount);
        if (state.tab === 'bundled') {
            const bundledMount = mount.querySelector('.luker_skill_manager_bundled_mount');
            if (bundledMount) {
                try {
                    await renderBundledBrowser({ context, mount: bundledMount, t });
                } catch (e) {
                    toast(t('Failed to render bundled browser: ${0}').replace('${0}', e?.message || String(e)), 'error');
                }
            }
        }
    }

    function bindEvents(root) {
        // Tab switching always available; the per-tab toolbar bindings below
        // are no-ops when their elements aren't in the current DOM.
        root.querySelectorAll('[data-skill-tab]').forEach((el) => {
            el.addEventListener('click', (ev) => {
                ev.preventDefault();
                const next = el.getAttribute('data-skill-tab');
                if (next !== 'installed' && next !== 'bundled') return;
                if (state.tab === next) return;
                state.tab = next;
                void refresh();
            });
        });

        const filterSelect = root.querySelector('[data-skill-filter]');
        if (filterSelect) {
            filterSelect.addEventListener('change', () => {
                state.filterKey = String(filterSelect.value || 'all');
                void refresh();
            });
        }

        root.querySelectorAll('[data-skill-toolbar]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const action = el.getAttribute('data-skill-toolbar');
                if (action === 'import-bundled') {
                    await handleImportBundled();
                } else if (action === 'import-file') {
                    await handleImportFile();
                } else if (action === 'import-url') {
                    await handleImportUrl();
                } else if (action === 'create') {
                    // openCreateNewSkillFlow walks the user through name +
                    // description + scope, installs the template skill, and
                    // fires onChange so this panel refreshes when the new
                    // skill lands.
                    await openCreateNewSkillFlow({
                        context,
                        t,
                        onChange: () => { void refresh(); },
                    });
                } else if (action === 'refresh') {
                    await refresh();
                }
            });
        });

        root.querySelectorAll('[data-skill-action]').forEach((el) => {
            el.addEventListener('click', async (ev) => {
                ev.preventDefault();
                const row = el.closest('[data-skill-name]');
                if (!row) return;
                const name = row.getAttribute('data-skill-name');
                const scope = parseScope(row.getAttribute('data-skill-scope'));
                const action = el.getAttribute('data-skill-action');
                if (action === 'view') {
                    await handleView(scope, name);
                } else if (action === 'edit') {
                    // openSkillEditor uses context.skills.listFiles for the
                    // file tree and writeFile/expectedSha256 for save. We
                    // pass an onChange so descriptions / new files surface
                    // in the manager immediately on save.
                    await openSkillEditor({
                        context,
                        scope,
                        name,
                        t,
                        onChange: () => { void refresh(); },
                    });
                } else if (action === 'move') {
                    await handleMove(scope, name);
                } else if (action === 'rename') {
                    await handleRename(scope, name);
                } else if (action === 'delete') {
                    await handleDelete(scope, name);
                }
            });
        });
    }

    // ── Handlers ─────────────────────────────────────────────────────────

    async function handleImportBundled() {
        try {
            const result = await context.skills.importBundled();
            // The server returns `{installed:number, replaced:number,
            // alreadyInstalled:number}` — the legacy code here treated them as
            // arrays via `.length`, which always coerced to 0 and produced the
            // useless "Bundled import: 0 installed, 0 skipped" toast even on
            // successful imports. Use the shared formatter so this toolbar and
            // the Browse bundled tab stay in lock-step.
            const summary = describeBundledImportResult(result, t);
            toast(summary.text, summary.level);
            await refresh();
        } catch (e) {
            toast(t('Bundled import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleImportFile() {
        const file = await pickFile('.zip,.json');
        if (!file) return;
        let bytes;
        try {
            bytes = new Uint8Array(await file.arrayBuffer());
        } catch (e) {
            toast(t('Failed to read file: ${0}').replace('${0}', e?.message || String(e)), 'error');
            return;
        }
        const fmt = inferImportFormat(file.name, bytes);
        if (fmt.kind === 'unknown') {
            toast(t('Unsupported file: ${0}').replace('${0}', fmt.reason), 'error');
            return;
        }
        const targetScope = await pickTargetScope(t('Import into scope'));
        if (!targetScope) return;
        let payload;
        if (fmt.kind === 'embed-json') {
            payload = fmt.payload;
        } else {
            payload = buildArchiveEmbedPayload(fmt.defaultName, fmt.contentBase64);
        }
        await runExtractWithConflictResolution(payload, targetScope);
    }

    async function handleImportUrl() {
        const url = await context.callGenericPopup(
            t('Enter the URL of a skill zip bundle'),
            context.POPUP_TYPE.INPUT,
            '',
            { okButton: t('Import'), cancelButton: t('Cancel') },
        );
        if (!url || typeof url !== 'string') return;
        const targetScope = await pickTargetScope(t('Import into scope'));
        if (!targetScope) return;
        try {
            const result = await context.skills.importFromUrl({ url: String(url).trim(), targetScope });
            const installed = Array.isArray(result?.installed) ? result.installed.length : 0;
            const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
            toast(t('URL import: ${0} installed, ${1} skipped.')
                .replace('${0}', String(installed))
                .replace('${1}', String(skipped)), 'success');
            await refresh();
        } catch (e) {
            toast(t('URL import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleView(scope, name) {
        try {
            const result = await context.skills.readFile({ scope, name, path: 'SKILL.md' });
            const body = `<h3>${esc(name)}</h3><pre class="luker_skill_view_pre">${esc(result?.content || '')}</pre>`;
            await context.callGenericPopup(body, context.POPUP_TYPE.TEXT, formatScopeLabel(scope, t), {
                okButton: t('Close'),
                wide: true,
                large: true,
                allowVerticalScrolling: true,
            });
        } catch (e) {
            toast(t('Failed to read skill: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleDelete(scope, name) {
        const ok = await context.callGenericPopup(
            t('Delete skill "${0}" from ${1}? This cannot be undone.')
                .replace('${0}', name)
                .replace('${1}', formatScopeLabel(scope, t)),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: t('Delete'), cancelButton: t('Cancel') },
        );
        if (!isAffirmative(ok)) return;
        try {
            await context.skills.delete(scope, name);
            toast(t('Deleted skill: ${0}').replace('${0}', name), 'success');
            await refresh();
        } catch (e) {
            toast(t('Delete failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleRename(scope, oldName) {
        const newName = await context.callGenericPopup(
            t('Rename skill "${0}" to:').replace('${0}', oldName),
            context.POPUP_TYPE.INPUT,
            oldName,
            { okButton: t('Rename'), cancelButton: t('Cancel') },
        );
        if (!newName || typeof newName !== 'string') return;
        const trimmed = String(newName).trim();
        if (!trimmed || trimmed === oldName) return;
        if (hasRenameCollision(state.skills, scope, oldName, trimmed)) {
            const confirm = await context.callGenericPopup(
                t('A skill named "${0}" already exists in ${1}. Server will refuse the rename. Try a different name?')
                    .replace('${0}', trimmed)
                    .replace('${1}', formatScopeLabel(scope, t)),
                context.POPUP_TYPE.CONFIRM,
                '',
                { okButton: t('Retry'), cancelButton: t('Cancel') },
            );
            if (isAffirmative(confirm)) {
                await handleRename(scope, oldName);
            }
            return;
        }
        try {
            await context.skills.rename(scope, oldName, trimmed);
            toast(t('Renamed: ${0} -> ${1}')
                .replace('${0}', oldName)
                .replace('${1}', trimmed), 'success');
            await refresh();
        } catch (e) {
            toast(t('Rename failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    async function handleMove(fromScope, name) {
        const toScope = await pickTargetScope(t('Move "${0}" to scope').replace('${0}', name), fromScope);
        if (!toScope) return;
        if (scopesEqual(fromScope, toScope)) {
            toast(t('Skill already in that scope.'), 'info');
            return;
        }
        if (hasMoveScopeCollision(state.skills, name, fromScope, toScope)) {
            const ok = await context.callGenericPopup(
                t('A skill named "${0}" already exists in ${1}. Move will fail unless you delete the existing one first. Proceed anyway?')
                    .replace('${0}', name)
                    .replace('${1}', formatScopeLabel(toScope, t)),
                context.POPUP_TYPE.CONFIRM,
                '',
                { okButton: t('Proceed'), cancelButton: t('Cancel') },
            );
            if (!isAffirmative(ok)) return;
        }
        try {
            await context.skills.moveScope(name, fromScope, toScope);
            toast(t('Moved ${0}: ${1} -> ${2}')
                .replace('${0}', name)
                .replace('${1}', formatScopeLabel(fromScope, t))
                .replace('${2}', formatScopeLabel(toScope, t)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Move failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    /**
     * Run the preview+execute flow with per-skill conflict resolution. For
     * any 'different' rows we prompt the user with Skip/Replace. 'new' and
     * 'same' rows go through unchanged.
     */
    async function runExtractWithConflictResolution(payload, targetScope) {
        let preview;
        try {
            preview = await context.skills.previewExtractEmbed({ payload, targetScope });
        } catch (e) {
            toast(t('Preview failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
            return;
        }
        const items = Array.isArray(preview?.items) ? preview.items : [];
        const conflictStrategies = {};
        for (const it of items) {
            if (it.conflict === 'different') {
                const ok = await context.callGenericPopup(
                    t('Skill "${0}" already exists in ${1} with different content. Replace it?')
                        .replace('${0}', it.name)
                        .replace('${1}', formatScopeLabel(targetScope, t)),
                    context.POPUP_TYPE.CONFIRM,
                    '',
                    { okButton: t('Replace'), cancelButton: t('Skip') },
                );
                conflictStrategies[it.name] = isAffirmative(ok) ? 'replace' : 'skip';
            }
        }
        try {
            const result = await context.skills.executeExtractEmbed({ payload, targetScope, conflictStrategies });
            const installed = Array.isArray(result?.installed) ? result.installed.length : 0;
            const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
            toast(t('Imported: ${0} installed, ${1} skipped.')
                .replace('${0}', String(installed))
                .replace('${1}', String(skipped)), 'success');
            await refresh();
        } catch (e) {
            toast(t('Import failed: ${0}').replace('${0}', e?.message || String(e)), 'error');
        }
    }

    // ── DOM helpers (interactive only) ───────────────────────────────────

    function pickTargetScope(title, suggestScope) {
        return pickTargetScopeImpl(context, t, title, suggestScope);
    }

    async function pickFile(accept) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = accept || '';
            input.style.display = 'none';
            input.addEventListener('change', () => {
                const file = input.files && input.files[0];
                document.body.removeChild(input);
                resolve(file || null);
            });
            // Wire a fallback for cancel: most browsers fire 'cancel' on the
            // input when the user closes the chooser without selecting; we
            // also clean up on next-tick if no change fired and the input
            // is still present (defensive).
            input.addEventListener('cancel', () => {
                if (input.parentNode === document.body) {
                    document.body.removeChild(input);
                }
                resolve(null);
            });
            document.body.appendChild(input);
            input.click();
        });
    }

    function toast(message, level) {
        // The popup is inside a dialog; toastr's container needs to be
        // inside the dialog to be visible. Luker's popup.js already wires
        // this via `fixToastrForDialogs` on popup open, so we just call
        // toastr directly.
        if (typeof toastr === 'undefined') {
            console.warn('[skill-manager-panel]', message);
            return;
        }
        if (level === 'error') toastr.error(String(message));
        else if (level === 'success') toastr.success(String(message));
        else toastr.info(String(message));
    }

    function isAffirmative(result) {
        // POPUP_RESULT.AFFIRMATIVE === 1
        return result === 1 || result === true;
    }

    function parseScope(json) {
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    function dedupeScopes(scopes) {
        const seen = new Set();
        const out = [];
        for (const s of scopes) {
            if (!s) continue;
            const k = scopeKey(s);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
        return out;
    }

    // Kick off initial render. The mount node is painted into the popup
    // body synchronously after callGenericPopup returns the promise; we
    // refresh on the next microtask so the DOM is ready.
    Promise.resolve().then(() => { void refresh(); });

    await popupPromise;
}
