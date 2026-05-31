/**
 * Augments the Iteration Studio AI's system prompt with a read-only intro
 * listing the visible custom tools — both Layer-3 (handwritten in
 * `profile.customTools[]`) and Layer-2 (registered by other extensions or
 * bridged from SillyTavern function tools).
 *
 * The intro is purely informational: the AI is told it can flip the
 * enable flag at the mode-appropriate path to enable/disable but must
 * NOT mutate `customTools[]` itself (those entries are user-owned and
 * the Studio AI has no permission to author / overwrite executable
 * JavaScript). When both lists are empty we return the base prompt
 * verbatim so we don't pollute every prompt with a "no custom tools"
 * section.
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
    if (profileTools.length === 0 && ext.length === 0) {
        return basePrompt;
    }
    const lines = [basePrompt, '', '## Visible custom tools in this profile'];
    if (ext.length > 0) {
        lines.push('', 'From extensions:');
        for (const tool of ext) {
            const name = String(tool?.name || '');
            if (!name) continue;
            const toolMode = tool?.mode === 'read' ? 'read' : 'write';
            const desc = String(tool?.description || '');
            lines.push(`- ${name} [${toolMode}]: ${desc}`);
        }
    }
    if (profileTools.length > 0) {
        lines.push('', 'From this profile (handwritten):');
        for (const tool of profileTools) {
            const name = String(tool?.name || '');
            if (!name) continue;
            const toolMode = tool?.mode === 'read' ? 'read' : 'write';
            const desc = String(tool?.description || '');
            lines.push(`- ${name} [${toolMode}]: ${desc}`);
        }
    }
    const flagPath = FLAG_PATHS[mode] ?? FLAG_PATHS.loop;
    lines.push('');
    lines.push(`To enable/disable, set \`${flagPath}\` to true/false on the profile. Do NOT modify \`customTools[]\` — tool definitions are user-owned, you only adjust enable flags.`);
    return lines.join('\n');
}
