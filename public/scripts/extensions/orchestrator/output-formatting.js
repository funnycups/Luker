/**
 * Output formatters for the orchestrator runtime + AI build prompts.
 *
 * Pure functions only — no chat-state, no `extension_settings`, no
 * spec-walking dependencies. Two roles:
 *
 *   1. Text formatters that wrap arbitrary JS values in
 *      JSON / YAML / markdown / XML for human-readable consumption
 *      (`toCompactJsonText`, `toReadableYamlText`, `buildYamlMarkdownBlock`,
 *      `buildAiSuggestInputXml`). The YAML pass falls back to compact
 *      JSON when the YAML library refuses an input shape.
 *
 *   2. Stage-output bookkeeping helpers that convert the runtime's
 *      `stageOutputs` array into Map-shaped node→output lookups
 *      (`buildNodeOutputMapFromStageOutputs`, `buildStageWorkerOutputMap`,
 *      `mergeNodeOutputMaps`). These power the `{{previous_outputs}}` /
 *      `{{distiller}}` template substitutions.
 *
 *   3. Final markdown wrappers around those maps — the YAML blocks the
 *      runtime injects above each downstream node prompt
 *      (`buildPreviousOutputsMarkdown`, `buildDistillerOutputMarkdown`).
 *
 * `createStageOutputSnapshot`, `collectPriorNodeEntries`, and
 * `resolveReviewTargetEntries` live in main.js because they call
 * `normalizeNodeSpec` / `isReviewNodeSpec` / `getStageRuntimeMode` —
 * spec-walking helpers that depend on the runtime's full
 * `latestOrchestrationSnapshot` / per-chat state.
 */

import { yaml } from '../../../lib.js';

export function toCompactJsonText(value, fallback = '{}') {
    try {
        return JSON.stringify(value);
    } catch {
        return fallback;
    }
}

export function toReadableYamlText(value, fallback = '{}') {
    try {
        const normalized = value === undefined ? null : value;
        const text = yaml.stringify(normalized, { indent: 2, lineWidth: 0 });
        const trimmed = String(text || '').trim();
        return trimmed || fallback;
    } catch {
        return toCompactJsonText(value, fallback);
    }
}

export function buildYamlMarkdownBlock(title, note, value) {
    const yamlText = toReadableYamlText(value);
    return [
        `## ${title}`,
        String(note || '').trim(),
        '```yaml',
        yamlText,
        '```',
    ].join('\n');
}

export function buildAiSuggestInputXml({
    character = {},
    overrideGoal = '',
    runtimeContextGuarantees = {},
    injectionContract = {},
    agentApiRouting = {},
    agentPromptPresetRouting = {},
    mandatoryQualityAxes = {},
    qualityGateContract = {},
    recommendedBlueprint = {},
    antiPatterns = {},
    globalOrchestrationSpec = {},
    globalPresets = {},
    toolProtocol = {},
} = {}) {
    return [
        '# Orchestration Build Input',
        'Read all sections before calling tools. Keep edits practical and implementation-oriented.',
        buildYamlMarkdownBlock('character_profile', 'Current active character card snapshot.', character),
        buildYamlMarkdownBlock('override_goal', 'Optional user goal override for this character profile.', { override_goal: String(overrideGoal || '') }),
        buildYamlMarkdownBlock('runtime_context_guarantees', 'What runtime context is already guaranteed for both orchestration nodes and final generation.', runtimeContextGuarantees),
        buildYamlMarkdownBlock('injection_contract', 'How final orchestration outputs are injected to generation.', injectionContract),
        buildYamlMarkdownBlock('agent_api_routing', 'Optional per-agent API routing through Connection Manager profiles. Leave apiPresetName empty unless the user explicitly asks for per-agent model routing.', agentApiRouting),
        buildYamlMarkdownBlock('agent_prompt_preset_routing', 'Optional per-agent chat completion preset routing. Leave promptPresetName empty unless the user explicitly asks for per-agent chat completion preset routing.', agentPromptPresetRouting),
        buildYamlMarkdownBlock('mandatory_quality_axes', 'Quality axes that must be covered by stage/preset design.', mandatoryQualityAxes),
        buildYamlMarkdownBlock('quality_gate_contract', 'Hard quality gates the profile must explicitly enforce.', qualityGateContract),
        buildYamlMarkdownBlock('recommended_blueprint', 'Preferred orchestration blueprint when no special reason to deviate.', recommendedBlueprint),
        buildYamlMarkdownBlock('anti_patterns', 'Patterns to avoid when generating orchestration prompts.', antiPatterns),
        buildYamlMarkdownBlock('global_orchestration_spec', 'Current global orchestration spec as primary baseline. Reuse/adapt this structure before inventing new topology.', globalOrchestrationSpec),
        buildYamlMarkdownBlock('global_presets', 'Current global preset map as primary baseline. Preserve useful detail depth; do not collapse into short generic prompts.', globalPresets),
        buildYamlMarkdownBlock('prompt_richness_contract', 'Each node prompt must be concrete and non-trivial.', {
            system_prompt_contract: 'At least 3 concrete rule lines; avoid generic slogans.',
            user_template_contract: 'Must include Task block with multiple actionable bullets and clear output contract.',
            anti_lazy_rule: 'Thin one-liner prompts are invalid.',
        }),
        buildYamlMarkdownBlock('tool_protocol', 'Function-call protocol and expected argument shapes.', toolProtocol),
    ].join('\n');
}

export function buildPreviousOutputsMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## previous_node_outputs',
        'Outputs from completed worker nodes currently available to downstream execution.',
        '```yaml',
        toReadableYamlText(Object.fromEntries(previousNodeOutputs), '{}'),
        '```',
    ].join('\n');
}

export function buildDistillerOutputMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## distiller_output',
        'Output from distiller node if available.',
        '```yaml',
        toReadableYamlText(previousNodeOutputs.get('distiller') || {}, '{}'),
        '```',
    ].join('\n');
}

export function buildNodeOutputMapFromStageOutputs(stageOutputs = []) {
    const result = new Map();
    for (const stage of Array.isArray(stageOutputs) ? stageOutputs : []) {
        for (const node of Array.isArray(stage?.nodes) ? stage.nodes : []) {
            const nodeId = String(node?.node || '').trim();
            if (!nodeId) {
                continue;
            }
            result.set(nodeId, node?.output);
        }
    }
    return result;
}

export function buildStageWorkerOutputMap(stageOutput = null) {
    const result = new Map();
    for (const node of Array.isArray(stageOutput?.nodes) ? stageOutput.nodes : []) {
        const nodeId = String(node?.node || '').trim();
        if (!nodeId) {
            continue;
        }
        result.set(nodeId, node?.output);
    }
    return result;
}

export function mergeNodeOutputMaps(...maps) {
    const merged = new Map();
    for (const map of maps) {
        if (!(map instanceof Map)) {
            continue;
        }
        for (const [key, value] of map.entries()) {
            merged.set(key, value);
        }
    }
    return merged;
}
