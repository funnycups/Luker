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
 */
function renderToolFlagsGrid(deps, scope, tools, dataAttrName, extraAttrs = {}) {
    const { escapeHtml, i18n } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const safe = tools && typeof tools === 'object' ? tools : {};
    const note = safe.note || {};
    const chat = safe.chat || {};
    const lorebook = safe.lorebook || {};
    const memory = safe.memory || {};
    const search = safe.search || {};
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
    ${cb('lorebook.search', lorebook.search, 'lorebook_search')}
    ${cb('lorebook.get', lorebook.get, 'lorebook_get')}
</fieldset>
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('memory (memory-graph)'))}</legend>
    ${cb('memory.schema', memory.schema, 'memory_schema')}
    ${cb('memory.list_candidates', memory.list_candidates, 'memory_list_candidates')}
    ${cb('memory.edge_summary', memory.edge_summary, 'memory_edge_summary')}
    ${cb('memory.node_brief', memory.node_brief, 'memory_node_brief')}
    ${cb('memory.expand_seeds', memory.expand_seeds, 'memory_expand_seeds')}
    ${cb('memory.keyword_search', memory.keyword_search, 'memory_keyword_search')}
    ${cb('memory.vector_search', memory.vector_search, 'memory_vector_search')}
    ${cb('memory.find_by_name', memory.find_by_name, 'memory_find_by_name')}
    ${cb('memory.compaction_candidates', memory.compaction_candidates, 'memory_compaction_candidates')}
    ${cb('memory.node_create', memory.node_create, 'memory_node_create')}
    ${cb('memory.node_edit', memory.node_edit, 'memory_node_edit')}
    ${cb('memory.node_delete', memory.node_delete, 'memory_node_delete')}
    ${cb('memory.link_upsert', memory.link_upsert, 'memory_link_upsert')}
    ${cb('memory.link_delete', memory.link_delete, 'memory_link_delete')}
    ${cb('memory.compact_nodes', memory.compact_nodes, 'memory_compact_nodes')}
</fieldset>
<fieldset class="luker_orch_loop_tools_group">
    <legend>${escapeHtml(i18n('search (web search)'))}</legend>
    ${cb('search.search', search.search, 'search_search')}
    ${cb('search.visit', search.visit, 'search_visit')}
</fieldset>`;
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
    ${renderToolFlagsGrid(deps, scope, tools, dataAttrName, extraAttrs)}
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
    })}
    </details>
</div>`).join('');
}

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
    return `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title || i18n('Agenda Orchestration'))}</div>
    <div class="luker-studio-workspace-grid">
        <div class="luker-studio-workspace-col">
            <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Planner Prompt'))}</div>
            <label for="luker_orch_agenda_planner_api_preset">${escapeHtml(i18n('Planner API preset (Connection profile, empty = global orchestration API preset)'))}</label>
            <select id="luker_orch_agenda_planner_api_preset" data-scope="${safeScope}" class="text_pole">${renderConnectionProfileOptions(planner?.apiPresetName, i18n('(Global orchestration API preset)'))}</select>
            <label for="luker_orch_agenda_planner_prompt_preset">${escapeHtml(i18n('Planner preset (params + prompt, empty = global orchestration preset)'))}</label>
            <select id="luker_orch_agenda_planner_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, planner?.promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
            <label for="luker_orch_agenda_planner_system_prompt">${escapeHtml(i18n('Planner system prompt'))}</label>
            <textarea id="luker_orch_agenda_planner_system_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="5">${escapeHtml(String(planner?.systemPrompt || DEFAULT_AGENDA_PLANNER_SYSTEM_PROMPT))}</textarea>
            <label for="luker_orch_agenda_planner_prompt">${escapeHtml(i18n('Planner Prompt'))}</label>
            <textarea id="luker_orch_agenda_planner_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="16">${escapeHtml(String(planner?.userPromptTemplate || DEFAULT_AGENDA_PLANNER_PROMPT))}</textarea>
            <label for="luker_orch_agenda_final_agent">${escapeHtml(i18n('Final Agent'))}</label>
            <select id="luker_orch_agenda_final_agent" data-scope="${safeScope}" class="text_pole">${renderAgendaAgentSelectOptions(deps, editor, editor?.finalAgentId)}</select>
            <label for="luker_orch_agenda_planner_rounds">${escapeHtml(i18n('Planner max rounds'))}</label>
            <input id="luker_orch_agenda_planner_rounds" data-scope="${safeScope}" class="text_pole" type="number" min="1" max="20" step="1" value="${escapeHtml(String(editor?.limits?.plannerMaxRounds || 6))}" />
            <label for="luker_orch_agenda_max_concurrent">${escapeHtml(i18n('Max concurrent agents'))}</label>
            <input id="luker_orch_agenda_max_concurrent" data-scope="${safeScope}" class="text_pole" type="number" min="1" max="12" step="1" value="${escapeHtml(String(editor?.limits?.maxConcurrentAgents || 3))}" />
            <label for="luker_orch_agenda_max_total_runs">${escapeHtml(i18n('Max total agent runs'))}</label>
            <input id="luker_orch_agenda_max_total_runs" data-scope="${safeScope}" class="text_pole" type="number" min="1" max="200" step="1" value="${escapeHtml(String(editor?.limits?.maxTotalRuns || 24))}" />
        </div>
        <div class="luker-studio-workspace-col">
            <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Agenda Agents'))}</div>
            <details class="luker_orch_tools_section">
                <summary>${escapeHtml(i18n('Default tools for all agents'))}</summary>
                <div class="luker-studio-empty-hint">${escapeHtml(i18n('Each agent can override these defaults below. Leave empty to keep tools off for all agents.'))}</div>
                ${editor?.defaultTools
        ? `${renderToolFlagsGrid(deps, safeScope, editor.defaultTools, 'luker-agenda-default-tool')}
                <div class="luker-studio-actions-row">
                    <div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable all'))}</div>
                    <div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-disable-all" data-scope="${safeScope}">${escapeHtml(i18n('Clear'))}</div>
                </div>`
        : `<div class="menu_button menu_button_small" data-luker-action="agenda-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable defaults'))}</div>`}
            </details>
            <div>${renderAgendaAgentBoard(deps, safeScope, editor)}</div>
            <div class="luker-studio-add-row">
                <input class="text_pole" data-luker-agenda-new-agent="${safeScope}" placeholder="${escapeHtml(i18n('new_preset_id'))}" />
                <div class="menu_button menu_button_small" data-luker-action="agenda-agent-add" data-scope="${safeScope}">${escapeHtml(i18n('Add Preset'))}</div>
            </div>
        </div>
    </div>
</div>`;
}

export function renderEditorWorkspace(deps, scope, editor, title) {
    const { escapeHtml, i18n, renderPresetBoard, renderWorkflowBoard } = deps;
    const safeScope = scope === 'character' ? 'character' : 'global';
    const specDefaultTools = editor?.spec?.defaultTools || null;
    return `
<div class="luker-studio-workspace" data-luker-scope-root="${scope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title)}</div>
    <div class="luker-studio-workspace-grid">
        <div class="luker-studio-workspace-col">
            <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Workflow'))}</div>
            <details class="luker_orch_tools_section">
                <summary>${escapeHtml(i18n('Default tools for all nodes'))}</summary>
                <div class="luker-studio-empty-hint">${escapeHtml(i18n('Each node can override these defaults below. Leave empty to keep tools off for all nodes.'))}</div>
                ${specDefaultTools
        ? `${renderToolFlagsGrid(deps, safeScope, specDefaultTools, 'luker-spec-default-tool')}
                <div class="luker-studio-actions-row">
                    <div class="menu_button menu_button_small" data-luker-action="spec-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable all'))}</div>
                    <div class="menu_button menu_button_small" data-luker-action="spec-default-tools-disable-all" data-scope="${safeScope}">${escapeHtml(i18n('Clear'))}</div>
                </div>`
        : `<div class="menu_button menu_button_small" data-luker-action="spec-default-tools-enable-all" data-scope="${safeScope}">${escapeHtml(i18n('Enable defaults'))}</div>`}
            </details>
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
    </div>
</div>`;
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
    const memory = tools.memory || {};
    const search = tools.search || {};
    const wallClockSeconds = Math.max(10, Math.round(Number(editor?.wall_clock_budget_ms || 300000) / 1000));
    const checkbox = (id, field, label, disabled = false, checked = null) => {
        const isChecked = checked === null ? Boolean(field) : Boolean(checked);
        return `<label class="checkbox_label">
            <input type="checkbox" data-luker-loop-tool="${escapeHtml(id)}" data-scope="${safeScope}" ${isChecked ? 'checked' : ''}${disabled ? ' disabled' : ''} />
            ${escapeHtml(label)}
        </label>`;
    };
    return `
<div class="luker-studio-workspace" data-luker-scope-root="${safeScope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title || i18n('Loop Orchestration'))}</div>
    <div class="luker-studio-workspace-grid">
        <div class="luker-studio-workspace-col">
            <div class="luker-studio-workspace-col-title">${escapeHtml(i18n('Loop Agent'))}</div>
            <label for="luker_orch_loop_api_preset">${escapeHtml(i18n('Loop API preset (Connection profile, empty = global orchestration API preset)'))}</label>
            <select id="luker_orch_loop_api_preset" data-scope="${safeScope}" class="text_pole">${renderConnectionProfileOptions(editor?.apiPresetName, i18n('(Global orchestration API preset)'))}</select>
            <label for="luker_orch_loop_prompt_preset">${escapeHtml(i18n('Loop preset (params + prompt, empty = global orchestration preset)'))}</label>
            <select id="luker_orch_loop_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, editor?.promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
            <label for="luker_orch_loop_system_prompt">${escapeHtml(i18n('Loop system prompt'))}</label>
            <textarea id="luker_orch_loop_system_prompt" data-scope="${safeScope}" class="text_pole textarea_compact" rows="14">${escapeHtml(String(editor?.system_prompt || ''))}</textarea>
            <label for="luker_orch_loop_max_rounds">${escapeHtml(i18n('Loop max rounds'))}</label>
            <input id="luker_orch_loop_max_rounds" data-scope="${safeScope}" class="text_pole" type="number" min="1" max="50" step="1" value="${escapeHtml(String(editor?.max_rounds || 20))}" />
            <label for="luker_orch_loop_wall_clock">${escapeHtml(i18n('Loop wall-clock budget (seconds)'))}</label>
            <input id="luker_orch_loop_wall_clock" data-scope="${safeScope}" class="text_pole" type="number" min="10" max="3600" step="1" value="${escapeHtml(String(wallClockSeconds))}" />
        </div>
        <div class="luker-studio-workspace-col">
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
                ${checkbox('lorebook.search', lorebook.search, 'lorebook_search')}
                ${checkbox('lorebook.get', lorebook.get, 'lorebook_get')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('memory (memory-graph)'))}</legend>
                ${checkbox('memory.schema', memory.schema, 'memory_schema')}
                ${checkbox('memory.list_candidates', memory.list_candidates, 'memory_list_candidates')}
                ${checkbox('memory.edge_summary', memory.edge_summary, 'memory_edge_summary')}
                ${checkbox('memory.node_brief', memory.node_brief, 'memory_node_brief')}
                ${checkbox('memory.expand_seeds', memory.expand_seeds, 'memory_expand_seeds')}
                ${checkbox('memory.keyword_search', memory.keyword_search, 'memory_keyword_search')}
                ${checkbox('memory.vector_search', memory.vector_search, 'memory_vector_search')}
                ${checkbox('memory.find_by_name', memory.find_by_name, 'memory_find_by_name')}
                ${checkbox('memory.compaction_candidates', memory.compaction_candidates, 'memory_compaction_candidates')}
                ${checkbox('memory.node_create', memory.node_create, 'memory_node_create')}
                ${checkbox('memory.node_edit', memory.node_edit, 'memory_node_edit')}
                ${checkbox('memory.node_delete', memory.node_delete, 'memory_node_delete')}
                ${checkbox('memory.link_upsert', memory.link_upsert, 'memory_link_upsert')}
                ${checkbox('memory.link_delete', memory.link_delete, 'memory_link_delete')}
                ${checkbox('memory.compact_nodes', memory.compact_nodes, 'memory_compact_nodes')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('search (web search)'))}</legend>
                ${checkbox('search.search', search.search, 'search_search')}
                ${checkbox('search.visit', search.visit, 'search_visit')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('terminator'))}</legend>
                ${checkbox('finalize', true, `finalize  ${i18n('(forced on)')}`, true, true)}
            </fieldset>
        </div>
    </div>
</div>`;
}

/**
 * Render a single sub-agent row for the director editor. Each row binds
 * its inputs to the position-keyed sub-agent entry under
 * `profile.director.subAgents[subagentIndex]`; the main.js binders use
 * `data-subagent-index` to locate the entry. Empty `id` / `systemPrompt`
 * are normal in-flight (the sanitizer only drops them at runtime), so
 * the renderer does not validate.
 */
function renderDirectorSubAgentRow(deps, scope, subagent, subagentIndex) {
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
        <span data-i18n="API preset">${escapeHtml(i18n('API preset'))}</span>
        <select class="text_pole" data-orch-subagent-field="apiPresetName" data-subagent-index="${subagentIndex}" data-scope="${safeScope}">${renderConnectionProfileOptions(apiPresetName, i18n('(Global orchestration API preset)'))}</select>
    </label>
    <label>
        <span data-i18n="Prompt preset">${escapeHtml(i18n('Prompt preset'))}</span>
        <select class="text_pole" data-orch-subagent-field="promptPresetName" data-subagent-index="${subagentIndex}" data-scope="${safeScope}" data-director-preset-select="subagent">${renderOpenAIPresetOptions(context, promptPresetName, i18n('(Global orchestration prompt preset)'))}</select>
        <div class="director-preset-help" data-i18n="director_preset_help_pure_instruction">${escapeHtml(i18n('Pick a pure-instruction preset (jailbreak / NSFW / style guide). Director provides character / persona / world info / chat history separately; a normal RP preset will duplicate that content.'))}</div>
        <div class="director-preset-warning displayNone" data-director-preset-warning="subagent" data-i18n="director_preset_warning_content_prompts">${escapeHtml(i18n('This preset contains content prompts (character / persona / WI / chat) which director already provides. Consider a pure-instruction preset to avoid duplication.'))}</div>
    </label>
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
 * (dot-path under `profile.director.*`) and
 * `[data-orch-subagent-field=...]` (indexed by `data-subagent-index`).
 * `[data-orch-add-subagent]` / `[data-orch-remove-subagent]` mutate
 * `profile.director.subAgents` and trigger a full popup re-render so
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
    const director = (profile && typeof profile === 'object' && profile.director && typeof profile.director === 'object')
        ? profile.director
        : {};
    const mainAgent = director.mainAgent && typeof director.mainAgent === 'object' ? director.mainAgent : {};
    const subAgents = Array.isArray(director.subAgents) ? director.subAgents : [];
    const maxRounds = Number.isFinite(Number(director.maxRounds)) ? Number(director.maxRounds) : 20;
    const maxConcurrentSubagents = Number.isFinite(Number(director.maxConcurrentSubagents)) ? Number(director.maxConcurrentSubagents) : 4;
    const maxTotalSubagentRuns = Number.isFinite(Number(director.maxTotalSubagentRuns)) ? Number(director.maxTotalSubagentRuns) : 16;
    const discardOnAbort = Boolean(director.discardOnAbort);
    const context = getContext();
    const subAgentRows = subAgents.length === 0
        ? `<div class="luker-studio-empty-hint">${escapeHtml(i18n('No sub-agents yet.'))}</div>`
        : subAgents.map((subagent, index) => renderDirectorSubAgentRow(deps, safeScope, subagent, index)).join('');
    return `
<div class="luker-studio-workspace luker_orch_director_block" data-luker-scope-root="${safeScope}" data-orch-mode-block="director">
    <div class="luker-studio-workspace-title" data-i18n="Director Orchestration">${escapeHtml(title || i18n('Director Orchestration'))}</div>
    <div class="luker-studio-workspace-grid">
        <div class="luker-studio-workspace-col">
            <h4 data-i18n="Main agent">${escapeHtml(i18n('Main agent'))}</h4>
            <label>
                <span data-i18n="API preset">${escapeHtml(i18n('API preset'))}</span>
                <select class="text_pole" data-orch-director-field="mainAgent.apiPresetName" data-scope="${safeScope}">${renderConnectionProfileOptions(String(mainAgent.apiPresetName || ''), i18n('(Global orchestration API preset)'))}</select>
            </label>
            <label>
                <span data-i18n="Prompt preset">${escapeHtml(i18n('Prompt preset'))}</span>
                <select class="text_pole" data-orch-director-field="mainAgent.promptPresetName" data-scope="${safeScope}" data-director-preset-select="main">${renderOpenAIPresetOptions(context, String(mainAgent.promptPresetName || ''), i18n('(Global orchestration prompt preset)'))}</select>
                <div class="director-preset-help" data-i18n="director_preset_help_pure_instruction">${escapeHtml(i18n('Pick a pure-instruction preset (jailbreak / NSFW / style guide). Director provides character / persona / world info / chat history separately; a normal RP preset will duplicate that content.'))}</div>
                <div class="director-preset-warning displayNone" data-director-preset-warning="main" data-i18n="director_preset_warning_content_prompts">${escapeHtml(i18n('This preset contains content prompts (character / persona / WI / chat) which director already provides. Consider a pure-instruction preset to avoid duplication.'))}</div>
            </label>
            <label>
                <span data-i18n="Main system prompt">${escapeHtml(i18n('Main system prompt'))}</span>
                <textarea class="text_pole textarea_compact" rows="6" data-orch-director-field="mainAgent.systemPrompt" data-scope="${safeScope}">${escapeHtml(String(mainAgent.systemPrompt || ''))}</textarea>
            </label>
            <div class="flex-container">
                <div class="menu_button menu_button_small" data-luker-action="director-reset-main-prompt" data-scope="${safeScope}" data-i18n="Reset to default">${escapeHtml(i18n('Reset to default'))}</div>
            </div>

            <h4 data-i18n="Limits">${escapeHtml(i18n('Limits'))}</h4>
            <label>
                <span data-i18n="Maximum tool-calling rounds">${escapeHtml(i18n('Maximum tool-calling rounds'))}</span>
                <input class="text_pole" type="number" min="1" max="50" step="1" data-orch-director-field="maxRounds" data-scope="${safeScope}" value="${escapeHtml(String(maxRounds))}" />
            </label>
            <label>
                <span data-i18n="Maximum concurrent sub-agents">${escapeHtml(i18n('Maximum concurrent sub-agents'))}</span>
                <input class="text_pole" type="number" min="1" max="16" step="1" data-orch-director-field="maxConcurrentSubagents" data-scope="${safeScope}" value="${escapeHtml(String(maxConcurrentSubagents))}" />
            </label>
            <label>
                <span data-i18n="Maximum total sub-agent runs per turn">${escapeHtml(i18n('Maximum total sub-agent runs per turn'))}</span>
                <input class="text_pole" type="number" min="1" max="100" step="1" data-orch-director-field="maxTotalSubagentRuns" data-scope="${safeScope}" value="${escapeHtml(String(maxTotalSubagentRuns))}" />
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
    </div>
</div>`;
}

export function buildOrchestrationEditorPopupPanelHtml(deps, context, settings) {
    const {
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_DIRECTOR,
        ORCH_EXECUTION_MODE_LOOP,
        createDefaultDirectorProfile,
        escapeHtml,
        getAgendaEditorByScope,
        getCharacterAgendaOverrideByAvatar,
        getCharacterDirectorOverrideByAvatar,
        getCharacterDisplayNameByAvatar,
        getCharacterLoopOverrideByAvatar,
        getCharacterOverrideByAvatar,
        getCurrentAvatar,
        getDisplayedScope,
        getDirectorEditorByScope,
        getDirectorProfileFromSettings,
        getEditorByScope,
        getLoopEditorByScope,
        getPopupEditingLabel,
        getProfileTitleForScope,
        hasCharacterAgendaOverride,
        hasCharacterDirectorOverride,
        hasCharacterLoopOverride,
        hasCharacterSpecOverride,
        i18n,
        syncCharacterEditorWithActiveAvatar,
        uiState,
    } = deps;

    if (settings && deps.getExecutionMode && deps.getExecutionMode(settings) === ORCH_EXECUTION_MODE_DIRECTOR) {
        // Director popup mirrors loop / agenda's scope plumbing: edits go
        // to uiState.{global,character}DirectorEditor (working state),
        // Save To Global / Save To Character Override commits.
        syncCharacterEditorWithActiveAvatar(context);
        const activeAvatar = String(getCurrentAvatar(context) || '').trim();
        const hasActiveCharacter = Boolean(activeAvatar);
        const scope = deps.getDisplayedScope(context, settings);
        const editor = deps.getDirectorEditorByScope(scope);
        const directorOverride = activeAvatar && deps.getCharacterDirectorOverrideByAvatar
            ? deps.getCharacterDirectorOverrideByAvatar(context, activeAvatar)
            : null;
        const isCharacterScope = scope === 'character';
        const hasDirectorCharacterOverride = activeAvatar && deps.hasCharacterDirectorOverride
            ? deps.hasCharacterDirectorOverride(context, activeAvatar)
            : false;
        const editingLabel = getPopupEditingLabel(isCharacterScope, hasDirectorCharacterOverride, Boolean(directorOverride?.enabled));
        const profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasDirectorCharacterOverride);
        return `
<div class="luker-studio luker_orch_editor_popup">
    <div class="luker-studio-editor-topbar">
        <div class="luker-studio-editor-topbar-left">
            <div class="luker-studio-editor-topbar-title">${escapeHtml(i18n('Orchestration Editor'))}</div>
            <div class="luker-studio-editor-topbar-meta">
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Current card:'))} <b>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Editing:'))} <b>${escapeHtml(editingLabel)}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Execution mode'))} <b>${escapeHtml(i18n('Director (multi-agent)'))}</b></span>
            </div>
        </div>
        <div class="luker-studio-editor-topbar-right">
            <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
        </div>
    </div>
    <div class="luker-studio-actions-bar">
        <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
        <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
        <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
        <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
        <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
        ${hasActiveCharacter ? `<div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>` : ''}
        ${hasActiveCharacter && isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
        <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
        <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
    </div>
    ${renderDirectorWorkspace(deps, scope, editor, profileTitle)}
</div>`;
    }

    if (settings && deps.getExecutionMode && deps.getExecutionMode(settings) === ORCH_EXECUTION_MODE_LOOP) {
        syncCharacterEditorWithActiveAvatar(context);
        const activeAvatar = String(getCurrentAvatar(context) || '').trim();
        const hasActiveCharacter = Boolean(activeAvatar);
        const scope = getDisplayedScope(context, settings);
        const editor = getLoopEditorByScope(scope);
        const loopOverride = activeAvatar ? getCharacterLoopOverrideByAvatar(context, activeAvatar) : null;
        const isCharacterScope = scope === 'character';
        const hasLoopCharacterOverride = hasCharacterLoopOverride(context, activeAvatar);
        const editingLabel = getPopupEditingLabel(isCharacterScope, hasLoopCharacterOverride, Boolean(loopOverride?.enabled));
        const profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasLoopCharacterOverride);
        return `
<div class="luker-studio luker_orch_editor_popup">
    <div class="luker-studio-editor-topbar">
        <div class="luker-studio-editor-topbar-left">
            <div class="luker-studio-editor-topbar-title">${escapeHtml(i18n('Orchestration Editor'))}</div>
            <div class="luker-studio-editor-topbar-meta">
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Current card:'))} <b>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Editing:'))} <b>${escapeHtml(editingLabel)}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Execution mode'))} <b>${escapeHtml(i18n('Loop (single-agent loop)'))}</b></span>
            </div>
        </div>
        <div class="luker-studio-editor-topbar-right">
            <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
        </div>
    </div>
    <div class="luker-studio-actions-bar">
        <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
        <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
        <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
        <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
        <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
        ${hasActiveCharacter ? `<div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>` : ''}
        ${hasActiveCharacter && isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
        <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
        <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
    </div>
    ${renderLoopWorkspace(deps, scope, editor, profileTitle)}
</div>`;
    }

    if (settings && deps.getExecutionMode && deps.getExecutionMode(settings) === ORCH_EXECUTION_MODE_AGENDA) {
        syncCharacterEditorWithActiveAvatar(context);
        const activeAvatar = String(getCurrentAvatar(context) || '').trim();
        const hasActiveCharacter = Boolean(activeAvatar);
        const scope = getDisplayedScope(context, settings);
        const editor = getAgendaEditorByScope(scope);
        const agendaOverride = activeAvatar ? getCharacterAgendaOverrideByAvatar(context, activeAvatar) : null;
        const isCharacterScope = scope === 'character';
        const hasAgendaCharacterOverride = hasCharacterAgendaOverride(context, activeAvatar);
        const editingLabel = getPopupEditingLabel(isCharacterScope, hasAgendaCharacterOverride, Boolean(agendaOverride?.enabled));
        const profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasAgendaCharacterOverride);
        return `
<div class="luker-studio luker_orch_editor_popup">
    <div class="luker-studio-editor-topbar">
        <div class="luker-studio-editor-topbar-left">
            <div class="luker-studio-editor-topbar-title">${escapeHtml(i18n('Orchestration Editor'))}</div>
            <div class="luker-studio-editor-topbar-meta">
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Current card:'))} <b>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Editing:'))} <b>${escapeHtml(editingLabel)}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Execution mode'))} <b>${escapeHtml(i18n('Agenda planner'))}</b></span>
            </div>
        </div>
        <div class="luker-studio-editor-topbar-right">
            <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
        </div>
    </div>
    <div class="luker-studio-actions-bar">
        <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
        <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
        <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
        <div class="menu_button" data-luker-action="agenda-copy-from-spec" data-scope="${scope}">${escapeHtml(i18n('Copy Spec Agents To Agenda'))}</div>
        <div class="menu_button" data-luker-action="spec-copy-from-agenda" data-scope="${scope}">${escapeHtml(i18n('Copy Agenda Agents To Spec'))}</div>
        <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
        <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
        ${hasActiveCharacter ? `<div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>` : ''}
        ${hasActiveCharacter && isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
        <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
        <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
    </div>
    ${renderAgendaWorkspace(deps, scope, editor, profileTitle)}
</div>`;
    }

    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const hasActiveCharacter = Boolean(activeAvatar);
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const isCharacterScope = scope === 'character';
    const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
    const hasSpecCharacterOverride = hasCharacterSpecOverride(context, activeAvatar);
    const profileTitle = getProfileTitleForScope(context, activeAvatar, isCharacterScope, hasSpecCharacterOverride);
    return `
<div class="luker-studio luker_orch_editor_popup">
    <div class="luker-studio-editor-topbar">
        <div class="luker-studio-editor-topbar-left">
            <div class="luker-studio-editor-topbar-title">${escapeHtml(i18n('Orchestration Editor'))}</div>
            <div class="luker-studio-editor-topbar-meta">
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Current card:'))} <b>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</b></span>
                <span class="luker-studio-editor-chip">${escapeHtml(i18n('Editing:'))} <b>${escapeHtml(getPopupEditingLabel(isCharacterScope, hasSpecCharacterOverride, Boolean(override?.enabled)))}</b></span>
            </div>
        </div>
        <div class="luker-studio-editor-topbar-right">
            <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
        </div>
    </div>
    <div class="luker-studio-actions-bar">
        <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
        <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
        <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
        <div class="menu_button" data-luker-action="agenda-copy-from-spec" data-scope="${scope}">${escapeHtml(i18n('Copy Spec Agents To Agenda'))}</div>
        <div class="menu_button" data-luker-action="spec-copy-from-agenda" data-scope="${scope}">${escapeHtml(i18n('Copy Agenda Agents To Spec'))}</div>
        <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
        <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
        ${hasActiveCharacter ? `<div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>` : ''}
        ${hasActiveCharacter && isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
    </div>
    <div id="luker_orch_effective_visual">${renderEditorWorkspace(deps, scope, editor, profileTitle)}</div>
</div>`;
}

export function buildOrchestratorSettingsHtml(deps) {
    const {
        escapeHtml,
        extension_prompt_roles,
        i18n,
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_DIRECTOR,
        ORCH_EXECUTION_MODE_LOOP,
        ORCH_EXECUTION_MODE_SINGLE,
        ORCH_EXECUTION_MODE_SPEC,
        UI_BLOCK_ID,
        world_info_position,
    } = deps;
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
            <div id="luker_orch_single_agent_fields">
                <label for="luker_orch_single_agent_system_prompt">${escapeHtml(i18n('Single-agent system prompt'))}</label>
                <textarea id="luker_orch_single_agent_system_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                <label for="luker_orch_single_agent_user_prompt">${escapeHtml(i18n('Single-agent user prompt template'))}</label>
                <textarea id="luker_orch_single_agent_user_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            </div>
            <label for="luker_orch_llm_api_preset">${escapeHtml(i18n('LLM node API preset (Connection profile)'))}</label>
            <select id="luker_orch_llm_api_preset" class="text_pole"></select>
            <label for="luker_orch_llm_preset">${escapeHtml(i18n('LLM node preset (params + prompt)'))}</label>
            <select id="luker_orch_llm_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_api_preset">${escapeHtml(i18n('AI build API preset (Connection profile)'))}</label>
            <select id="luker_orch_ai_suggest_api_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_preset">${escapeHtml(i18n('AI build preset (params + prompt)'))}</label>
            <select id="luker_orch_ai_suggest_preset" class="text_pole"></select>
            <label class="checkbox_label">
                <input id="luker_orch_include_world_info" type="checkbox" />
                ${escapeHtml(i18n('Include world info'))}
            </label>
            <label class="checkbox_label">
                <input id="luker_orch_use_streaming_transport" type="checkbox" />
                ${escapeHtml(i18n('Use streaming transport (avoid timeout on slow APIs)'))}
            </label>
            <label for="luker_orch_ai_suggest_system_prompt">${escapeHtml(i18n('AI build system prompt'))}</label>
            <textarea id="luker_orch_ai_suggest_system_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            <div class="flex-container">
                <div id="luker_orch_reset_ai_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset AI build prompt'))}</div>
            </div>
            <label for="luker_orch_max_recent_messages">${escapeHtml(i18n('Recent assistant turns for orchestration (N)'))}</label>
            <input id="luker_orch_max_recent_messages" class="text_pole" type="number" min="1" max="80" step="1" />
            <label for="luker_orch_node_iterations">${escapeHtml(i18n('Node tool iteration max rounds (N)'))}</label>
            <input id="luker_orch_node_iterations" class="text_pole" type="number" min="1" max="20" step="1" />
            <label for="luker_orch_review_reruns">${escapeHtml(i18n('Review rerun max rounds (N)'))}</label>
            <input id="luker_orch_review_reruns" class="text_pole" type="number" min="0" max="20" step="1" />
            <label for="luker_orch_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="luker_orch_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" />
            <label for="luker_orch_rpm_limit">${escapeHtml(i18n('RPM limit (0 = unlimited)'))}</label>
            <input id="luker_orch_rpm_limit" class="text_pole" type="number" min="0" max="600" step="1" />
            <div id="luker_orch_capsule_settings">
                <label for="luker_orch_capsule_position">${escapeHtml(i18n('Injection position'))}</label>
                <select id="luker_orch_capsule_position" class="text_pole">
                    <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
                    <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
                    <option value="${world_info_position.ANTop}">${escapeHtml(i18n('Before Author\'s Note'))}</option>
                    <option value="${world_info_position.ANBottom}">${escapeHtml(i18n('After Author\'s Note'))}</option>
                    <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
                    <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
                    <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
                </select>
                <label for="luker_orch_capsule_depth">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
                <input id="luker_orch_capsule_depth" class="text_pole" type="number" min="0" max="10000" step="1" />
                <label for="luker_orch_capsule_role">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
                <select id="luker_orch_capsule_role" class="text_pole">
                    <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                    <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                    <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
                </select>
                <label for="luker_orch_capsule_custom_instruction">${escapeHtml(i18n('Custom orchestration result instruction (prepended before analysis)'))}</label>
                <textarea id="luker_orch_capsule_custom_instruction" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('e.g. Follow this guidance first, then write final reply in-character.'))}"></textarea>
            </div>
            <small id="luker_orch_single_mode_hint" style="opacity:0.8">${escapeHtml(i18n('Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.'))}</small>
            <div id="luker_orch_single_mode_runtime_tools" class="luker_orch_board luker_orch_single_mode_tools">
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                    <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
                </div>
            </div>

            <hr>
            <div id="luker_orch_spec_board" class="luker_orch_board">
                <div>
                    <small>${escapeHtml(i18n('Current card:'))} <span id="luker_orch_profile_target">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                    <small>${escapeHtml(i18n('Editing:'))} <span id="luker_orch_profile_mode">${escapeHtml(i18n('Global profile'))}</span></small>
                </div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="open-orch-editor">${escapeHtml(i18n('Open Orchestration Editor'))}</div>
                    <div class="menu_button" data-luker-action="agenda-copy-from-spec">${escapeHtml(i18n('Copy Spec Agents To Agenda'))}</div>
                    <div class="menu_button" data-luker-action="spec-copy-from-agenda">${escapeHtml(i18n('Copy Agenda Agents To Spec'))}</div>
                    <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                    <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
                    <div class="menu_button" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                </div>
            </div>

            <div id="luker_orch_agenda_board" class="luker_orch_board" style="display:none">
                <div>
                    <small>${escapeHtml(i18n('Current card:'))} <span id="luker_orch_agenda_profile_target">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                    <small>${escapeHtml(i18n('Editing:'))} <span id="luker_orch_agenda_profile_mode">${escapeHtml(i18n('Global profile'))}</span></small>
                </div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="open-orch-editor">${escapeHtml(i18n('Open Orchestration Editor'))}</div>
                    <div class="menu_button" data-luker-action="agenda-copy-from-spec">${escapeHtml(i18n('Copy Spec Agents To Agenda'))}</div>
                    <div class="menu_button" data-luker-action="spec-copy-from-agenda">${escapeHtml(i18n('Copy Agenda Agents To Spec'))}</div>
                    <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                    <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
                    <div class="menu_button" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                </div>
            </div>

            <div id="luker_orch_loop_board" class="luker_orch_board" style="display:none">
                <div>
                    <small>${escapeHtml(i18n('Current card:'))} <span id="luker_orch_loop_profile_target">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                    <small>${escapeHtml(i18n('Editing:'))} <span id="luker_orch_loop_profile_mode">${escapeHtml(i18n('Global profile'))}</span></small>
                </div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="open-orch-editor">${escapeHtml(i18n('Open Orchestration Editor'))}</div>
                    <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                    <div class="menu_button" data-luker-action="view-runtime-trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
                    <div class="menu_button" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                </div>
                <small class="luker_orch_loop_board_hint">${escapeHtml(i18n('Loop mode runs a single agent that calls tools in a loop and finalizes when ready.'))}</small>
            </div>

            <div id="luker_orch_director_board" class="luker_orch_board" style="display:none">
                <div>
                    <small><span data-i18n="Current card:">${escapeHtml(i18n('Current card:'))}</span> <span id="luker_orch_director_profile_target" data-i18n="(No character card)">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                    <small><span data-i18n="Editing:">${escapeHtml(i18n('Editing:'))}</span> <span id="luker_orch_director_profile_mode" data-i18n="Global profile">${escapeHtml(i18n('Global profile'))}</span></small>
                </div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="open-orch-editor" data-i18n="Open Orchestration Editor">${escapeHtml(i18n('Open Orchestration Editor'))}</div>
                    <div class="menu_button" data-luker-action="view-runtime-trace" data-i18n="View Runtime Trace">${escapeHtml(i18n('View Runtime Trace'))}</div>
                    <div class="menu_button" data-luker-action="ai-iterate-open" data-i18n="Open AI Iteration Studio">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                </div>
                <small class="luker_orch_director_board_hint" data-i18n="Director mode produces the assistant message directly via a main agent that may dispatch sub-agents.">${escapeHtml(i18n('Director mode produces the assistant message directly via a main agent that may dispatch sub-agents.'))}</small>
            </div>

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
