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
        ${renderOpenAIPresetOptions(context, preset?.promptPresetName)}
    </select>
    <label>${escapeHtml(i18n('System Prompt'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-agenda-agent-field="systemPrompt" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>${escapeHtml(i18n('User Prompt Template'))}</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-agenda-agent-field="userPromptTemplate" data-scope="${safeScope}" data-agent-id="${escapeHtml(agentId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
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
            <select id="luker_orch_agenda_planner_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, planner?.promptPresetName)}</select>
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
    return `
<div class="luker-studio-workspace" data-luker-scope-root="${scope}">
    <div class="luker-studio-workspace-title">${escapeHtml(title)}</div>
    <div class="luker-studio-workspace-grid">
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
            <select id="luker_orch_loop_prompt_preset" data-scope="${safeScope}" class="text_pole">${renderOpenAIPresetOptions(context, editor?.promptPresetName)}</select>
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
                ${checkbox('note.add', note.add, 'note.add')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('chat (in-chat history)'))}</legend>
                ${checkbox('chat.read_range', chat.read_range, 'chat.read_range')}
                ${checkbox('chat.search', chat.search, 'chat.search')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('lorebook (world info)'))}</legend>
                ${checkbox('lorebook.search', lorebook.search, 'lorebook.search')}
                ${checkbox('lorebook.get', lorebook.get, 'lorebook.get')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('memory (memory-graph)'))}</legend>
                ${checkbox('memory.search', memory.search, 'memory.search')}
                ${checkbox('memory.list_recent', memory.list_recent, 'memory.list_recent')}
                ${checkbox('memory.get', memory.get, 'memory.get')}
            </fieldset>
            <fieldset class="luker_orch_loop_tools_group">
                <legend>${escapeHtml(i18n('terminator'))}</legend>
                ${checkbox('finalize', true, `finalize  ${i18n('(forced on)')}`, true, true)}
            </fieldset>
        </div>
    </div>
</div>`;
}

export function buildOrchestrationEditorPopupPanelHtml(deps, context, settings) {
    const {
        ORCH_EXECUTION_MODE_AGENDA,
        ORCH_EXECUTION_MODE_LOOP,
        escapeHtml,
        getAgendaEditorByScope,
        getCharacterAgendaOverrideByAvatar,
        getCharacterDisplayNameByAvatar,
        getCharacterLoopOverrideByAvatar,
        getCharacterOverrideByAvatar,
        getCurrentAvatar,
        getDisplayedScope,
        getEditorByScope,
        getLoopEditorByScope,
        getPopupEditingLabel,
        getProfileTitleForScope,
        hasCharacterAgendaOverride,
        hasCharacterLoopOverride,
        hasCharacterSpecOverride,
        i18n,
        syncCharacterEditorWithActiveAvatar,
        uiState,
    } = deps;

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
            <textarea class="text_pole textarea_compact" rows="1" data-luker-ai-goal-input placeholder="${escapeHtml(i18n('AI build goal (optional)'))}">${escapeHtml(String(uiState.aiGoal || ''))}</textarea>
            <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
        </div>
    </div>
    <div class="luker-studio-actions-bar">
        <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
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
            <textarea class="text_pole textarea_compact" rows="1" data-luker-ai-goal-input placeholder="${escapeHtml(i18n('AI build goal (optional)'))}">${escapeHtml(String(uiState.aiGoal || ''))}</textarea>
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
            <textarea class="text_pole textarea_compact" rows="1" data-luker-ai-goal-input placeholder="${escapeHtml(i18n('AI build goal (optional)'))}">${escapeHtml(String(uiState.aiGoal || ''))}</textarea>
            <div class="menu_button menu_button_small" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Quick Build'))}</div>
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

export function buildAiIterationPopupHtml(deps, popupId, session, { allowCharacterApply = false, enableSessionHistory = false } = {}) {
    const { escapeHtml, i18n, i18nFormat } = deps;
    return `
<div id="${popupId}" class="luker-studio luker_orch_iter_popup">
    <div class="luker-studio-header">
        <div class="luker-studio-title">${escapeHtml(i18n('AI Iteration Studio'))}</div>
        <div id="${popupId}_sub" class="luker-studio-subtitle">${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</div>
    </div>
    <div id="${popupId}_status" class="luker-studio-status"></div>
    <div class="luker-studio-columns">
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Conversation'))}</div>
            <div id="${popupId}_conversation" class="luker-studio-chat"></div>
            <div id="${popupId}_pending"></div>
            <div class="luker-studio-composer">
                <textarea id="${popupId}_input" class="text_pole textarea_compact" rows="4" placeholder="${escapeHtml(i18n('Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...'))}"></textarea>
                <div class="luker-studio-composer-buttons">
                    <div id="${popupId}_send" class="menu_button">${escapeHtml(i18n('Send to AI'))}</div>
                    <div id="${popupId}_stop" class="menu_button">${escapeHtml(i18n('Stop'))}</div>
                    <div id="${popupId}_clear" class="menu_button">${escapeHtml(i18n('Clear Session'))}</div>
                </div>
            </div>
        </div>
        <div class="luker-studio-panel">
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Working profile'))}</div>
            <div id="${popupId}_profile" class="luker_orch_iter_profile"></div>
            <div class="luker-studio-composer-buttons">
                <div id="${popupId}_apply_global" class="menu_button">${escapeHtml(i18n('Apply to Global'))}</div>
                ${allowCharacterApply ? `<div id="${popupId}_apply_character" class="menu_button">${escapeHtml(i18n('Apply to Character'))}</div>` : ''}
            </div>
            ${enableSessionHistory ? `
            <div class="luker-studio-panel-title">${escapeHtml(i18n('Session history'))}</div>
            <div id="${popupId}_history" class="luker-studio-history-list"></div>
            <div class="luker-studio-composer-buttons">
                <div id="${popupId}_new_session" class="menu_button">${escapeHtml(i18n('New session'))}</div>
            </div>` : ''}
        </div>
    </div>
</div>`;
}

export function buildOrchestratorSettingsHtml(deps) {
    const {
        escapeHtml,
        extension_prompt_roles,
        i18n,
        ORCH_EXECUTION_MODE_AGENDA,
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
            </select>
            <div id="luker_orch_single_agent_fields">
                <label for="luker_orch_single_agent_system_prompt">${escapeHtml(i18n('Single-agent system prompt'))}</label>
                <textarea id="luker_orch_single_agent_system_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                <label for="luker_orch_single_agent_user_prompt">${escapeHtml(i18n('Single-agent user prompt template'))}</label>
                <textarea id="luker_orch_single_agent_user_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            </div>
            <label for="luker_orch_llm_api_preset">${escapeHtml(i18n('LLM node API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_orch_llm_api_preset" class="text_pole"></select>
            <label for="luker_orch_llm_preset">${escapeHtml(i18n('LLM node preset (params + prompt, empty = current)'))}</label>
            <select id="luker_orch_llm_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_api_preset">${escapeHtml(i18n('AI build API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_orch_ai_suggest_api_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_preset">${escapeHtml(i18n('AI build preset (params + prompt, empty = current)'))}</label>
            <select id="luker_orch_ai_suggest_preset" class="text_pole"></select>
            <label class="checkbox_label">
                <input id="luker_orch_include_world_info" type="checkbox" />
                ${escapeHtml(i18n('Include world info'))}
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
            <label for="luker_orch_agent_timeout">${escapeHtml(i18n('Per-agent timeout seconds (0 = disabled)'))}</label>
            <input id="luker_orch_agent_timeout" class="text_pole" type="number" min="0" max="3600" step="1" />
            <label for="luker_orch_rpm_limit">${escapeHtml(i18n('RPM limit (0 = unlimited)'))}</label>
            <input id="luker_orch_rpm_limit" class="text_pole" type="number" min="0" max="600" step="1" />
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
                    <div class="menu_button" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Quick Build'))}</div>
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
                </div>
                <small class="luker_orch_loop_board_hint">${escapeHtml(i18n('Loop mode runs a single agent that calls tools in a loop and finalizes when ready.'))}</small>
            </div>

            <small id="luker_orch_last_run_state" class="luker_orch_state_summary"></small>
            <small id="luker_orch_status" style="opacity:0.8"></small>
        </div>
    </div>
</div>`;
}
