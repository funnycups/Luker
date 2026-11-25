/**
 * Output formatters for the orchestrator runtime + AI build prompts.
 *
 * Pure functions only — no chat-state, no `extension_settings`, no
 * spec-walking dependencies. Two roles:
 *
 *   1. Text formatters that wrap arbitrary JS values in
 *      JSON / YAML for human-readable consumption
 *      (`toCompactJsonText`, `toReadableYamlText`). The YAML pass falls back to compact
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

const yaml = Luker.getContext().lib.yaml;

function toCompactJsonText(value, fallback = '{}') {
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
