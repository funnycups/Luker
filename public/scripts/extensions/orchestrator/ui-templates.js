import { renderPresetHelpButton } from '../preset-help.js';
import { renderLukerTabs } from '../luker-tabs.js';
import { listExtensionTools } from './register-custom-tool.js';
import { listPresets } from './preset-library.js';
import { uiState } from './editor-state.js';

/**
 * Scope a base DOM id with an optional prefix so drawer + popup can co-exist.
 * Drawer callers pass '', popup callers pass 'orch-popup-'.
 */
export function scopeId(baseId, idPrefix = '') {
    return idPrefix ? `${idPrefix}${baseId}` : baseId;
}

const MODULE_NAME = 'orchestrator';

// Tiny duplicate of editor-state's closure-private helper. Reads the
// orchestrator slot off the shared ST extension settings so the preset
// selector bar can call listPresets() without round-tripping through
// the deps bag. Kept here (instead of exported from editor-state.js)
// because the read is one line and editor-state owns the loader-side
// initialization, not the live-read helper.
function getSettings() {
    return Luker.getContext().extensionSettings[MODULE_NAME];
}

/**
 * Render the preset selector bar shown at the top of each mode's editor
 * workspace. Displays the active preset dropdown and six action buttons
 * (New / Duplicate / Rename / Export / Import / Delete). Click + change
 * handlers are wired in main.js (Task B8); this just emits the HTML.
 *
 * When `scope === 'character'` and no character is loaded, the bar
 * collapses to a single hint span (no dropdown, no buttons) so the user
 * gets a clear "Select a character first" cue instead of an empty
 * unusable bar.
 *
 * `presets` is an array of `{ id, name }` from `listPresets`. `activeId`
 * is the currently active preset id for this (mode, scope). `mode` and
 * `scope` propagate as data-attributes so main.js can route events to
 * the right (mode, scope) target.
 */
function renderPresetSelectorBar(deps, { mode, scope, presets, activeId, disabledReason }) {
    const { escapeHtml, i18n } = deps;
    const safeMode = escapeHtml(String(mode));
    const safeScope = escapeHtml(String(scope));
    if (disabledReason) {
        return `<div class="luker_orch_preset_bar luker_orch_preset_bar--disabled"
                     data-mode="${safeMode}" data-scope="${safeScope}">
            <span class="luker_orch_preset_bar_hint">${escapeHtml(i18n(disabledReason))}</span>
        </div>`;
    }
    const options = (Array.isArray(presets) ? presets : []).map(p => `
        <option value="${escapeHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(p.name)}</option>
    `).join('');
    return `<div class="luker_orch_preset_bar" data-mode="${safeMode}" data-scope="${safeScope}">
        <label class="luker_orch_preset_bar_label">${escapeHtml(i18n('Preset'))}</label>
        <select class="text_pole luker_orch_preset_select"
                data-luker-preset-select data-mode="${safeMode}" data-scope="${safeScope}">
            ${options}
        </select>
        <button class="menu_button" data-luker-preset-action="new"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('New preset'))}</button>
        <button class="menu_button" data-luker-preset-action="duplicate"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('Duplicate preset'))}</button>
        <button class="menu_button" data-luker-preset-action="rename"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('Rename preset'))}</button>
        <button class="menu_button" data-luker-preset-action="export"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('Export preset'))}</button>
        <button class="menu_button" data-luker-preset-action="import"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('Import preset'))}</button>
        <button class="menu_button luker_orch_btn_danger" data-luker-preset-action="delete"
                data-mode="${safeMode}" data-scope="${safeScope}">${escapeHtml(i18n('Delete preset'))}</button>
    </div>`;
}

/**
 * Build the props bundle the four workspace renderers feed into
 * `renderPresetSelectorBar`. Owns the (mode, scope) → activeId lookup
 * and the per-scope listPresets call so each workspace renderer stays
 * a one-line `${renderPresetSelectorBar(deps, presetBarPropsFor(deps, 'spec', safeScope))}`.
 *
 * `safeScope` is the already-validated scope ('global' | 'character').
 * Returns `{ mode, scope, presets, activeId, disabledReason }` ready
 * to splat into the bar renderer.
 */
function presetBarPropsFor(deps, mode, safeScope) {
    const ctx = deps.getContext();
    const activeAvatar = String(deps.getCurrentAvatar(ctx) || '').trim();
    if (safeScope === 'character' && !activeAvatar) {
        return {
            mode,
            scope: safeScope,
            presets: [],
            activeId: '',
            disabledReason: 'Select a character first',
        };
    }
    const settings = getSettings();
    const presets = listPresets(settings, mode, {
        scope: safeScope,
        context: ctx,
        avatar: activeAvatar,
    });
    const activeId = safeScope === 'character'
        ? String(uiState.characterActivePresetIds?.[mode] || '')
        : String(uiState.globalActivePresetIds?.[mode] || '');
    return {
        mode,
        scope: safeScope,
        presets,
        activeId,
        disabledReason: '',
    };
}

/**
 * Merge Layer-2 (extension + st-bridge) tools with Layer-3 (profile.customTools[])
 * for display in the "Custom tools" flag panel. Layer-3 names take
 * precedence on dedup (a profile-authored handwritten tool with the same
 * name as an extension tool shadows the extension entry — the runtime
 * dispatcher resolves the same way).
 *
 * `flagBucket` is the `tools.custom` (or `defaultTools.custom`) object on
 * the profile. Only literal `false` disables; missing or `true` means
 * the tool is enabled.
 *
 * Returns: [{ name, displayName, description, mode, source, enabled }]
 */
function listCustomToolsForFlagUi(customTools, flagBucket) {
    const customFlags = flagBucket && typeof flagBucket === 'object' ? flagBucket : {};
    const profileTools = Array.isArray(customTools) ? customTools : [];
    const seen = new Set();
    const out = [];
    for (const t of profileTools) {
        const name = String(t?.name || '');
        if (!name) continue;
        seen.add(name);
        out.push({
            name,
            displayName: String(t.displayName || name),
            description: String(t.description || ''),
            mode: t.mode === 'read' ? 'read' : 'write',
            source: 'profile',
            enabled: customFlags[name] !== false,
        });
    }
    for (const ext of listExtensionTools()) {
        const name = String(ext?.name || '');
        if (!name || seen.has(name)) continue;
        out.push({
            name,
            displayName: String(ext.displayName || name),
            description: String(ext.description || ''),
            mode: ext.mode === 'read' ? 'read' : 'write',
            source: ext.source === 'st-bridge' ? 'st-bridge' : 'extension',
            enabled: customFlags[name] !== false,
        });
    }
    return out;
}

/**
 * Render the "Custom tools" panel: Add / Bridge action row, the
 * grouped checkbox list (Profile / Extension / From SillyTavern), and
 * the per-row Edit / Duplicate / Remove buttons for handwritten entries.
 *
 * The outer wrapper carries `data-orch-mode-tag="<mode>"` so the click
 * handlers in main.js can route to the correct editor accessor.
 * (Kept distinct from the workspace-level `data-orch-mode` attribute so
 * `renderDynamicPanels`'s visibility loop and `resolveCustomToolsHost`'s
 * routing lookup don't step on each other.)
 *
 * `customTools` is the profile-owned definitions array (`editor.customTools`
 * for loop/director/agenda, `editor.spec.customTools` for spec).
 * `flagBucket` is the corresponding `tools.custom` (or `defaultTools.custom`)
 * enable bucket.
 */
function renderCustomToolsSection(deps, safeScope, mode, customTools, flagBucket) {
    const { escapeHtml, i18n } = deps;
    const profileTools = Array.isArray(customTools) ? customTools : [];
    const items = listCustomToolsForFlagUi(profileTools, flagBucket);
    const byGroup = { profile: [], extension: [], 'st-bridge': [] };
    for (const it of items) {
        byGroup[it.source].push(it);
    }
    const renderProfileRow = (it, idx) => `
        <div class="luker_orch_ct_row" data-orch-ct-idx="${idx}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">
            <label class="checkbox_label luker_orch_ct_row_label">
                <input type="checkbox" data-orch-tool-flag="${escapeHtml(it.name)}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}" ${it.enabled ? 'checked' : ''} />
                <span class="luker_orch_ct_name">${escapeHtml(it.displayName)}</span>
                <span class="luker_orch_ct_mode">[${escapeHtml(it.mode)}]</span>
                ${it.description ? `<span class="luker_orch_ct_desc">${escapeHtml(it.description)}</span>` : ''}
            </label>
            <div class="luker_orch_ct_actions_inline">
                <button class="menu_button menu_button_small" type="button" data-orch-action="edit-custom-tool" data-orch-ct-idx="${idx}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">${escapeHtml(i18n('Edit'))}</button>
                <button class="menu_button menu_button_small" type="button" data-orch-action="duplicate-custom-tool" data-orch-ct-idx="${idx}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">${escapeHtml(i18n('Duplicate'))}</button>
                <button class="menu_button menu_button_small" type="button" data-orch-action="remove-custom-tool" data-orch-ct-idx="${idx}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">${escapeHtml(i18n('Remove'))}</button>
            </div>
        </div>
    `;
    const renderExtRow = (it) => `
        <label class="checkbox_label luker_orch_ct_row_label">
            <input type="checkbox" data-orch-tool-flag="${escapeHtml(it.name)}" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}" ${it.enabled ? 'checked' : ''} />
            <span class="luker_orch_ct_name">${escapeHtml(it.displayName)}</span>
            <span class="luker_orch_ct_mode">[${escapeHtml(it.mode)}]</span>
            ${it.description ? `<span class="luker_orch_ct_desc">${escapeHtml(it.description)}</span>` : ''}
        </label>
    `;
    const profileGroup = byGroup.profile.length === 0
        ? `<div class="luker_orch_ct_empty">${escapeHtml(i18n('No custom tools yet'))}</div>`
        : profileTools.map((tool, idx) => {
            const flagEnabled = flagBucket && flagBucket[String(tool?.name || '')] !== false;
            const item = {
                name: String(tool?.name || ''),
                displayName: String(tool?.displayName || tool?.name || ''),
                description: String(tool?.description || ''),
                mode: tool?.mode === 'read' ? 'read' : 'write',
                source: 'profile',
                enabled: flagEnabled,
            };
            return renderProfileRow(item, idx);
        }).join('');
    const extensionGroup = byGroup.extension.length === 0 ? '' : `
        <div class="luker_orch_ct_subgroup">
            <div class="luker_orch_ct_subgroup_title">${escapeHtml(i18n('Extension (from other plugins)'))}</div>
            ${byGroup.extension.map(renderExtRow).join('')}
        </div>
    `;
    const stBridgeGroup = byGroup['st-bridge'].length === 0 ? '' : `
        <div class="luker_orch_ct_subgroup">
            <div class="luker_orch_ct_subgroup_title">${escapeHtml(i18n('From SillyTavern'))}</div>
            ${byGroup['st-bridge'].map(renderExtRow).join('')}
        </div>
    `;
    return `
<details class="luker_orch_tools_section luker_orch_ct_section" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">
    <summary>${escapeHtml(i18n('Custom Tools'))}</summary>
    <div class="luker_orch_ct_actions">
        <button class="menu_button menu_button_small" type="button" data-orch-action="add-custom-tool" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">${escapeHtml(i18n('Add custom tool'))}</button>
        <button class="menu_button menu_button_small" type="button" data-orch-action="import-default-custom-tools" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}" title="${escapeHtml(i18n('Re-add the default custom tools shipped with the orchestrator. Existing tools with the same name are skipped unless you confirm overwrite.'))}">${escapeHtml(i18n('Import defaults'))}</button>
        <button class="menu_button menu_button_small" type="button" data-orch-action="open-bridge-st-tools" data-orch-mode-tag="${escapeHtml(mode)}" data-scope="${safeScope}">${escapeHtml(i18n('Bridge SillyTavern tools...'))}</button>
    </div>
    <div class="luker_orch_ct_subgroup">
        <div class="luker_orch_ct_subgroup_title">${escapeHtml(i18n('Profile (defined in this profile)'))}</div>
        ${profileGroup}
    </div>
    ${extensionGroup}
    ${stBridgeGroup}
</details>
    `;
}

export { renderCustomToolsSection };

/**
 * Shared checkbox-grid for the orchestration loop tool flags. Used by
 * the loop editor (single canonical tool set), spec / agenda profile-root
 * `defaultTools` panels, and per-node / per-agent override panels.
 *
 * `tools` is a sanitized flag object — same shape `sanitizeAgentToolFlags`
 * produces — OR `null` for the inherit case (override panels render the
 * empty state instead of checkboxes).
 *
 * `dataAttrName` is the html data-attribute the click handler looks for,
 * e.g. `luker-loop-tool`, `luker-spec-default-tool`, `luker-spec-node-tool`,
 * `luker-agenda-default-tool`, `luker-agenda-agent-tool`. Each value
 * carries a tool path like `chat.read_range` so the handler can split
 * into namespace + verb regardless of which surface called.
 *
 * `extraAttrs` is a flat object of additional html data-attrs the panel
 * stamps on every checkbox. Per-node / per-agent panels use this to pass
 * the stage/node/agent identifier so the handler can target the right
 * profile location.
 *
 * `options.includeCollab` (default false) renders an extra `collab`
 * fieldset for the two main-agent sub-agent dispatch verbs. Only the
 * director's main-agent surfaces (`director.tools` default + the
 * `director.mainAgent.tools` override) opt in — every other surface
 * (loop / spec / agenda / director sub-agent override) leaves it off
 * because those runtimes never expose those tools to the LLM.
 */
function renderToolFlagsGrid(deps, scope, tools, dataAttrName, extraAttrs = {}, { includeCollab = false, profileCustomTools = null } = {}) {
    const { escapeHtml, i18n } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const safe = tools && typeof tools === 'object' ? tools : {};
    const note = safe.note || {};
    const chat = safe.chat || {};
    const lorebook = safe.lorebook || {};
    const customFlags = safe.custom && typeof safe.custom === 'object' ? safe.custom : {};
    const collab = safe.collab || {};
    const extraAttrParts = Object.entries(extraAttrs)
        .map(([key, value]) => `data-${key}="${escapeHtml(String(value))}"`)
        .join(' ');
    const cb = (id, field, label, { disabled = false, checked = null } = {}) => {
        const isChecked = checked === null ? Boolean(field) : Boolean(checked);
        return `<label class="checkbox_label">
            <input type="checkbox" data-${dataAttrName}="${escapeHtml(id)}" data-scope="${safeScope}" ${extraAttrParts} ${isChecked ? 'checked' : ''}${disabled ? ' disabled' : ''} />
            ${escapeHtml(label)}
        </label>`;
    };
    const collabFieldset = includeCollab ? `
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('collab (sub-agent dispatch — main agent only)'))}</legend>
    ${cb('collab.dispatch_subagent', collab.dispatch_subagent, 'dispatch_subagent')}
    ${cb('collab.dispatch_inline_subagent', collab.dispatch_inline_subagent, 'dispatch_inline_subagent')}
</fieldset>` : '';

    // Custom tools fieldset: union of (a) extension/ST-bridge tools
    // currently in the Layer-2 registry and (b) handwritten tools
    // declared on this profile (`profileCustomTools`). Each checkbox
    // writes through to `tools.custom.<name>` so per-agent overrides can
    // disable individual customs while inheriting the rest from the
    // profile default.
    //
    // Default-on semantics: when the override panel is freshly created
    // from an inherited tools object, missing custom keys are treated
    // as enabled (matches getEnabledToolSchemas's `customFlags[name] !== false`
    // semantics). An explicit `false` on the override surface disables
    // for this agent only.
    const customsFieldset = renderCustomFlagsFieldset(deps, scope, customFlags, dataAttrName, extraAttrParts, profileCustomTools);

    return `
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('note (persistent notes)'))}</legend>
    ${cb('note.open', note.open, 'note_open')}
    ${cb('note.close', note.close, 'note_close')}
</fieldset>
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('chat (in-chat history)'))}</legend>
    ${cb('chat.read_range', chat.read_range, 'chat_read_range')}
    ${cb('chat.search', chat.search, 'chat_search')}
</fieldset>
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('lorebook (world info)'))}</legend>
    ${cb('lorebook.world_book_list', lorebook.world_book_list, 'world_book_list')}
    ${cb('lorebook.list', lorebook.list, 'lorebook_list')}
    ${cb('lorebook.search', lorebook.search, 'lorebook_search')}
    ${cb('lorebook.get', lorebook.get, 'lorebook_get')}
</fieldset>${collabFieldset}${customsFieldset}`;
}

/**
 * Render the per-override Custom Tools fieldset: union of Layer-2
 * (extension + ST-bridge) entries and the profile's handwritten
 * `customTools[]`. Each checkbox is keyed by the tool's fully-qualified
 * name (no namespace prefix — Layer-3 / Layer-2 names are already flat).
 *
 * The checkbox `data-<dataAttrName>` field uses the literal key
 * `custom.<name>` so the existing main.js handler that splits on the
 * first dot routes the write into `tools.custom[<name>]` automatically.
 *
 * `currentFlags` is the override's `tools.custom` bucket (may be empty).
 * `profileCustomTools` is the profile's `customTools[]` array (may be
 * null when the caller doesn't carry one through — e.g. spec node
 * overrides not yet wired).
 */
function renderCustomFlagsFieldset(deps, scope, currentFlags, dataAttrName, extraAttrParts, profileCustomTools) {
    const { escapeHtml, i18n } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const flags = currentFlags && typeof currentFlags === 'object' ? currentFlags : {};
    const seen = new Set();
    const rows = [];
    const pushRow = (name, displayName, mode, source) => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        // Default-on: missing key === enabled; explicit `false` disables.
        const enabled = flags[name] !== false;
        const modeChip = mode ? `<span class="luker_orch_ct_mode">[${escapeHtml(mode)}]</span>` : '';
        const sourceChip = source && source !== 'profile'
            ? ` <span class="luker_orch_ct_source">(${escapeHtml(source === 'st-bridge' ? 'ST' : source)})</span>`
            : '';
        rows.push(`<label class="checkbox_label">
            <input type="checkbox" data-${dataAttrName}="custom.${escapeHtml(name)}" data-scope="${safeScope}" ${extraAttrParts} ${enabled ? 'checked' : ''} />
            <span>${escapeHtml(displayName || name)}${modeChip}${sourceChip}</span>
        </label>`);
    };

    // Profile-handwritten first so they group before Layer-2.
    if (Array.isArray(profileCustomTools)) {
        for (const t of profileCustomTools) {
            const n = String(t?.name || '');
            pushRow(n, String(t?.displayName || n), t?.mode === 'read' ? 'read' : 'write', 'profile');
        }
    }
    for (const ext of listExtensionTools()) {
        pushRow(String(ext.name || ''), String(ext.displayName || ext.name || ''), ext.mode === 'read' ? 'read' : 'write', ext.source);
    }

    if (rows.length === 0) {
        return '';  // nothing to show; skip the fieldset entirely
    }
    return `
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('custom (extension + profile tools)'))}</legend>
    ${rows.join('')}
</fieldset>`;
}

/**
 * Render a deferred mount point for the per-agent skill chips component.
 * The placeholder div carries the metadata main.js needs to locate the
 * underlying `skills: {visible, deny}` field in the editor state when
 * `hydrateSkillChips` runs after each popup re-render.
 *
 * `target` describes which editor field the chips edit:
 *   - mode-level: `{ scope, mode, level: 'mode' }`
 *   - director main: `{ scope, mode: 'director', level: 'agent', agentRef: 'main' }`
 *   - director sub: `{ scope, mode: 'director', level: 'agent', agentRef: { kind: 'subIndex', index: N } }`
 *   - loop is mode-level only (single-agent runtime)
 *   - agenda planner: `{ scope, mode: 'agenda', level: 'agent', agentRef: 'planner' }`
 *   - agenda agent: `{ scope, mode: 'agenda', level: 'agent', agentRef: { kind: 'agendaAgent', id } }`
 *   - spec node: `{ scope, mode: 'spec', level: 'agent', agentRef: { kind: 'specNode', stageIndex, nodeIndex } }`
 *
 * The component itself is not rendered here — only the placeholder. The
 * runtime hydration step queries `[data-luker-skill-chips-mount]` after
 * the popup paints and calls `mountSkillChips` per div.
 *
 * @param {object} deps
 * @param {string} scope - 'global' | 'character'
 * @param {object} target - target metadata as above
 * @param {string} [label] - optional label rendered above the chips
 * @returns {string}
 */
export function renderSkillChipsPlaceholder(deps, scope, target, label = '') {
    const { escapeHtml, i18n } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const payload = { ...target, scope: safeScope };
    const targetJson = escapeHtml(JSON.stringify(payload));
    const labelHtml = label
        ? `<div class="luker_skill_chips_label">${escapeHtml(label)}</div>`
        : '';
    return `
<div class="luker_skill_chips_block">
    ${labelHtml}
    <div class="luker_skill_chips_mount" data-luker-skill-chips-mount data-luker-chip-target="${targetJson}" data-scope="${safeScope}">
        <div class="luker_skill_chips_loading">${escapeHtml(i18n('Loading skills...'))}</div>
    </div>
</div>`;
}

/**
 * Render the inherit / override toggle + tools grid for a single node
 * or agent. When `tools` is null we show the inherit hint and an
 * "Override" action; when it's an object we show the grid plus a
 * "Reset to inherit" action.
 *
 * `actionName` is the data-luker-action that toggles override/inherit
 * (e.g. `spec-node-tools-override`); `actionExtraAttrs` mirrors the
 * checkbox extraAttrs so the click handler can find the same target.
 */
export function renderInheritOrOverridePanel(deps, scope, tools, {
    dataAttrName,
    extraAttrs = {},
    overrideAction,
    resetAction,
    inheritedTools = null,
    kind = 'agent',
    includeCollab = false,
    profileCustomTools = null,
}) {
    const { escapeHtml, i18n } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const extraAttrParts = Object.entries(extraAttrs)
        .map(([key, value]) => `data-${key}="${escapeHtml(String(value))}"`)
        .join(' ');
    if (!tools || typeof tools !== 'object') {
        const noToolsText = kind === 'node'
            ? i18n('No tools active. This node runs as a single LLM call.')
            : i18n('No tools active. This agent runs as a single LLM call.');
        const inheritNote = inheritedTools ? i18n('Using the profile default.') : noToolsText;
        return `
<div class="luker_orch_tools_inherit_block">
    <div class="luker-studio-empty-hint">${escapeHtml(inheritNote)}</div>
    <div class="menu_button menu_button_small" data-luker-action="${escapeHtml(overrideAction)}" data-scope="${safeScope}" ${extraAttrParts}>${escapeHtml(i18n('Override'))}</div>
</div>`;
    }
    return `
<div class="luker_orch_tools_override_block">
    ${renderToolFlagsGrid(deps, scope, tools, dataAttrName, extraAttrs, { includeCollab, profileCustomTools })}
    <div class="menu_button menu_button_small" data-luker-action="${escapeHtml(resetAction)}" data-scope="${safeScope}" ${extraAttrParts}>${escapeHtml(i18n('Reset to inherit'))}</div>
</div>`;
}

function renderAgendaAgentSelectOptions(deps, editor, selectedAgentId = '') {
    const {
        escapeHtml,
        i18n,
        sanitizeIdentifierToken,
        sanitizePresetMap,
    } = deps;
    const selected = sanitizeIdentifierToken(selectedAgentId, '');
    const agents = sanitizePresetMap(editor?.agents);
    const ids = Object.keys(agents).sort((left, right) => left.localeCompare(right));
    const options = [];
    for (const agentId of ids) {
        options.push(`<option value="${escapeHtml(agentId)}"${agentId === selected ? ' selected' : ''}>${escapeHtml(agentId)}</option>`);
    }
    if (selected && !agents[selected]) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderAgendaAgentBoard(deps, scope, editor) {
    const {
        escapeHtml,
        getContext,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
        sanitizePresetMap,
    } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const agents = sanitizePresetMap(editor?.agents);
    const entries = Object.entries(agents).sort((left, right) => left[0].localeCompare(right[0]));
    if (entries.length === 0) {
        return `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No presets yet.'))}</div>`;
    }
    const context = getContext();
    return entries.map(([agentId, preset]) => `
<div class="luker-studio-card">
    <div class="luker-studio-card-header">
        <b>${escapeHtml(agentId)}</b>
        <div class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-luker-action="agenda-agent-delete" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Agent API preset (Connection profile, empty = global orchestration API preset)'))}</label>
    <select class="text_pole" data-luker-agenda-agent-field="apiPresetName" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">
        ${renderConnectionProfileOptions(preset?.apiPresetName, i18n('(Global orchestration API preset)'))}
    </select>
    <label>${escapeHtml(i18n('Agent preset (params + prompt, empty = global orchestration preset)'))}</label>
    <select class="text_pole" data-luker-agenda-agent-field="promptPresetName" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">
        ${renderOpenAIPresetOptions(context, preset?.promptPresetName, i18n('(Global orchestration prompt preset)'))}
    </select>
    <label>${escapeHtml(i18n('System Prompt'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-agenda-agent-field="systemPrompt" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>${escapeHtml(i18n('User Prompt Template'))}</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-agenda-agent-field="userPromptTemplate" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
    <details class="luker_orch_tools_section">
        <summary>${escapeHtml(i18n('Tools'))}</summary>
        ${renderInheritOrOverridePanel(deps, safeScope, preset.tools, {
        dataAttrName: 'luker-agenda-agent-tool',
        extraAttrs: { 'agent-id': agentId },
        overrideAction: 'agenda-agent-tools-override',
        resetAction: 'agenda-agent-tools-reset',
        inheritedTools: editor?.defaultTools || null,
        kind: 'agent',
        profileCustomTools: editor?.customTools || null,
    })}
    </details>
    <details class="luker_orch_skills_section">
        <summary>${escapeHtml(i18n('Skills'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'agenda',
        level: 'agent',
        agentRef: { kind: 'agendaAgent', id: agentId },
    }, i18n('Per-agent skill visibility. Use [+ inherit mode default] to combine.'))}
    </details>
</div>`).join('');
}

/**
 * Split-return form used by the tab-host injector. Returns an
 * `{agentsHtml, toolsHtml}` pair: `agentsHtml` = the per-agent config
 * (planner card + planner skills + agenda agent board + add row), which
 * lives in the Agents tab; `toolsHtml` = mode-level default tools, custom
 * tools, and mode-level skills, which lives in the Tools & Skills tab.
 *
 * Kept in the same file as the legacy 2-column `renderAgendaWorkspace`
 * so the tab-host injector can call it directly.
 */
export function renderAgendaWorkspace(deps, scope, editor, title = '') {
    const {
        DEFAULT_AGENDA_PLANNER_PROMPT,
        DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT,
        createAgendaPlannerDraft,
        ensureAgendaEditorIntegrity,
        escapeHtml,
        getContext,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
    } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    ensureAgendaEditorIntegrity(editor);
    const planner = createAgendaPlannerDraft(editor?.planner);
    const context = getContext();
    const agentsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title || i18n('Agenda Orchestration'))}</div>
    <div class="luker-studio-workspace-col">
        <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Planner Prompt'))}</div>
        <label for="luker_orch_agenda_planner_api_preset">${escapeHtml(i18n('Planner API preset (Connection profile, empty = global orchestration API preset)'))}</label>
        <select id="luker_orch_agenda_planner_api_preset" data-scope="${safeScope}" class="text_pole">${renderConnectionProfileOptions(planner?.apiPresetName, i18n('(Global orchestration API preset)'))}</select>
        <label for="luker_orch_agenda_planner_prompt_preset">${escapeHtml(i18n('Planner preset (params + prompt, empty = global orchestration preset)'))}${renderPresetHelpButton({ kind: 'agent', agentMode: 'non-director', targetSelectId: 'luker_orch_agenda_planner_prompt_preset' })}</label>
        <select id="luker_orch_agenda_planner_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, planner?.promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
        <label for="luker_orch_agenda_planner_system_prompt">${escapeHtml(i18n('Planner system prompt'))}</label>
        <textarea id="luker_orch_agenda_planner_system_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="5">${escapeHtml(String(planner?.systemPrompt || DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT))}</textarea>
        <label for="luker_orch_agenda_planner_prompt">${escapeHtml(i18n('Planner Prompt'))}</label>
        <textarea id="luker_orch_agenda_planner_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="16">${escapeHtml(String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT))}</textarea>
        <label for="luker_orch_agenda_final_agent">${escapeHtml(i18n('Final Agent'))}</label>
        <select id="luker_orch_agenda_final_agent" data-scope="${safeScope}" class="text_pole">${renderAgendaAgentSelectOptions(deps, editor, editor?.finalAgentId)}</select>
        <details class="luker_orch_skills_section">
            <summary>${escapeHtml(i18n('Planner skills'))}</summary>
            ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'agenda',
        level: 'agent',
        agentRef: 'planner',
    }, i18n('Skills visible to the planner. + inherits mode default.'))}
        </details>
    </div>
    <div class="luker-studio-workspace-col">
        <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Agenda Agents'))}</div>
        <div>${renderAgendaAgentBoard(deps, safeScope, editor)}</div>
        <div class="luker-studio-add-row">
            <input class="text_pole" data-luker-agenda-new-agent="${safeScope}" placeholder="${escapeHtml(i18n('new_preset_id'))}" />
            <div class="menu_button menu_button_small" data-luker-action="agenda-agent-add" data-scope="${safeScope}">${escapeHtml(i18n('Add Preset'))}</div>
        </div>
    </div>
</div>`;
    const toolsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <details class="luker_orch_tools_section">
        <summary>${escapeHtml(i18n('Default tools for all agents'))}</summary>
        <div class="luker-studio-empty-hint">${escapeHtml(i18n('Each agent can override these defaults below. Leave empty to keep tools off for all agents.'))}</div>
        ${editor?.defaultTools
        ? `${renderToolFlagsGrid(deps, safeScope, editor.defaultTools, 'luker-agenda-default-tool', {}, { profileCustomTools: editor?.customTools || null })}
        <div class="luker-studio-actions-row">
            <div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable all'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-disable-all" data-scope="${safeScope}">${escapeHtml(i18n('Clear'))}</div>
        </div>`
        : `<div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable defaults'))}</div>`}
    </details>
    ${renderCustomToolsSection(deps, safeScope, 'agenda', editor?.customTools || [], (editor?.defaultTools && editor.defaultTools.custom) || {})}
    <details class="luker_orch_skills_section" open>
        <summary>${escapeHtml(i18n('Mode-level skills (baseline for every agent)'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'agenda',
        level: 'mode',
    }, i18n('These visible/deny chips form the baseline every agent sees unless its own chips replace them.'))}
    </details>
</div>`;
    return { agentsHtml, toolsHtml };
}

export function renderEditorWorkspace(deps, scope, editor, title) {
    const { escapeHtml, i18n, renderPresetBoard, renderWorkflowBoard } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const specDefaultTools = editor?.spec?.defaultTools || null;
    const agentsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${scope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title)}</div>
    <div class="luker-studio-workspace-col">
        <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Workflow'))}</div>
        <div>${renderWorkflowBoard(scope, editor)}</div>
        <div class="menu_button menu_button_small" data-luker-action="stage-add" data-scope="${scope}">${escapeHtml(i18n('Add Stage'))}</div>
    </div>
    <div class="luker-studio-workspace-col">
        <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Agent Presets'))}</div>
        <div>${renderPresetBoard(scope, editor)}</div>
        <div class="luker-studio-add-row">
            <input class="text_pole" data-luker-new-preset="${scope}" placeholder="${escapeHtml(i18n('new_preset_id'))}" />
            <div class="menu_button menu_button_small" data-luker-action="preset-add" data-scope="${scope}">${escapeHtml(i18n('Add Preset'))}</div>
        </div>
    </div>
</div>`;
    const toolsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${scope}">
    <details class="luker_orch_tools_section">
        <summary>${escapeHtml(i18n('Default tools for all nodes'))}</summary>
        <div class="luker-studio-empty-hint">${escapeHtml(i18n('Each node can override these defaults below. Leave empty to keep tools off for all nodes.'))}</div>
        ${specDefaultTools
        ? `${renderToolFlagsGrid(deps, safeScope, specDefaultTools, 'luker-spec-default-tool', {}, { profileCustomTools: editor?.spec?.customTools || null })}
        <div class="luker-studio-actions-row">
            <div class="menu_button menu_button_small" data-luker-action="spec-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable all'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="spec-default-tools-disable-all" data-scope="${safeScope}">${escapeHtml(i18n('Clear'))}</div>
        </div>`
        : `<div class="menu_button menu_button_small" data-luker-action="spec-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable defaults'))}</div>`}
    </details>
    ${renderCustomToolsSection(deps, safeScope, 'spec', editor?.spec?.customTools || [], (editor?.spec?.defaultTools && editor.spec.defaultTools.custom) || {})}
    <details class="luker_orch_skills_section" open>
        <summary>${escapeHtml(i18n('Mode-level skills (baseline for every node)'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'spec',
        level: 'mode',
    }, i18n('These visible/deny chips form the baseline every spec node sees unless its own chips replace them.'))}
    </details>
</div>`;
    return { agentsHtml, toolsHtml };
}

/**
 * Loop-mode editor workspace. Single-column layout (no spec-style
 * stages/presets boards) — the loop runtime has one agent and one
 * conversation, so the editor exposes:
 *
 *   1. API + prompt preset routing (same dropdowns spec/agenda use)
 *   2. system_prompt textarea (the agent's main instruction)
 *   3. Tool-flag checkboxes grouped by namespace; finalize is rendered
 *      disabled+checked because `sanitizeLoopProfile` forces it on
 *   4. max_rounds / wall_clock_budget_ms numeric inputs (rendered in
 *      seconds for wall_clock so users don't hand-author six-digit
 *      millisecond values)
 *
 * Save / reset / reload buttons in the popup actions bar reuse the
 * existing handlers; only the workspace body switches per mode.
 */
export function renderLoopWorkspace(deps, scope, editor, title = '') {
    const {
        escapeHtml,
        getContext,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
    } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const context = getContext();
    const tools = editor?.tools || {};
    const note = tools.note || {};
    const chat = tools.chat || {};
    const lorebook = tools.lorebook || {};
    // memory + search tools are Layer-2 customs now (translated by
    // sanitizeAgentToolFlags into tools.custom.<full_name>); the Custom
    // Tools section below renders them. No legacy memory/search fieldsets
    // here.
    const checkbox = (id, field, label, disabled = false, checked = null) => {
        const isChecked = checked === null ? Boolean(field) : Boolean(checked);
        return `<label class="checkbox_label">
            <input type="checkbox" data-luker-loop-tool="${escapeHtml(id)}" data-scope="${safeScope}" ${isChecked ? 'checked' : ''}${disabled ? ' disabled' : ''} />
            ${escapeHtml(label)}
        </label>`;
    };
    const agentsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title || i18n('Loop Orchestration'))}</div>
    <div class="luker-studio-workspace-col">
        <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Loop Agent'))}</div>
        <label for="luker_orch_loop_api_preset">${escapeHtml(i18n('Loop API preset (Connection profile, empty = global orchestration API preset)'))}</label>
        <select id="luker_orch_loop_api_preset" data-scope="${safeScope}" class="text_pole">${renderConnectionProfileOptions(editor?.apiPresetName, i18n('(Global orchestration API preset)'))}</select>
        <label for="luker_orch_loop_prompt_preset">${escapeHtml(i18n('Loop preset (params + prompt, empty = global orchestration preset)'))}${renderPresetHelpButton({ kind: 'agent', agentMode: 'non-director', targetSelectId: 'luker_orch_loop_prompt_preset' })}</label>
        <select id="luker_orch_loop_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, editor?.promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
        <label for="luker_orch_loop_system_prompt">${escapeHtml(i18n('Loop system prompt'))}</label>
        <textarea id="luker_orch_loop_system_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="14">${escapeHtml(String(editor?.system_prompt || ''))}</textarea>
    </div>
</div>`;
    const toolsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Loop tools'))}</div>
    <fieldset class="luker_orch_loop_tools_group">
        <legend>${escapeHtml(i18n('note (persistent notes)'))}</legend>
        ${checkbox('note.open', note.open, 'note_open')}
        ${checkbox('note.close', note.close, 'note_close')}
    </fieldset>
    <fieldset class="luker_orch_loop_tools_group">
        <legend>${escapeHtml(i18n('chat (in-chat history)'))}</legend>
        ${checkbox('chat.read_range', chat.read_range, 'chat_read_range')}
        ${checkbox('chat.search', chat.search, 'chat_search')}
    </fieldset>
    <fieldset class="luker_orch_loop_tools_group">
        <legend>${escapeHtml(i18n('lorebook (world info)'))}</legend>
        ${checkbox('lorebook.world_book_list', lorebook.world_book_list, 'world_book_list')}
        ${checkbox('lorebook.list', lorebook.list, 'lorebook_list')}
        ${checkbox('lorebook.search', lorebook.search, 'lorebook_search')}
        ${checkbox('lorebook.get', lorebook.get, 'lorebook_get')}
        ${checkbox('lorebook.force_activate', lorebook.force_activate, 'lorebook_force_activate')}
    </fieldset>
    <fieldset class="luker_orch_loop_tools_group">
        <legend>${escapeHtml(i18n('terminator'))}</legend>
        ${checkbox('finalize', true, `finalize  ${i18n('(forced on)')}`, true, true)}
    </fieldset>
    ${renderCustomToolsSection(deps, safeScope, 'loop', editor?.customTools || [], (editor?.tools && editor.tools.custom) || {})}
    <details class="luker_orch_skills_section">
        <summary>${escapeHtml(i18n('Skills'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'loop',
        level: 'mode',
    }, i18n('Skills visible to the loop agent.'))}
    </details>
</div>`;
    return { agentsHtml, toolsHtml };
}

/**
 * Render a single sub-agent row for the director editor. Each row binds
 * its inputs to the position-keyed sub-agent entry under
 * `profile.subAgents[subagentIndex]`; the main.js binders use
 * `data-subagent-index` to locate the entry. Empty `id` / `systemPrompt`
 * are normal in-flight (the sanitizer only drops them at runtime), so
 * the renderer does not validate.
 */
function renderDirectorSubAgentRow(deps, scope, subagent, subagentIndex, directorDefaultTools, profile = null) {
    const {
        escapeHtml,
        getContext,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
    } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const safe = subagent && typeof subagent === 'object' ? subagent : {};
    const id = String(safe.id ?? '');
    const description = String(safe.description ?? '');
    const systemPrompt = String(safe.systemPrompt ?? '');
    const apiPresetName = String(safe.apiPresetName ?? '');
    const promptPresetName = String(safe.promptPresetName ?? '');
    const subagentTools = (safe.tools && typeof safe.tools === 'object') ? safe.tools : null;
    // Per-sub-agent runaway cap. `null` (default) means "inherit the
    // runtime default (40)"; the input shows the placeholder and renders
    // empty so the user can leave it alone. An explicit integer >= 1
    // pins the cap for that one sub-agent.
    const maxRoundsRaw = safe.maxRounds;
    const maxRoundsValue = Number.isFinite(Number(maxRoundsRaw)) && Number(maxRoundsRaw) > 0
        ? String(Math.floor(Number(maxRoundsRaw)))
        : '';
    const context = getContext();
    return `
<div class="luker_orch_subagent_row luker-studio-card" data-subagent-row="${escapeHtml(id)}" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">
    <div class="luker-studio-card-header">
        <b>${escapeHtml(id || i18n('(unnamed sub-agent)'))}</b>
        <div class="luker-studio-card-actions">
            <div class="menu_button menu_button_small" data-orch-remove-subagent="1" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">${escapeHtml(i18n('Remove'))}</div>
        </div>
    </div>
    <label>
        <span data-i18n="Sub-agent ID">${escapeHtml(i18n('Sub-agent ID'))}</span>
        <input class="text_pole" type="text" data-orch-subagent-field="id" data-subagent-index="${subagentIndex}" data-scope="${safeScope}" value="${escapeHtml(id)}" />
    </label>
    <label>
        <span data-i18n="Description (shown to main agent)">${escapeHtml(i18n('Description (shown to main agent)'))}</span>
        <input class="text_pole" type="text" data-orch-subagent-field="description" data-subagent-index="${subagentIndex}" data-scope="${safeScope}" value="${escapeHtml(description)}" />
    </label>
    <label>
        <span data-i18n="System prompt">${escapeHtml(i18n('System prompt'))}</span>
        <textarea class="text_pole textarea_compact" rows="4" data-orch-subagent-field="systemPrompt" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">${escapeHtml(systemPrompt)}</textarea>
    </label>
    <label>
        <span data-i18n="API preset (Connection profile)">${escapeHtml(i18n('API preset (Connection profile)'))}</span>
        <select class="text_pole" data-orch-subagent-field="apiPresetName" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">${renderConnectionProfileOptions(apiPresetName, i18n('(Global orchestration API preset)'))}</select>
    </label>
    <label>
        <span data-i18n="Prompt preset">${escapeHtml(i18n('Prompt preset'))}</span>${renderPresetHelpButton({ kind: 'agent', agentMode: 'director' })}
        <select class="text_pole" data-orch-subagent-field="promptPresetName" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">${renderOpenAIPresetOptions(context, promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
        <div class="director-preset-help" data-i18n="director_preset_help_pure_instruction">${escapeHtml(i18n('Pick a pure-instruction preset. Typical RP presets that prescribe an output format (forced CoT, mandatory schema blocks) will block the agent\'s tool calls.'))}</div>
    </label>
    <label>
        <span data-i18n="Max tool-call rounds (this sub-agent)">${escapeHtml(i18n('Max tool-call rounds (this sub-agent)'))}</span>
        <input class="text_pole" type="number" min="1" step="1" placeholder="${escapeHtml(i18n('Inherit default (40)'))}" data-orch-subagent-field="maxRounds" data-subagent-index="${subagentIndex}" data-scope="${safeScope}" value="${escapeHtml(maxRoundsValue)}" />
        <div class="director-preset-help">${escapeHtml(i18n('Per-sub-agent runaway cap. Leave empty to inherit the default (40).'))}</div>
    </label>
    <details class="luker_orch_tools_section">
        <summary>${escapeHtml(i18n('Tools'))}</summary>
        ${renderInheritOrOverridePanel(deps, safeScope, subagentTools, {
        dataAttrName: 'luker-director-subagent-tool',
        extraAttrs: { 'subagent-index': subagentIndex },
        overrideAction: 'director-subagent-tools-override',
        resetAction: 'director-subagent-tools-reset',
        inheritedTools: directorDefaultTools || null,
        kind: 'agent',
        profileCustomTools: profile?.customTools || null,
    })}
    </details>
    <details class="luker_orch_skills_section">
        <summary>${escapeHtml(i18n('Skills'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'director',
        level: 'agent',
        agentRef: { kind: 'subIndex', index: subagentIndex },
    }, i18n('Per-sub-agent skill visibility. Use [+ inherit mode default] to combine.'))}
    </details>
</div>`;
}

/**
 * Director-mode editor workspace. Mirrors `renderLoopWorkspace` /
 * `renderAgendaWorkspace`: a two-column grid where the left column holds
 * the main agent's routing + system prompt + numeric limits + abort
 * policy, and the right column lists sub-agent rows with an add button.
 *
 * Director profile shape (matches `createDefaultDirectorProfile()` /
 * `sanitizeDirectorProfile` in `director-defaults.js`):
 *   { mode, director: {
 *       mainAgent: { apiPresetName, promptPresetName, systemPrompt },
 *       subAgents: [{ id, description, systemPrompt, apiPresetName, promptPresetName }],
 *       maxRounds, maxConcurrentSubagents, maxTotalSubagentRuns,
 *       tools, discardOnAbort,
 *   } }
 *
 * The binders in main.js consume `[data-orch-director-field=...]`
 * (dot-path under `profile.*`) and
 * `[data-orch-subagent-field=...]` (indexed by `data-subagent-index`).
 * `[data-orch-add-subagent]` / `[data-orch-remove-subagent]` mutate
 * `profile.subAgents` and trigger a full popup re-render so
 * the row indices stay aligned with the underlying array.
 */
export function renderDirectorWorkspace(deps, scope, profile, title = '') {
    const {
        escapeHtml,
        getContext,
        i18n,
        renderConnectionProfileOptions,
        renderOpenAIPresetOptions,
    } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const director = (profile && typeof profile === 'object')
        ? profile
        : {};
    const mainAgent = director.mainAgent && typeof director.mainAgent === 'object' ? director.mainAgent : {};
    const subAgents = Array.isArray(director.subAgents) ? director.subAgents : [];
    const maxRounds = Number.isFinite(Number(director.maxRounds)) ? Number(director.maxRounds) : 40;
    const maxConcurrentSubagents = Number.isFinite(Number(director.maxConcurrentSubagents)) ? Number(director.maxConcurrentSubagents) : 4;
    const maxTotalSubagentRuns = Number.isFinite(Number(director.maxTotalSubagentRuns)) ? Number(director.maxTotalSubagentRuns) : 16;
    const discardOnAbort = Boolean(director.discardOnAbort);
    const directorDefaultTools = (director.tools && typeof director.tools === 'object') ? director.tools : null;
    const mainAgentTools = (mainAgent.tools && typeof mainAgent.tools === 'object') ? mainAgent.tools : null;
    const context = getContext();
    const subAgentRows = subAgents.length === 0
        ? `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No sub-agents yet.'))}</div>`
        : subAgents.map((subagent, index) => renderDirectorSubAgentRow(deps, safeScope, subagent, index, directorDefaultTools, profile)).join('');
    const agentsHtml = `
<div class="luker-studio-workspace luker_orch_director_block" data-luker-scope-root="${safeScope}" data-orch-mode-block="director">
    <div class="luker-studio-workspace-title" data-i18n="Director Orchestration">${escapeHtml(title || i18n('Director Orchestration'))}</div>
    <div class="luker-studio-workspace-col">
        <h4 data-i18n="Main agent">${escapeHtml(i18n('Main agent'))}</h4>
        <label>
            <span data-i18n="API preset (Connection profile)">${escapeHtml(i18n('API preset (Connection profile)'))}</span>
            <select class="text_pole" data-orch-director-field="mainAgent.apiPresetName" data-scope="${safeScope}">${renderConnectionProfileOptions(String(mainAgent.apiPresetName || ''), i18n('(Global orchestration API preset)'))}</select>
        </label>
        <label>
            <span data-i18n="Prompt preset">${escapeHtml(i18n('Prompt preset'))}</span>${renderPresetHelpButton({ kind: 'agent', agentMode: 'director' })}
            <select class="text_pole" data-orch-director-field="mainAgent.promptPresetName" data-scope="${safeScope}">${renderOpenAIPresetOptions(context, String(mainAgent.promptPresetName || ''), i18n('(Global orchestration prompt preset)'))}</select>
            <div class="director-preset-help" data-i18n="director_preset_help_pure_instruction">${escapeHtml(i18n('Pick a pure-instruction preset. Typical RP presets that prescribe an output format (forced CoT, mandatory schema blocks) will block the agent\'s tool calls.'))}</div>
        </label>
        <label>
            <span data-i18n="Main system prompt">${escapeHtml(i18n('Main system prompt'))}</span>
            <textarea class="text_pole textarea_compact" rows="6" data-orch-director-field="mainAgent.systemPrompt" data-scope="${safeScope}">${escapeHtml(String(mainAgent.systemPrompt || ''))}</textarea>
        </label>
        <div class="flex-container">
            <div class="menu_button menu_button_small" data-luker-action="director-reset-main-prompt" data-scope="${safeScope}" data-i18n="Reset to default">${escapeHtml(i18n('Reset to default'))}</div>
        </div>
        <details class="luker_orch_tools_section">
            <summary>${escapeHtml(i18n('Main agent tools'))}</summary>
            ${renderInheritOrOverridePanel(deps, safeScope, mainAgentTools, {
        dataAttrName: 'luker-director-mainagent-tool',
        overrideAction: 'director-mainagent-tools-override',
        resetAction: 'director-mainagent-tools-reset',
        inheritedTools: directorDefaultTools,
        kind: 'agent',
        includeCollab: true,
        profileCustomTools: profile?.customTools || null,
    })}
        </details>
        <details class="luker_orch_skills_section">
            <summary>${escapeHtml(i18n('Main agent skills'))}</summary>
            ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'director',
        level: 'agent',
        agentRef: 'main',
    }, i18n('Skills visible to the main agent. + inherits mode default.'))}
        </details>

        <h4 data-i18n="Limits">${escapeHtml(i18n('Limits'))}</h4>
        <label>
            <span data-i18n="Maximum tool-calling rounds">${escapeHtml(i18n('Maximum tool-calling rounds'))}</span>
            <input class="text_pole" type="number" min="1" step="1" data-orch-director-field="maxRounds" data-scope="${safeScope}" value="${escapeHtml(String(maxRounds))}" />
        </label>
        <label>
            <span data-i18n="Maximum concurrent sub-agents">${escapeHtml(i18n('Maximum concurrent sub-agents'))}</span>
            <input class="text_pole" type="number" min="1" step="1" data-orch-director-field="maxConcurrentSubagents" data-scope="${safeScope}" value="${escapeHtml(String(maxConcurrentSubagents))}" />
        </label>
        <label>
            <span data-i18n="Maximum total sub-agent runs per turn">${escapeHtml(i18n('Maximum total sub-agent runs per turn'))}</span>
            <input class="text_pole" type="number" min="1" step="1" data-orch-director-field="maxTotalSubagentRuns" data-scope="${safeScope}" value="${escapeHtml(String(maxTotalSubagentRuns))}" />
        </label>

        <label class="checkbox_label">
            <input type="checkbox" data-orch-director-field="discardOnAbort" data-scope="${safeScope}" ${discardOnAbort ? 'checked' : ''} />
            <span data-i18n="Discard partial message on abort">${escapeHtml(i18n('Discard partial message on abort'))}</span>
        </label>
    </div>
    <div class="luker-studio-workspace-col">
        <h4 data-i18n="Sub-agents">${escapeHtml(i18n('Sub-agents'))}</h4>
        <div data-orch-subagent-list>${subAgentRows}</div>
        <div class="luker-studio-add-row">
            <button class="menu_button menu_button_small" type="button" data-orch-add-subagent="1" data-scope="${safeScope}" data-i18n="Add sub-agent">${escapeHtml(i18n('Add sub-agent'))}</button>
        </div>
    </div>
</div>`;
    const toolsHtml = `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <details class="luker_orch_tools_section">
        <summary>${escapeHtml(i18n('Default tools for all agents'))}</summary>
        <div class="luker-studio-empty-hint">${escapeHtml(i18n('Each agent can override these defaults below. The main agent inherits unless it has its own override.'))}</div>
        ${renderToolFlagsGrid(deps, safeScope, directorDefaultTools || {}, 'luker-director-default-tool', {}, { includeCollab: true, profileCustomTools: profile?.customTools || null })}
        <div class="luker-studio-actions-row">
            <div class="menu_button menu_button_small" data-luker-action="director-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable all'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="director-default-tools-disable-all" data-scope="${safeScope}">${escapeHtml(i18n('Clear'))}</div>
        </div>
    </details>
    ${renderCustomToolsSection(deps, safeScope, 'director', profile?.customTools || [], (profile?.tools && profile.tools.custom) || {})}
    <details class="luker_orch_skills_section" open>
        <summary>${escapeHtml(i18n('Mode-level skills (baseline for every agent)'))}</summary>
        ${renderSkillChipsPlaceholder(deps, safeScope, {
        mode: 'director',
        level: 'mode',
    }, i18n('These visible/deny chips form the baseline every agent sees unless its own chips replace them. Per-agent chips can start with [+ inherit mode default] to extend rather than replace.'))}
    </details>
</div>`;
    return { agentsHtml, toolsHtml };
}

export function buildOrchestrationEditorPopupPanelHtml(deps, context, settings) {
    const {
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_DIRECTOR,
        ORCH_EXECUTION_MODE_LOOP,
        ORCH_EXECUTION_MODE_SINGLE,
        ORCH_EXECUTION_MODE_SPEC,
        escapeHtml,
        getCharacterAgendaOverrideByAvatar,
        getCharacterDirectorOverrideByAvatar,
        getCharacterDisplayNameByAvatar,
        getCharacterLoopOverrideByAvatar,
        getCharacterOverrideByAvatar,
        getCurrentAvatar,
        getDisplayedScope,
        getExecutionMode,
        getPopupEditingLabel,
        hasCharacterAgendaOverride,
        hasCharacterDirectorOverride,
        hasCharacterLoopOverride,
        hasCharacterSpecOverride,
        i18n,
        syncCharacterEditorWithActiveAvatar,
    } = deps;

    const IDPREFIX = 'orch-popup-';
    const s = baseId => scopeId(baseId, IDPREFIX);

    // Compute per-render context ONCE (was duplicated across four branches
    // in the pre-Task-10a builder). The topbar chip, actions bar
    // visibility, and editing-label all depend on the (scope, avatar,
    // active-mode) triple, not on which workspace renders.
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const hasActiveCharacter = Boolean(activeAvatar);
    const scope = getDisplayedScope(context, settings);
    const isCharacterScope = scope === 'character';
    const currentMode = settings && getExecutionMode ? getExecutionMode(settings) : '';

    // Resolve the per-mode "Editing:" label + execution-mode chip label
    // by mode. Falls through to spec-defaults so the (rare) case where
    // getExecutionMode returns an unknown value still renders.
    let editingLabel;
    let modeChipLabel;
    if (currentMode === ORCH_EXECUTION_MODE_DIRECTOR) {
        const directorOverride = activeAvatar ? getCharacterDirectorOverrideByAvatar(context, activeAvatar) : null;
        const hasDirectorCharacterOverride = hasCharacterDirectorOverride(context, activeAvatar);
        editingLabel = getPopupEditingLabel(isCharacterScope, hasDirectorCharacterOverride, Boolean(directorOverride?.enabled));
        modeChipLabel = i18n('Director (multi-agent)');
    } else if (currentMode === ORCH_EXECUTION_MODE_LOOP) {
        const loopOverride = activeAvatar ? getCharacterLoopOverrideByAvatar(context, activeAvatar) : null;
        const hasLoopCharacterOverride = hasCharacterLoopOverride(context, activeAvatar);
        editingLabel = getPopupEditingLabel(isCharacterScope, hasLoopCharacterOverride, Boolean(loopOverride?.enabled));
        modeChipLabel = i18n('Loop (single-agent loop)');
    } else if (currentMode === ORCH_EXECUTION_MODE_AGENDA) {
        const agendaOverride = activeAvatar ? getCharacterAgendaOverrideByAvatar(context, activeAvatar) : null;
        const hasAgendaCharacterOverride = hasCharacterAgendaOverride(context, activeAvatar);
        editingLabel = getPopupEditingLabel(isCharacterScope, hasAgendaCharacterOverride, Boolean(agendaOverride?.enabled));
        modeChipLabel = i18n('Agenda planner');
    } else if (currentMode === ORCH_EXECUTION_MODE_SINGLE) {
        editingLabel = getPopupEditingLabel(isCharacterScope, false, false);
        modeChipLabel = i18n('Single agent');
    } else {
        const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
        const hasSpecCharacterOverride = hasCharacterSpecOverride(context, activeAvatar);
        editingLabel = getPopupEditingLabel(isCharacterScope, hasSpecCharacterOverride, Boolean(override?.enabled));
        modeChipLabel = i18n('Spec workflow');
    }

    // Actions bar + per-mode copy buttons + view-last-run were previously
    // emitted inline here; Task 10b promotes them into `buildOrchTopbarHtml`
    // so drawer + popup share exactly one topbar renderer. The popup keeps
    // its own title+chips row for the "Orchestration Editor" heading; the
    // per-mode boards, preset selector bar, and actions bar all come
    // from the shared topbar helper below.

    const tabsHtml = renderLukerTabs({
        id: s('luker_orch_tabs'),
        scope: 'orchestrator-popup',
        moduleName: 'orchestrator',
        defaultTab: 'agents',
        tabs: [
            { key: 'agents',       label: i18n('Agents'),         contentHtml: buildAgentsTabHtml(deps, IDPREFIX) },
            { key: 'tools-skills', label: i18n('Tools & Skills'), contentHtml: buildToolsSkillsTabHtml(deps, IDPREFIX) },
            { key: 'general',      label: i18n('General'),        contentHtml: buildGeneralTabHtml(deps, IDPREFIX) },
        ],
    });

    return `
<div class="luker-studio luker_orch_editor_popup">
    <div class="luker-studio-editor-topbar">
        <div class="luker-studio-editor-topbar-left">
            <div class="luker-studio-editor-topbar-title">${escapeHtml(i18n('Orchestration Editor'))}</div>
            <div class="luker-studio-editor-topbar-meta">
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Current card:'))} <b>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Editing:'))} <b>${escapeHtml(editingLabel)}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Execution mode'))} <b>${escapeHtml(modeChipLabel)}</b></span>
            </div>
        </div>
    </div>
    ${buildOrchTopbarHtml(deps, { context, settings }, IDPREFIX)}
    ${tabsHtml}
</div>`;
}

/**
 * Populate the drawer's (or popup's) tab hosts with the runtime-scoped
 * workspace HTML for `mode`. Task 9 emitted empty tab-host divs
 * (`[data-orch-mode="X"][data-orch-tab-host="Y"]`) inside the Agents
 * and Tools & Skills tabs. This helper resolves the current editor
 * draft for `mode`, splits the legacy 2-column workspace into
 * `{agentsHtml, toolsHtml}`, and jQuery-injects each half into its
 * matching host.
 *
 * Single mode is NOT handled here: its Agents-tab content is emitted
 * statically at build time (the two single-agent textareas), and single
 * mode has no shared tools. Callers must not pass `'single'`.
 *
 * `idPrefix` is passed to the workspace renderers only for the popup
 * mirror (`'orch-popup-'`); drawer callers pass `''`. Workspace-level
 * legacy ids (e.g. `#luker_orch_agenda_planner_prompt`) are unscoped
 * for now — the popup handlers currently target the unscoped id via a
 * `#UI_BLOCK_ID #luker_orch_x, .luker_orch_editor_popup #luker_orch_x`
 * compound selector, so drawer + popup can share the same id string
 * without a per-handler rewrite. The parameter exists so that the
 * scoping migration is a mechanical thread-through, not a re-signature.
 *
 * @param {JQuery} root jQuery root of the drawer/popup container
 * @param {string} mode 'director' | 'agenda' | 'loop' | 'spec'
 * @param {Object} deps standard ui-templates deps bag (from `getOrchestratorUiTemplateDeps`)
 * @param {Object} context SillyTavern getContext() return
 * @param {Object} settings extension_settings.orchestrator
 * @param {string} [idPrefix] '' for drawer, 'orch-popup-' for popup
 */
export function injectWorkspaceIntoTabHost(root, mode, deps, context, settings, idPrefix = '') {
    const {
        getAgendaEditorByScope,
        getCurrentAvatar,
        getDirectorEditorByScope,
        getDisplayedScope,
        getEditorByScope,
        getLoopEditorByScope,
        getPopupEditingLabel,
        getProfileTitleForScope,
        hasCharacterAgendaOverride,
        hasCharacterDirectorOverride,
        hasCharacterLoopOverride,
        hasCharacterSpecOverride,
        syncCharacterEditorWithActiveAvatar,
    } = deps;

    // Belt-and-braces: keep the character-scope draft synced with the
    // active avatar before rendering. Popup + drawer both call this on
    // every re-render so an avatar swap between renders reflects.
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const scope = getDisplayedScope(context, settings);
    const isCharacterScope = scope === 'character';

    let editor;
    let profileTitle;
    if (mode === 'director') {
        editor = getDirectorEditorByScope(scope);
        const hasOverride = hasCharacterDirectorOverride(context, activeAvatar);
        profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasOverride);
    } else if (mode === 'agenda') {
        editor = getAgendaEditorByScope(scope);
        const hasOverride = hasCharacterAgendaOverride(context, activeAvatar);
        profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasOverride);
    } else if (mode === 'loop') {
        editor = getLoopEditorByScope(scope);
        const hasOverride = hasCharacterLoopOverride(context, activeAvatar);
        profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasOverride);
    } else if (mode === 'spec') {
        editor = getEditorByScope(scope);
        const hasOverride = hasCharacterSpecOverride(context, activeAvatar);
        profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasOverride);
    } else {
        // 'single' has no per-agent workspace — its Agents-tab content
        // is emitted at build time by buildAgentsTabHtml. Anything else
        // is a caller bug.
        console.warn(`[${MODULE_NAME}] injectWorkspaceIntoTabHost: unsupported mode "${mode}"`);
        return;
    }

    let split;
    if (mode === 'director') {
        split = renderDirectorWorkspace(deps, scope, editor, profileTitle);
    } else if (mode === 'agenda') {
        split = renderAgendaWorkspace(deps, scope, editor, profileTitle);
    } else if (mode === 'loop') {
        split = renderLoopWorkspace(deps, scope, editor, profileTitle);
    } else {
        split = renderEditorWorkspace(deps, scope, editor, profileTitle);
    }

    // The `idPrefix` parameter is threaded through so that Task 10b (or a
    // later touch) can flip the workspace renderers to scoped ids without
    // changing this function's signature or its callers. Right now the
    // workspace renderers ignore it (their ids are unscoped legacy).
    void idPrefix;

    const $agentsHost = root.find(`[data-orch-mode="${mode}"][data-orch-tab-host="agents"]`);
    const $toolsHost = root.find(`[data-orch-mode="${mode}"][data-orch-tab-host="tools-skills"]`);
    if ($agentsHost.length === 0 || $toolsHost.length === 0) {
        console.warn(`[${MODULE_NAME}] injectWorkspaceIntoTabHost: missing hosts for mode "${mode}" (agents=${$agentsHost.length}, tools=${$toolsHost.length})`);
        return;
    }
    // .html() replaces existing content, so repeated calls (mode change,
    // profile switch, override toggle) refresh the pane without accreting
    // stale DOM.
    $agentsHost.html(split.agentsHtml);
    $toolsHost.html(split.toolsHtml);
}

/**
 * Build the topbar shown above the tabs in the drawer (and mirrored by
 * the popup — Task 10). Merges the four previous per-mode board
 * variants (`#luker_orch_{spec,agenda,loop,director}_board`) into one
 * host with mode-conditional card indicator + override toggle blocks
 * plus a unified action bar. Each mode wrapper keeps its legacy id so
 * `renderDynamicPanels` (main.js) can continue toggling visibility via
 * `#luker_orch_<mode>_board` until Task 11 rewrites that logic to use
 * `data-orch-mode`.
 *
 * `idPrefix` is `''` for drawer callers and (Task 10) `'orch-popup-'`
 * for popup callers; passed through `scopeId()` for every element that
 * needs a mirror in the popup.
 */
/**
 * Shared action-button row for each per-mode board in the topbar.
 * Factored out of the four near-identical `<div class="flex-container">`
 * blocks in `buildOrchTopbarHtml`; toggles the two mode-specific
 * variations (copy-spec/agenda rows for spec+agenda; view-last-run for
 * every non-director mode).
 *
 * `idPrefix` gates the "Open in Popup" launcher — drawer callers pass
 * '' and get the launcher; popup callers pass 'orch-popup-' and the
 * launcher is omitted (already inside the popup).
 */
function commonActions(deps, idPrefix, { includeViewLastRun = true, includeCopyRows = false } = {}) {
    const { escapeHtml, i18n } = deps;
    const copyRows = includeCopyRows
        ? `<div class="menu_button" data-luker-action="agenda-copy-from-spec">${escapeHtml(i18n('Copy Spec Agents To Agenda'))}</div>
                <div class="menu_button" data-luker-action="spec-copy-from-agenda">${escapeHtml(i18n('Copy Agenda Agents To Spec'))}</div>`
        : '';
    const viewLastRun = includeViewLastRun
        ? `<div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>`
        : '';
    const openInPopup = idPrefix
        ? ''
        : `<div class="menu_button" data-luker-action="open-orch-editor-popup">${escapeHtml(i18n('Open in Popup'))}</div>`;
    return `${copyRows}
                ${viewLastRun}
                <div class="menu_button" data-luker-action="show-run-panel">${escapeHtml(i18n('Show Run Panel'))}</div>
                <div class="menu_button" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                <div class="menu_button" data-luker-action="manage-skills">${escapeHtml(i18n('Manage skills...'))}</div>
                ${openInPopup}`;
}

function buildOrchTopbarHtml(deps, ctx = {}, idPrefix = '') {
    const { escapeHtml, i18n, getExecutionMode, getDisplayedScope, getCurrentAvatar, getContext } = deps;
    const s = baseId => scopeId(baseId, idPrefix);
    // Self-source context/settings so the drawer callsite can pass an
    // empty `ctx` and let the topbar resolve state; popup callers pass
    // `{context, settings}` explicitly.
    const context = ctx.context || getContext();
    const settings = ctx.settings || getSettings();
    const currentMode = getExecutionMode ? getExecutionMode(settings) : '';
    const safeScope = getDisplayedScope ? getDisplayedScope(context, settings) : 'global';
    const activeAvatar = String((getCurrentAvatar && getCurrentAvatar(context)) || '').trim();
    const hasActiveCharacter = Boolean(activeAvatar);
    const isCharacterScope = safeScope === 'character';
    // Per-mode board layout: card indicator + override toggle on the
    // left, action button row on the right. Copy-spec/agenda buttons
    // only for spec+agenda; view-last-run omitted for director.
    const specBoard = `
        <div class="luker_orch_board" data-orch-mode="spec" style="display:none">
            <div>
                <small>${escapeHtml(i18n('Current card:'))} <span id="${s('luker_orch_profile_target')}">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                <small>${escapeHtml(i18n('Editing:'))} <span id="${s('luker_orch_profile_mode')}">${escapeHtml(i18n('Global profile'))}</span></small>
                <label id="${s('luker_orch_spec_override_toggle')}" class="checkbox_label luker_orch_override_toggle" style="display:none;margin-top:4px" title="${escapeHtml(i18n('Off uses the global profile and keeps the override stored on the card.'))}">
                    <input type="checkbox" id="${s('luker_orch_spec_override_enabled')}" />
                    <small>${escapeHtml(i18n('Use this card\'s override'))}</small>
                </label>
            </div>
            <div class="flex-container">
                ${commonActions(deps, idPrefix, { includeViewLastRun: true, includeCopyRows: true })}
            </div>
        </div>`;
    const agendaBoard = `
        <div class="luker_orch_board" style="display:none" data-orch-mode="agenda">
            <div>
                <small>${escapeHtml(i18n('Current card:'))} <span id="${s('luker_orch_agenda_profile_target')}">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                <small>${escapeHtml(i18n('Editing:'))} <span id="${s('luker_orch_agenda_profile_mode')}">${escapeHtml(i18n('Global profile'))}</span></small>
                <label id="${s('luker_orch_agenda_override_toggle')}" class="checkbox_label luker_orch_override_toggle" style="display:none;margin-top:4px" title="${escapeHtml(i18n('Off uses the global profile and keeps the override stored on the card.'))}">
                    <input type="checkbox" id="${s('luker_orch_agenda_override_enabled')}" />
                    <small>${escapeHtml(i18n('Use this card\'s override'))}</small>
                </label>
            </div>
            <div class="flex-container">
                ${commonActions(deps, idPrefix, { includeViewLastRun: true, includeCopyRows: true })}
            </div>
        </div>`;
    const loopBoard = `
        <div class="luker_orch_board" style="display:none" data-orch-mode="loop">
            <div>
                <small>${escapeHtml(i18n('Current card:'))} <span id="${s('luker_orch_loop_profile_target')}">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                <small>${escapeHtml(i18n('Editing:'))} <span id="${s('luker_orch_loop_profile_mode')}">${escapeHtml(i18n('Global profile'))}</span></small>
                <label id="${s('luker_orch_loop_override_toggle')}" class="checkbox_label luker_orch_override_toggle" style="display:none;margin-top:4px" title="${escapeHtml(i18n('Off uses the global profile and keeps the override stored on the card.'))}">
                    <input type="checkbox" id="${s('luker_orch_loop_override_enabled')}" />
                    <small>${escapeHtml(i18n('Use this card\'s override'))}</small>
                </label>
            </div>
            <div class="flex-container">
                ${commonActions(deps, idPrefix, { includeViewLastRun: true, includeCopyRows: false })}
            </div>
            <small>${escapeHtml(i18n('Loop mode runs a single agent that calls tools in a loop and finalizes when ready.'))}</small>
        </div>`;
    const directorBoard = `
        <div class="luker_orch_board" style="display:none" data-orch-mode="director">
            <div>
                <small><span>${escapeHtml(i18n('Current card:'))}</span> <span id="${s('luker_orch_director_profile_target')}">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                <small><span>${escapeHtml(i18n('Editing:'))}</span> <span id="${s('luker_orch_director_profile_mode')}">${escapeHtml(i18n('Global profile'))}</span></small>
                <label id="${s('luker_orch_director_override_toggle')}" class="checkbox_label luker_orch_override_toggle" style="display:none;margin-top:4px" title="${escapeHtml(i18n('Off uses the global profile and keeps the override stored on the card.'))}">
                    <input type="checkbox" id="${s('luker_orch_director_override_enabled')}" />
                    <small>${escapeHtml(i18n('Use this card\'s override'))}</small>
                </label>
            </div>
            <div class="flex-container">
                ${commonActions(deps, idPrefix, { includeViewLastRun: false, includeCopyRows: false })}
            </div>
            <small>${escapeHtml(i18n('Director mode produces the assistant message directly via a main agent that may dispatch sub-agents.'))}</small>
        </div>`;
    // Single-mode topbar block hosts the runtime tools row (view-last-run,
    // show-run-panel, manage-skills) and the descriptive hint. Kept in
    // the topbar because single mode has no per-agent board.
    const singleBlock = `
        <small id="${s('luker_orch_single_mode_hint')}" style="opacity:0.8" data-orch-mode="single">${escapeHtml(i18n('Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.'))}</small>
        <div id="${s('luker_orch_single_mode_runtime_tools')}" class="luker_orch_board luker_orch_single_mode_tools" data-orch-mode="single">
            <div class="flex-container">
                <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                <div class="menu_button" data-luker-action="show-run-panel">${escapeHtml(i18n('Show Run Panel'))}</div>
                <div class="menu_button" data-luker-action="manage-skills">${escapeHtml(i18n('Manage skills...'))}</div>
                ${idPrefix ? '' : `<div class="menu_button" data-luker-action="open-orch-editor-popup">${escapeHtml(i18n('Open in Popup'))}</div>`}
            </div>
        </div>`;

    // Preset selector bar — one wrapper per mode, mode-visibility gated
    // by `data-orch-mode` so mode-toggle logic reveals only the current
    // mode's bar. Promoted here from the four workspace helpers so both
    // drawer and popup render exactly one preset bar.
    const presetBarModes = ['spec', 'agenda', 'loop', 'director'];
    const presetBars = presetBarModes.map(mode => {
        const modeVisible = currentMode === mode ? '' : ' style="display:none"';
        return `<div data-orch-mode="${escapeHtml(mode)}"${modeVisible}>${renderPresetSelectorBar(deps, presetBarPropsFor(deps, mode, safeScope))}</div>`;
    }).join('');

    // Actions bar — profile-management actions promoted from the popup
    // workspace. `data-orch-mode-scope` marks the reload button as
    // mode-scoped for Task 11's dispatch. Save-to-character /
    // clear-character are conditional on the active character and
    // scope (matches popup semantics).
    const actionsBar = `
        <div class="luker-studio-actions-bar">
            <div class="menu_button" data-luker-action="reload-current" data-orch-mode-scope>${escapeHtml(i18n('Reload Current'))}</div>
            <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
            <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
            <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
            <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
            ${hasActiveCharacter ? `<div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>` : ''}
            ${hasActiveCharacter && isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
        </div>`;

    return `<div class="luker_orch_topbar">${specBoard}${agendaBoard}${loopBoard}${directorBoard}${singleBlock}${presetBars}${actionsBar}</div>`;
}

/**
 * Agents tab content — a wrapper containing one `data-orch-mode`
 * subtree per execution mode. Task 9 emits placeholder hosts; Task 11
 * populates them with the mode-specific workspace editors (mainAgent /
 * sub-agents / planner / loop-agent / single-agent) on mode change and
 * profile switch. The single-mode variant hosts the single-agent
 * system-prompt + user-prompt textareas moved out of the drawer's top
 * level (single mode has no per-agent list).
 */
function buildAgentsTabHtml(deps, idPrefix = '') {
    const { escapeHtml, i18n } = deps;
    const s = baseId => scopeId(baseId, idPrefix);
    return `<div class="luker_orch_agents_tab">
        <div data-orch-mode="spec" data-orch-tab-host="agents"></div>
        <div data-orch-mode="agenda" data-orch-tab-host="agents" style="display:none"></div>
        <div data-orch-mode="loop" data-orch-tab-host="agents" style="display:none"></div>
        <div data-orch-mode="director" data-orch-tab-host="agents" style="display:none"></div>
        <div id="${s('luker_orch_single_agent_fields')}" data-orch-mode="single" data-orch-tab-host="agents" style="display:none">
            <label for="${s('luker_orch_single_agent_system_prompt')}">${escapeHtml(i18n('Single-agent system prompt'))}</label>
            <textarea id="${s('luker_orch_single_agent_system_prompt')}" class="text_pole textarea_compact" rows="4"></textarea>
            <label for="${s('luker_orch_single_agent_user_prompt')}">${escapeHtml(i18n('Single-agent user prompt template'))}</label>
            <textarea id="${s('luker_orch_single_agent_user_prompt')}" class="text_pole textarea_compact" rows="6"></textarea>
        </div>
    </div>`;
}

/**
 * Tools & Skills tab content — placeholder hosts for mode-conditional
 * subtrees (default tool grid + mode-level skills + custom tools).
 * Task 11 will populate these hosts with the sections currently inline
 * in the workspace renderers. Single-mode variant is intentionally
 * empty (single mode has no shared tools).
 */
function buildToolsSkillsTabHtml(deps, idPrefix = '') {
    const { escapeHtml, i18n } = deps;
    return `<div class="luker_orch_tools_skills_tab">
        <div data-orch-mode="spec" data-orch-tab-host="tools-skills"></div>
        <div data-orch-mode="agenda" data-orch-tab-host="tools-skills" style="display:none"></div>
        <div data-orch-mode="loop" data-orch-tab-host="tools-skills" style="display:none"></div>
        <div data-orch-mode="director" data-orch-tab-host="tools-skills" style="display:none"></div>
        <div data-orch-mode="single" data-orch-tab-host="tools-skills" style="display:none">
            <small style="opacity:0.7">${escapeHtml(i18n('Single-agent mode has no shared tools.'))}</small>
        </div>
    </div>`;
}

/**
 * General tab content — 4 fieldsets:
 *  1. Default API and prompt preset (LLM node global fallback)
 *  2. Runtime limits (mode-conditional: nodeIterationMaxRounds for
 *     agenda+spec, reviewRerunMaxRounds for spec only; director-only
 *     and loop-only mode-specific limits live in their workspace
 *     editors and are populated by Task 11)
 *  3. Capsule injection (`data-orch-mode-block="capsule"` — hidden in
 *     director mode by existing `renderDynamicPanels` toggle on
 *     `#luker_orch_capsule_settings`)
 *  4. AI Iteration Studio configuration (iteration AI presets, base
 *     system prompt, and one iter-mode-prompt textarea per mode with
 *     `data-orch-mode` visibility)
 */
function buildGeneralTabHtml(deps, idPrefix = '') {
    const { escapeHtml, extension_prompt_roles, i18n, world_info_position } = deps;
    const s = baseId => scopeId(baseId, idPrefix);
    return `<div class="luker_orch_general_tab">
        <fieldset class="luker_orch_general_fieldset">
            <legend>${escapeHtml(i18n('Default API and prompt preset'))}</legend>
            <label for="${s('luker_orch_llm_api_preset')}">${escapeHtml(i18n('LLM node API preset (Connection profile)'))}</label>
            <select id="${s('luker_orch_llm_api_preset')}" class="text_pole"></select>
            <label for="${s('luker_orch_llm_preset')}">${escapeHtml(i18n('LLM node preset (params + prompt)'))}${renderPresetHelpButton({ kind: 'agent', agentMode: 'dynamic', targetSelectId: s('luker_orch_llm_preset') })}</label>
            <select id="${s('luker_orch_llm_preset')}" class="text_pole"></select>
            <small style="opacity:0.8">${escapeHtml(i18n('Used when a specific agent has no preset filled in'))}</small>
        </fieldset>
        <fieldset class="luker_orch_general_fieldset">
            <legend>${escapeHtml(i18n('Runtime limits'))}</legend>
            <div data-orch-mode="spec">
                <label for="${s('luker_orch_node_iterations')}">${escapeHtml(i18n('Node tool iteration max rounds (N)'))}</label>
                <input id="${s('luker_orch_node_iterations')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_review_reruns')}">${escapeHtml(i18n('Review rerun max rounds (N)'))}</label>
                <input id="${s('luker_orch_review_reruns')}" class="text_pole" type="number" min="0" step="1" />
            </div>
            <div data-orch-mode="director" style="display:none">
                <label for="${s('luker_orch_director_max_rounds')}">${escapeHtml(i18n('Maximum tool-calling rounds'))}</label>
                <input id="${s('luker_orch_director_max_rounds')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_director_max_concurrent_subagents')}">${escapeHtml(i18n('Maximum concurrent sub-agents'))}</label>
                <input id="${s('luker_orch_director_max_concurrent_subagents')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_director_max_total_subagent_runs')}">${escapeHtml(i18n('Maximum total sub-agent runs per turn'))}</label>
                <input id="${s('luker_orch_director_max_total_subagent_runs')}" class="text_pole" type="number" min="1" step="1" />
                <label class="checkbox_label">
                    <input id="${s('luker_orch_director_discard_on_abort')}" type="checkbox" />
                    <span>${escapeHtml(i18n('Discard partial message on abort'))}</span>
                </label>
            </div>
            <div data-orch-mode="agenda" style="display:none">
                <label for="${s('luker_orch_agenda_planner_max_rounds')}">${escapeHtml(i18n('Planner max rounds'))}</label>
                <input id="${s('luker_orch_agenda_planner_max_rounds')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_agenda_max_concurrent_agents')}">${escapeHtml(i18n('Max concurrent agents'))}</label>
                <input id="${s('luker_orch_agenda_max_concurrent_agents')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_agenda_max_total_runs')}">${escapeHtml(i18n('Max total agent runs'))}</label>
                <input id="${s('luker_orch_agenda_max_total_runs')}" class="text_pole" type="number" min="1" step="1" />
            </div>
            <div data-orch-mode="loop" style="display:none">
                <label for="${s('luker_orch_loop_max_rounds')}">${escapeHtml(i18n('Loop max rounds'))}</label>
                <input id="${s('luker_orch_loop_max_rounds')}" class="text_pole" type="number" min="1" step="1" />
                <label for="${s('luker_orch_loop_wall_clock_budget')}">${escapeHtml(i18n('Loop wall-clock budget (seconds)'))}</label>
                <input id="${s('luker_orch_loop_wall_clock_budget')}" class="text_pole" type="number" min="10" step="1" />
            </div>
            <div data-orch-mode="single" style="display:none">
                <small style="opacity:0.6">${escapeHtml(i18n('Single-agent mode has no per-mode runtime limits; cross-mode caps below apply.'))}</small>
            </div>
        </fieldset>
        <fieldset class="luker_orch_general_fieldset" data-orch-mode-block="capsule">
            <legend>${escapeHtml(i18n('Capsule injection'))}</legend>
            <div id="${s('luker_orch_capsule_settings')}">
                <label for="${s('luker_orch_capsule_position')}">${escapeHtml(i18n('Injection position'))}</label>
                <select id="${s('luker_orch_capsule_position')}" class="text_pole">
                    <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
                    <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
                    <option value="${world_info_position.ANTop}">${escapeHtml(i18n('Before Author\'s Note'))}</option>
                    <option value="${world_info_position.ANBottom}">${escapeHtml(i18n('After Author\'s Note'))}</option>
                    <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
                    <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
                    <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
                </select>
                <label for="${s('luker_orch_capsule_depth')}">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
                <input id="${s('luker_orch_capsule_depth')}" class="text_pole" type="number" min="0" step="1" />
                <label for="${s('luker_orch_capsule_role')}">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
                <select id="${s('luker_orch_capsule_role')}" class="text_pole">
                    <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                    <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                    <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
                </select>
                <label for="${s('luker_orch_capsule_custom_instruction')}">${escapeHtml(i18n('Custom orchestration result instruction (prepended before analysis)'))}</label>
                <textarea id="${s('luker_orch_capsule_custom_instruction')}" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('e.g. Follow this guidance first, then write final reply in-character.'))}"></textarea>
            </div>
        </fieldset>
        <fieldset class="luker_orch_general_fieldset">
            <legend>${escapeHtml(i18n('AI Iteration Studio configuration'))}</legend>
            <label for="${s('luker_orch_request_api_preset')}">${escapeHtml(i18n('Iteration AI API preset (Connection profile)'))}</label>
            <select id="${s('luker_orch_request_api_preset')}" class="text_pole"></select>
            <label for="${s('luker_orch_request_llm_preset')}">${escapeHtml(i18n('Iteration AI prompt preset (params + prompt)'))}${renderPresetHelpButton({ kind: 'iteration', targetSelectId: s('luker_orch_request_llm_preset') })}</label>
            <select id="${s('luker_orch_request_llm_preset')}" class="text_pole"></select>
            <label class="checkbox_label">
                <input id="${s('luker_orch_include_world_info')}" type="checkbox" />
                ${escapeHtml(i18n('Include world info'))}
            </label>
            <label for="${s('luker_orch_request_system_prompt')}">${escapeHtml(i18n('Iteration AI base system prompt'))}</label>
            <textarea id="${s('luker_orch_request_system_prompt')}" class="text_pole textarea_compact" rows="6"></textarea>
            <div class="flex-container">
                <div id="${s('luker_orch_reset_ai_prompt')}" class="menu_button menu_button_small">${escapeHtml(i18n('Reset AI build prompt'))}</div>
            </div>
            <div data-orch-mode="spec">
                <label for="${s('luker_orch_iter_mode_prompt_spec')}">${escapeHtml(i18n('Spec mode iteration prompt'))}</label>
                <textarea id="${s('luker_orch_iter_mode_prompt_spec')}" class="text_pole textarea_compact" rows="10"></textarea>
                <div class="flex-container">
                    <div id="${s('luker_orch_reset_iter_mode_spec')}" class="menu_button menu_button_small">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </div>
            <div data-orch-mode="loop" style="display:none">
                <label for="${s('luker_orch_iter_mode_prompt_loop')}">${escapeHtml(i18n('Loop mode iteration prompt'))}</label>
                <textarea id="${s('luker_orch_iter_mode_prompt_loop')}" class="text_pole textarea_compact" rows="10"></textarea>
                <div class="flex-container">
                    <div id="${s('luker_orch_reset_iter_mode_loop')}" class="menu_button menu_button_small">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </div>
            <div data-orch-mode="director" style="display:none">
                <label for="${s('luker_orch_iter_mode_prompt_director')}">${escapeHtml(i18n('Director mode iteration prompt'))}</label>
                <textarea id="${s('luker_orch_iter_mode_prompt_director')}" class="text_pole textarea_compact" rows="10"></textarea>
                <div class="flex-container">
                    <div id="${s('luker_orch_reset_iter_mode_director')}" class="menu_button menu_button_small">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </div>
            <div data-orch-mode="agenda" style="display:none">
                <label for="${s('luker_orch_iter_mode_prompt_agenda')}">${escapeHtml(i18n('Agenda mode iteration prompt'))}</label>
                <textarea id="${s('luker_orch_iter_mode_prompt_agenda')}" class="text_pole textarea_compact" rows="10"></textarea>
                <div class="flex-container">
                    <div id="${s('luker_orch_reset_iter_mode_agenda')}" class="menu_button menu_button_small">${escapeHtml(i18n('Reset to default'))}</div>
                </div>
            </div>
        </fieldset>
    </div>`;
}

export function buildOrchestratorSettingsHtml(deps) {
    const {
        escapeHtml,
        i18n,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_DIRECTOR,
        ORCH_EXECUTION_MODE_LOOP,
        ORCH_EXECUTION_MODE_SINGLE,
        ORCH_EXECUTION_MODE_SPEC,
        UI_BLOCK_ID,
    } = deps;
    const tabsHtml = renderLukerTabs({
        id: 'luker_orch_tabs',
        scope: 'orchestrator-drawer',
        moduleName: 'orchestrator',
        defaultTab: 'agents',
        tabs: [
            { key: 'agents',       label: i18n('Agents'),         contentHtml: buildAgentsTabHtml(deps, '') },
            { key: 'tools-skills', label: i18n('Tools & Skills'), contentHtml: buildToolsSkillsTabHtml(deps, '') },
            { key: 'general',      label: i18n('General'),        contentHtml: buildGeneralTabHtml(deps, '') },
        ],
    });
    return `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Orchestrator'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="luker_orch_enabled" type="checkbox" /> ${escapeHtml(i18n('Enabled'))}</label>
            <label for="luker_orch_execution_mode">${escapeHtml(i18n('Execution mode'))}</label>
            <select id="luker_orch_execution_mode" class="text_pole">
                <option value="${ORCH_EXECUTION_MODE_SPEC}">${escapeHtml(i18n('Spec workflow'))}</option>
                <option value="${ORCH_EXECUTION_MODE_SINGLE}">${escapeHtml(i18n('Single agent'))}</option>
                <option value="${ORCH_EXECUTION_MODE_AGENDA}">${escapeHtml(i18n('Agenda planner'))}</option>
                <option value="${ORCH_EXECUTION_MODE_LOOP}">${escapeHtml(i18n('Loop (single-agent loop)'))}</option>
                <option value="${ORCH_EXECUTION_MODE_DIRECTOR}" data-i18n="Director (multi-agent)">${escapeHtml(i18n('Director (multi-agent)'))}</option>
            </select>
            ${buildOrchTopbarHtml(deps, {}, '')}
            ${tabsHtml}
            <hr />
            <label for="luker_orch_max_recent_messages">${escapeHtml(i18n('Recent assistant turns for orchestration (N)'))}</label>
            <input id="luker_orch_max_recent_messages" class="text_pole" type="number" min="1" step="1" />
            <label for="luker_orch_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="luker_orch_tool_retries" class="text_pole" type="number" min="0" step="1" />
            <label for="luker_orch_rpm_limit">${escapeHtml(i18n('RPM limit (0 = unlimited)'))}</label>
            <input id="luker_orch_rpm_limit" class="text_pole" type="number" min="0" step="1" />
            <small id="luker_orch_last_run_state" class="luker_orch_state_summary"></small>
            <small id="luker_orch_status" style="opacity:0.8"></small>
        </div>
    </div>
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Notes'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="orchestrator-notes-host"></div>
        </div>
    </div>
</div>`;
}

/**
 * HTML template for the Notes panel (consumed by `notes-panel.js` in
 * `mountNotesPanel`). Contains:
 *  - the panel root with header (title + tab switcher between Open / Closed)
 *  - the empty list placeholder shown when no notes are present
 *  - a `<template id="luker-notes-row-template">` cloned per row by the panel
 *  - a `<template id="luker-notes-close-dialog-template">` cloned when the user
 *    clicks the per-row "Close" action (the close-dialog flow asks for an
 *    optional closure reason before invoking `updateStatusById`)
 *
 * All user-visible strings carry `data-i18n=` for the i18n system.
 * Translations live in `i18n/zh-{cn,tw}.json` (Task 13).
 */
export const NOTES_PANEL_TEMPLATE = `
<div class="luker-notes-panel" id="luker-notes-panel">
    <div class="luker-notes-panel__header">
        <h3 data-i18n="Notes">Notes</h3>
        <div class="luker-notes-panel__tabs">
            <button class="luker-notes-tab is-active" data-tab="open" data-i18n="Open notes">Open notes</button>
            <button class="luker-notes-tab" data-tab="closed" data-i18n="Closed notes">Closed notes</button>
        </div>
    </div>
    <ul class="luker-notes-list" id="luker-notes-list">
        <li class="luker-notes-empty" data-i18n="No open notes yet">No open notes yet</li>
    </ul>
</div>
<template id="luker-notes-row-template">
    <li class="luker-notes-row" data-id="">
        <div class="luker-notes-row__text" contenteditable="false"></div>
        <div class="luker-notes-row__reason" hidden></div>
        <div class="luker-notes-row__actions">
            <button class="luker-notes-action luker-notes-action--close" data-action="close" data-i18n="Close this note">Close this note</button>
            <button class="luker-notes-action luker-notes-action--edit" data-action="edit" data-i18n="Edit note">Edit note</button>
            <button class="luker-notes-action luker-notes-action--danger" data-action="delete" data-i18n="Delete note (permanent)">Delete note (permanent)</button>
        </div>
    </li>
</template>
<template id="luker-notes-close-dialog-template">
    <div class="luker-notes-close-dialog">
        <label data-i18n="Closure reason (optional)">Closure reason (optional)</label>
        <textarea class="luker-notes-close-reason"></textarea>
        <button class="luker-notes-close-confirm" data-i18n="Close this note">Close this note</button>
    </div>
</template>
`;
