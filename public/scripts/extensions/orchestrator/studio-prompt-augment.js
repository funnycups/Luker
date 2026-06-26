/**
 * Augments the Iteration Studio AI's system prompt with a per-profile
 * intro of the visible custom tools — both Layer-3 (handwritten /
 * AI-authored in `profile.customTools[]`) and Layer-2 (registered by
 * other extensions or bridged from SillyTavern function tools).
 *
 * The intro is informational AND directive: the AI learns which tools
 * already exist on the profile (so it doesn't pick a colliding name),
 * which Layer-2 tools are visible (so it knows what's already covered),
 * and which mode-appropriate enable-flag path to flip if it wants to
 * enable/disable a tool. The trailing instruction also tells the AI
 * about the `luker_orch_*_custom_tool` family for authoring + the
 * discovery tools (`luker_ctx_*` / `luker_docs_*`) to use BEFORE
 * writing JavaScript that touches `ctx`.
 *
 * When both lists are empty we still emit the trailing instruction so
 * the AI knows authoring is available for an empty profile.
 *
 * The flag path differs by mode: loop / director put it under
 * `tools.custom.<name>`, agenda under `defaultTools.custom.<name>`,
 * and spec under `spec.defaultTools.custom.<name>`. Callers must pass
 * the iteration mode so the appended instruction tells the Studio AI
 * the right path to write to.
 *
 * Lives in its own module so the jest unit test can import it without
 * pulling main.js's UI / event surface.
 */

const FLAG_PATHS = {
    loop: 'tools.custom.<name>',
    director: 'tools.custom.<name>',
    agenda: 'defaultTools.custom.<name>',
    spec: 'spec.defaultTools.custom.<name>',
};

export function augmentStudioPromptWithCustomTools(basePrompt, profile, extensionTools, mode = 'loop') {
    const profileTools = Array.isArray(profile?.customTools) ? profile.customTools : [];
    const ext = Array.isArray(extensionTools) ? extensionTools : [];
    const flagPath = FLAG_PATHS[mode] ?? FLAG_PATHS.loop;
    const lines = [basePrompt, '', '## Custom tools'];
    if (profileTools.length === 0 && ext.length === 0) {
        lines.push('', 'This profile has no custom tools yet.');
    } else {
        if (ext.length > 0) {
            lines.push('', 'Visible Layer-2 tools (registered by other extensions, cannot be authored from here — only enable flags are reachable):');
            for (const tool of ext) {
                const name = String(tool?.name || '');
                if (!name) continue;
                const toolMode = tool?.mode === 'read' ? 'read' : 'write';
                const desc = String(tool?.description || '');
                lines.push(`- ${name} [${toolMode}]: ${desc}`);
            }
        }
        if (profileTools.length > 0) {
            lines.push('', 'Layer-3 tools on this profile (handwritten / AI-authored, fully editable):');
            for (const tool of profileTools) {
                const name = String(tool?.name || '');
                if (!name) continue;
                const toolMode = tool?.mode === 'read' ? 'read' : 'write';
                const desc = String(tool?.description || '');
                lines.push(`- ${name} [${toolMode}]: ${desc}`);
            }
        }
    }
    lines.push('');
    lines.push(`Enable / disable flag path for this mode: \`${flagPath}\` (true = offered to the runtime agent).`);
    lines.push('');
    lines.push('Authoring + maintenance tool family:');
    lines.push('- `luker_orch_list_custom_tools` / `luker_orch_get_custom_tool` — inspect first; never overwrite a tool whose body you have not just read.');
    lines.push('- `luker_orch_set_custom_tool` — create or fully overwrite one entry. Body is async JS `(args, ctx) => {...}`. Description must explain WHEN the runtime agent should call this — the agent reads it to decide.');
    lines.push('- `luker_orch_patch_custom_tool_body` — find/replace patch on an existing body. Prefer this over `set` for tweaks; avoids resending long bodies and reduces drift risk during review.');
    lines.push('- `luker_orch_patch_custom_tool_schema` — replace only the parameters JSON-Schema, body unchanged.');
    lines.push('- `luker_orch_remove_custom_tool` — delete one tool by name.');
    lines.push('- `luker_orch_dry_run_custom_tool` — compile + run a body in a 3-second sandbox with sample args; relays full exception + console output back. ALWAYS run this with realistic args before staging a write proposal — never make the user approve a body you have not validated against the live ctx.');
    lines.push('');
    lines.push('Discovery tools (use BEFORE writing or patching JavaScript that touches ctx):');
    lines.push('- `luker_ctx_list_keys` + `luker_ctx_describe` — enumerate the runtime ctx surface (the same object SillyTavern/Luker extensions get via getContext()). Returns type / arity / source preview / sub-keys. Do not guess `ctx.foo.bar`; walk into it.');
    lines.push('- `luker_docs_list` + `luker_docs_read` — read authoritative docs under `docs/`. Useful starting points: `features/orchestrator/custom-tools.md` (ctx surface inside a custom tool body), `development/extension-api/chat-and-state.md` (Floor State / chat state / character state), `development/extension-api/generation.md`, `development/extension-api/world-info.md`, `development/extension-api/orchestrator-tools.md`.');
    lines.push('');
    lines.push('Every write goes through user review on the ProposalBus before reaching the live profile. Reads + dry-runs are immediate.');
    return lines.join('\n');
}
