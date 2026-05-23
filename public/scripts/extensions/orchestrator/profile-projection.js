/**
 * Projects a `{ spec, presets }` orchestration profile down to the
 * AI-visible shape (templates normalized, preset fields collapsed) used
 * to feed the *current* global profile back into iteration-mode prompts
 * as `globalOrchestrationSpec` / `globalPresets`.
 *
 * Lifted from ai-build.js when the standalone AI quick-build flow was
 * retired in favor of the iteration studio — iter-studio still calls this
 * to assemble the helper context for buildAiIterationUserPrompt.
 */

import { sanitizePresetMap } from './editable-spec.js';
import {
    getPresetApiPresetName,
    getPresetPromptPresetName,
} from './agent-resolution.js';
import {
    normalizeNodeSpec,
    normalizeNodeType,
    sanitizeSpec,
} from './spec-schema.js';
import { normalizeTemplateForAiPrompt } from './template-vars.js';

export function sanitizeProfileForAiPrompt(profile = null) {
    const safeSpec = sanitizeSpec(profile?.spec);
    const safePresets = sanitizePresetMap(profile?.presets);
    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    const sanitizedStages = stages.map((stage) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const sanitizedNodes = nodes.map((rawNode) => {
            if (typeof rawNode === 'string') {
                return rawNode;
            }
            const node = normalizeNodeSpec(rawNode);
            const nextNode = {
                id: String(node?.id || '').trim(),
                preset: String(node?.preset || node?.id || '').trim(),
                type: normalizeNodeType(node?.type),
            };
            const template = String(node?.userPromptTemplate || '');
            if (template.trim()) {
                nextNode.userPromptTemplate = normalizeTemplateForAiPrompt(template);
            }
            return nextNode.id ? nextNode : null;
        }).filter(Boolean);
        return {
            id: String(stage?.id || '').trim(),
            mode: String(stage?.mode || '').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: sanitizedNodes,
        };
    });

    const sanitizedPresets = {};
    for (const [presetId, preset] of Object.entries(safePresets || {})) {
        sanitizedPresets[presetId] = {
            systemPrompt: String(preset?.systemPrompt || '').trim(),
            userPromptTemplate: normalizeTemplateForAiPrompt(String(preset?.userPromptTemplate || '').trim()),
            apiPresetName: getPresetApiPresetName(preset),
            promptPresetName: getPresetPromptPresetName(preset),
        };
    }

    return {
        spec: { stages: sanitizedStages },
        presets: sanitizedPresets,
    };
}
