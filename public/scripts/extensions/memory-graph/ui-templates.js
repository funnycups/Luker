export function buildSchemaEditorPopupHtml(deps, popupId, scopeInfo) {
    const {
        escapeHtml,
        i18n,
        i18nFormat,
        normalizeNodeTypeSchema,
        renderNodeTypeSchemaCard,
    } = deps;
    const normalized = normalizeNodeTypeSchema(scopeInfo?.schema);
    const cardsHtml = normalized.map((spec, index) => renderNodeTypeSchemaCard(spec, index)).join('');
    const scopeText = scopeInfo?.hasOverride
        ? i18nFormat('Schema scope: character override (${0})', scopeInfo.characterName || scopeInfo.avatar || i18n('(unset)'))
        : i18n('Schema scope: global');
    return `
<div id="${popupId}" class="luker-rpg-schema-popup">
    <div class="luker-schema-topbar">
        <div>
            <div class="luker-schema-topbar-title">${escapeHtml(i18n('Memory Node Schema Editor'))}</div>
            <div class="luker-schema-topbar-note">${escapeHtml(i18n('Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.'))}</div>
        </div>
        <div class="luker-schema-chip-row">
            <span class="luker-schema-chip hier">${escapeHtml(i18n('Hierarchical Compression'))}</span>
            <span class="luker-schema-chip latest">${escapeHtml(i18n('Latest-only Merge'))}</span>
            <span class="luker-schema-chip inject">${escapeHtml(i18n('Always Inject'))}</span>
        </div>
    </div>
    <div class="luker-schema-editor-list">${cardsHtml}</div>
    <div class="luker-schema-footer">
        <div class="luker-schema-footer-meta">
            <div class="luker-schema-footer-note">${escapeHtml(i18nFormat('Current type count: ${0}', normalized.length))}</div>
            <div id="${popupId}_schema_scope" class="luker-schema-footer-note">${escapeHtml(scopeText)}</div>
        </div>
        <div class="luker-schema-footer-actions">
            <div class="menu_button luker-schema-editor-add">${escapeHtml(i18n('Add Type'))}</div>
            <div class="menu_button luker-schema-editor-reset">${escapeHtml(i18n('Reset to Default Schema'))}</div>
            <div id="${popupId}_schema_export" class="menu_button">${escapeHtml(i18n('Export Schema'))}</div>
            <div id="${popupId}_schema_import" class="menu_button">${escapeHtml(i18n('Import Schema'))}</div>
            <div id="${popupId}_schema_save_global" class="menu_button">${escapeHtml(i18n('Save Schema to Global'))}</div>
            <div id="${popupId}_schema_save_character" class="menu_button">${escapeHtml(i18n('Save Schema to Character'))}</div>
            <div id="${popupId}_schema_clear_character_override" class="menu_button">${escapeHtml(i18n('Clear Character Schema Override'))}</div>
        </div>
    </div>
</div>`;
}

export function buildAdvancedSettingsPopupHtml(deps, popupId, scopeInfo) {
    const {
        DEFAULT_EXTRACT_SYSTEM_PROMPT,
        DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
        DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
        DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT,
        defaultSettings,
        escapeHtml,
        i18n,
        i18nFormat,
        normalizeExtractExcludeRecentTurns,
    } = deps;
    const settings = scopeInfo?.settings || defaultSettings;
    const extractPrompt = String(settings.extractSystemPrompt || defaultSettings.extractSystemPrompt || '');
    const routePrompt = String(settings.recallRouteSystemPrompt || defaultSettings.recallRouteSystemPrompt || '');
    const finalizePrompt = String(settings.recallFinalizeSystemPrompt || defaultSettings.recallFinalizeSystemPrompt || '');
    const schemaIterPrompt = String(settings.schemaIterSystemPrompt || defaultSettings.schemaIterSystemPrompt || '');
    const scopeText = scopeInfo?.hasOverride
        ? i18nFormat('Advanced scope: character override (${0})', scopeInfo.characterName || scopeInfo.avatar || i18n('(unset)'))
        : i18n('Advanced scope: global');
    return `
<div id="${popupId}" class="luker-rpg-memory-advanced-popup">
    <h3 class="margin0">${escapeHtml(i18n('Advanced Settings'))}</h3>
    <label>${escapeHtml(i18n('Exclude latest N assistant turns from memory injection'))}
        <input id="${popupId}_recent_raw_turns" class="text_pole" type="number" min="0" step="1" value="${Number(settings.recentRawTurns ?? defaultSettings.recentRawTurns)}" />
    </label>
    <label>${escapeHtml(i18n('Main-context injection window (assistant turns; 0 = no limit)'))}
        <input id="${popupId}_main_injection_window" class="text_pole" type="number" min="0" step="1" value="${Number(settings.mainInjectionAssistantTurnsWindow ?? defaultSettings.mainInjectionAssistantTurnsWindow)}" />
    </label>
    <small style="opacity:0.8">${escapeHtml(i18n('0 = inject all always-on nodes (current behavior). N > 0 = drop always-on nodes older than N assistant turns from the main context; recall candidates and recall-selected nodes are unaffected.'))}</small>
    <label>${escapeHtml(i18n('Recall max iterations'))}
        <input id="${popupId}_recall_iterations" class="text_pole" type="number" min="2" max="6" step="1" value="${Number(settings.recallMaxIterations || defaultSettings.recallMaxIterations)}" />
    </label>
    <label>${escapeHtml(i18n('Tool-call retries'))}
        <input id="${popupId}_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" value="${Math.max(0, Math.min(10, Number(settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax)))}" />
    </label>
    <label>${escapeHtml(i18n('RPM limit (0 = unlimited)'))}
        <input id="${popupId}_rpm_limit" class="text_pole" type="number" min="0" max="600" step="1" value="${Math.max(0, Number(settings.rpmLimit ?? defaultSettings.rpmLimit))}" />
    </label>
    <label>${escapeHtml(i18n('Extract context assistant turns'))}
        <input id="${popupId}_extract_context_turns" class="text_pole" type="number" min="1" max="32" step="1" value="${Math.max(1, Math.min(32, Number(settings.extractContextTurns || defaultSettings.extractContextTurns)))}" />
    </label>
    <label>${escapeHtml(i18n('Exclude latest N assistant turns from graph extraction'))}
        <input id="${popupId}_extract_exclude_recent_turns" class="text_pole" type="number" min="0" step="1" value="${normalizeExtractExcludeRecentTurns(settings.extractExcludeRecentTurns ?? defaultSettings.extractExcludeRecentTurns)}" />
    </label>
    <label>${escapeHtml(i18n('Recall query recent assistant turns'))}
        <input id="${popupId}_recall_query_messages" class="text_pole" type="number" min="1" max="64" step="1" value="${Math.max(1, Math.min(64, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages)))}" />
    </label>
    <label>${escapeHtml(i18n('Visible recent message layers for generation (0 = disabled)'))}
        <input id="${popupId}_llm_visible_recent_messages" class="text_pole" type="number" min="0" max="200" step="1" value="${Math.max(0, Math.min(200, Number(settings.llmVisibleRecentMessages ?? defaultSettings.llmVisibleRecentMessages)))}" />
    </label>
    <label>${escapeHtml(i18n('Extract batch assistant turns'))}
        <input id="${popupId}_extract_batch_turns" class="text_pole" type="number" min="1" step="1" value="${Math.max(1, Number(settings.extractBatchTurns || defaultSettings.extractBatchTurns))}" />
    </label>
    <div id="${popupId}_diffusion_settings" style="border-top:1px solid var(--SmartThemeBorderColor,#555);margin-top:8px;padding-top:8px">
        <b>${escapeHtml(i18n('Graph Diffusion Parameters'))}</b>
        <label>${escapeHtml(i18n('Diffusion steps'))}
            <input id="${popupId}_diffusion_steps" class="text_pole" type="number" min="1" max="5" step="1" value="${Number(settings.diffusionSteps || defaultSettings.diffusionSteps || 2)}" />
        </label>
        <label>${escapeHtml(i18n('Diffusion decay factor'))}
            <input id="${popupId}_diffusion_decay" class="text_pole" type="number" min="0.1" max="1.0" step="0.05" value="${Number(settings.diffusionDecay || defaultSettings.diffusionDecay || 0.6)}" />
        </label>
        <label>${escapeHtml(i18n('Diffusion Top-K (per step)'))}
            <input id="${popupId}_diffusion_topk" class="text_pole" type="number" min="10" max="500" step="10" value="${Number(settings.diffusionTopK || defaultSettings.diffusionTopK || 100)}" />
        </label>
        <label>${escapeHtml(i18n('PPR teleport alpha (0 = disabled)'))}
            <input id="${popupId}_diffusion_teleport" class="text_pole" type="number" min="0" max="0.5" step="0.05" value="${Number(settings.diffusionTeleportAlpha || defaultSettings.diffusionTeleportAlpha || 0)}" />
        </label>
    </div>
    <label>${escapeHtml(i18n('Extract Table Fill Prompt'))}
        <textarea id="${popupId}_extract_system_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(extractPrompt || DEFAULT_EXTRACT_SYSTEM_PROMPT)}</textarea>
    </label>
    <label>${escapeHtml(i18n('Recall Stage 1 Prompt (Route/Drill)'))}
        <textarea id="${popupId}_recall_route_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(routePrompt || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT)}</textarea>
    </label>
    <label>${escapeHtml(i18n('Recall Stage 2 Prompt (Finalize)'))}
        <textarea id="${popupId}_recall_finalize_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(finalizePrompt || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT)}</textarea>
    </label>
    <label>${escapeHtml(i18n('Schema Iteration Prompt (schema-editor AI)'))}
        <textarea id="${popupId}_schema_iter_system_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(schemaIterPrompt || DEFAULT_SCHEMA_ITER_SYSTEM_PROMPT)}</textarea>
    </label>
    <div class="luker-rpg-memory-advanced-footer">
        <div class="luker-rpg-memory-advanced-footer-meta">
            <div id="${popupId}_advanced_scope" class="luker-rpg-memory-advanced-footer-note">${escapeHtml(scopeText)}</div>
        </div>
        <div class="luker-rpg-memory-advanced-actions">
            <div id="${popupId}_reset_advanced" class="menu_button">${escapeHtml(i18n('Reset Advanced Settings'))}</div>
            <div id="${popupId}_advanced_save_global" class="menu_button">${escapeHtml(i18n('Save Advanced to Global'))}</div>
            <div id="${popupId}_advanced_save_character" class="menu_button">${escapeHtml(i18n('Save Advanced to Character'))}</div>
            <div id="${popupId}_advanced_clear_character_override" class="menu_button">${escapeHtml(i18n('Clear Character Advanced Override'))}</div>
        </div>
    </div>
</div>`;
}

export function buildManualCompressionPopupHtml(deps, popupId, settings, compressibleTypes) {
    const { escapeHtml, i18n } = deps;
    const excludeRecentDefault = Math.max(0, Number(settings.recentRawTurns || 0));
    const maxRoundsDefault = 3;
    const typeRows = compressibleTypes.map(item => `
        <label class="checkbox_label">
            <input type="checkbox" data-field="type" value="${escapeHtml(item.id)}" checked />
            ${escapeHtml(`${item.label} (${item.id}, ${item.mode})`)}
        </label>
    `).join('');
    return `
<div id="${popupId}" class="luker-rpg-memory-advanced-popup">
    <h3 class="margin0">${escapeHtml(i18n('Manual Compression'))}</h3>
    <label>${escapeHtml(i18n('Compression scope'))}
        <select id="${popupId}_scope" class="text_pole">
            <option value="all">${escapeHtml(i18n('All nodes'))}</option>
            <option value="older" selected>${escapeHtml(i18n('Older nodes only (exclude recent N assistant turns)'))}</option>
        </select>
    </label>
    <label id="${popupId}_exclude_recent_label">${escapeHtml(i18n('Exclude recent assistant turns'))}
        <input id="${popupId}_exclude_recent" class="text_pole" type="number" min="0" step="1" value="${excludeRecentDefault}" />
    </label>
    <label>${escapeHtml(i18n('Compression mode'))}
        <select id="${popupId}_mode" class="text_pole">
            <option value="schema" selected>${escapeHtml(i18n('Use schema thresholds'))}</option>
            <option value="force">${escapeHtml(i18n('Force compress (ignore threshold)'))}</option>
            <option value="flat">${escapeHtml(i18n('Force compress across depths (ignore hierarchy)'))}</option>
        </select>
    </label>
    <label>${escapeHtml(i18n('Max rounds per type'))}
        <input id="${popupId}_max_rounds" class="text_pole" type="number" min="1" step="1" value="${maxRoundsDefault}" />
    </label>
    <label>${escapeHtml(i18n('Types to compress'))}</label>
    <div id="${popupId}_types" style="max-height: 200px; overflow: auto; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 8px;">
        ${typeRows}
    </div>
</div>`;
}

export function buildMemoryGraphSettingsHtml(deps) {
    const {
        escapeHtml,
        extension_prompt_roles,
        i18n,
        UI_BLOCK_ID,
        world_info_position,
    } = deps;
    return `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Memory'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="luker_rpg_memory_enabled" type="checkbox" /> ${escapeHtml(i18n('Enabled'))}</label>
            <label class="checkbox_label"><input id="luker_rpg_memory_auto_extraction_enabled" type="checkbox" /> ${escapeHtml(i18n('Auto extraction'))}</label>
            <small style="opacity:0.8">${escapeHtml(i18n('Auto extraction help'))}</small>
            <label class="checkbox_label"><input id="luker_rpg_memory_auto_compression_enabled" type="checkbox" /> ${escapeHtml(i18n('Auto compression'))}</label>
            <small style="opacity:0.8">${escapeHtml(i18n('Auto compression help'))}</small>
            <label class="checkbox_label"><input id="luker_rpg_memory_recall_enabled" type="checkbox" /> ${escapeHtml(i18n('Enable recall injection'))}</label>
            <label for="luker_rpg_memory_recall_method">${escapeHtml(i18n('Recall method'))}</label>
            <select id="luker_rpg_memory_recall_method" class="text_pole">
                <option value="llm">${escapeHtml(i18n('LLM Recall (default)'))}</option>
                <option value="hybrid">${escapeHtml(i18n('Hybrid Pipeline (vector + graph diffusion)'))}</option>
                <option value="hybrid_rerank">${escapeHtml(i18n('Hybrid + Rerank'))}</option>
                <option value="hybrid_llm">${escapeHtml(i18n('Hybrid + LLM Rerank'))}</option>
            </select>
            <div id="luker_rpg_memory_hybrid_settings" style="display:none">
                <small style="opacity:0.85">${escapeHtml(i18n('Embedding profile is shared via the Connection Profile registry — pick one below. Manage profiles in the Connection Profile panel (Embedding tab) under API Connections.'))}</small><br>
                <label>${escapeHtml(i18n('Embedding profile'))}</label>
                <select id="luker_rpg_memory_embedding_profile" class="text_pole flex1"></select>
                <label>${escapeHtml(i18n('Vector pre-filter Top-K'))} <input id="luker_rpg_memory_vector_topk" class="text_pole" type="number" min="5" max="100" step="1" /></label>
                <label>${escapeHtml(i18n('Max recall results'))} <input id="luker_rpg_memory_hybrid_max_results" class="text_pole" type="number" min="3" max="50" step="1" /></label>
            </div>
            <div id="luker_rpg_memory_rerank_settings" style="display:none">
                <label>${escapeHtml(i18n('Rerank profile'))}</label>
                <select id="luker_rpg_memory_rerank_profile" class="text_pole flex1"></select>
            </div>
            <label for="luker_rpg_memory_recall_inject_position">${escapeHtml(i18n('Injection position'))}</label>
            <select id="luker_rpg_memory_recall_inject_position" class="text_pole">
                <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
                <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
                <option value="${world_info_position.ANTop}">${escapeHtml(i18n('Before Author\'s Note'))}</option>
                <option value="${world_info_position.ANBottom}">${escapeHtml(i18n('After Author\'s Note'))}</option>
                <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
                <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
                <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
            </select>
            <label for="luker_rpg_memory_recall_inject_depth">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
            <input id="luker_rpg_memory_recall_inject_depth" class="text_pole" type="number" min="0" max="10000" step="1" />
            <label for="luker_rpg_memory_recall_inject_role">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
            <select id="luker_rpg_memory_recall_inject_role" class="text_pole">
                <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
            </select>
            <label for="luker_rpg_memory_recall_api_preset">${escapeHtml(i18n('Recall API preset (Connection profile)'))}</label>
            <select id="luker_rpg_memory_recall_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_recall_preset">${escapeHtml(i18n('Recall preset (params + prompt)'))}</label>
            <select id="luker_rpg_memory_recall_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_api_preset">${escapeHtml(i18n('Extract API preset (Connection profile)'))}</label>
            <select id="luker_rpg_memory_extract_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_preset">${escapeHtml(i18n('Extract preset (params + prompt)'))}</label>
            <select id="luker_rpg_memory_extract_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_request_api_preset">${escapeHtml(i18n('Model request API preset (Connection profile)'))}</label>
            <select id="luker_rpg_memory_request_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_request_llm_preset">${escapeHtml(i18n('Model request LLM preset (params + prompt)'))}</label>
            <select id="luker_rpg_memory_request_llm_preset" class="text_pole"></select>
            <label class="checkbox_label">
                <input id="luker_rpg_memory_include_world_info" type="checkbox" />
                ${escapeHtml(i18n('Include world info'))}
            </label>
            <label class="checkbox_label">
                <input id="luker_rpg_memory_use_streaming_transport" type="checkbox" />
                ${escapeHtml(i18n('Use streaming transport (avoid timeout on slow APIs)'))}
            </label>

            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Update every N assistant turns'))} <input id="luker_rpg_memory_update_every" class="text_pole" type="number" min="1" step="1" /></label>
            </div>

            <label>${escapeHtml(i18n('Node Type Schema (Visual Editor)'))}</label>
            <small style="opacity:0.8">${escapeHtml(i18n('Configure memory table types, extraction hints, and compression strategy in a popup editor.'))}</small>
            <small id="luker_rpg_memory_schema_scope" style="opacity:0.85"></small>
            <small id="luker_rpg_memory_schema_summary" style="opacity:0.85"></small>
            <div class="flex-container">
                <div id="luker_rpg_memory_open_schema_editor" class="menu_button">${escapeHtml(i18n('Open Schema Editor'))}</div>
                <div id="luker_rpg_memory_open_advanced" class="menu_button">${escapeHtml(i18n('Open Advanced Settings'))}</div>
                <div id="luker_rpg_memory_open_schema_studio" class="menu_button">${escapeHtml(i18n('AI Iterate Schema'))}</div>
            </div>
            <small id="luker_rpg_memory_advanced_scope" style="opacity:0.85"></small>
            <div class="flex-container">
                <div id="luker_rpg_memory_advanced_save_global" class="menu_button">${escapeHtml(i18n('Save Advanced to Global'))}</div>
                <div id="luker_rpg_memory_advanced_save_character" class="menu_button">${escapeHtml(i18n('Save Advanced to Character'))}</div>
                <div id="luker_rpg_memory_advanced_clear_character_override" class="menu_button">${escapeHtml(i18n('Clear Character Advanced Override'))}</div>
            </div>

            <div class="flex-container">
                <div id="luker_rpg_memory_view_graph" class="menu_button">${escapeHtml(i18n('View Graph'))}</div>
                <div id="luker_rpg_memory_fill" class="menu_button">${escapeHtml(i18n('Fill Graph (Incremental)'))}</div>
                <div id="luker_rpg_memory_rebuild" class="menu_button">${escapeHtml(i18n('Rebuild From Chat'))}</div>
                <div id="luker_rpg_memory_rebuild_recent" class="menu_button">${escapeHtml(i18n('Rebuild Recent N Assistant Turns'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_manual_compress" class="menu_button">${escapeHtml(i18n('Manual Compress'))}</div>
                <div id="luker_rpg_memory_reset" class="menu_button">${escapeHtml(i18n('Reset Current Chat'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_recompute_vectors" class="menu_button">${escapeHtml(i18n('Recompute Vector Index'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_export" class="menu_button">${escapeHtml(i18n('Export Current Chat Graph'))}</div>
                <div id="luker_rpg_memory_import" class="menu_button">${escapeHtml(i18n('Import Current Chat Graph'))}</div>
            </div>
            <input id="luker_rpg_memory_import_file" type="file" accept=".json,application/json" hidden />

            <label for="luker_rpg_memory_debug_query">${escapeHtml(i18n('Recall debug query'))}</label>
            <input id="luker_rpg_memory_debug_query" class="text_pole" type="text" placeholder="${escapeHtml(i18n('e.g. what happened at the ruins with Mira?'))}" />
            <div class="flex-container">
                <div id="luker_rpg_memory_recall_debug" class="menu_button">${escapeHtml(i18n('Run Recall Debug'))}</div>
                <div id="luker_rpg_memory_view_last_injection" class="menu_button">${escapeHtml(i18n('View Last Injection'))}</div>
            </div>

            <small id="luker_rpg_memory_stats" style="opacity:0.8"></small>
            <small id="luker_rpg_memory_status" style="opacity:0.8"></small>
        </div>
    </div>
</div>`;
}
