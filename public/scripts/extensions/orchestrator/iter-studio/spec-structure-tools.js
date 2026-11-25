// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Orchestrator iteration studio — spec-mode structure edit tools.
 *
 * Executes the stage / node / preset / node-tools edit tools against a
 * spec-mode iteration session's `workingProfile` (`{ spec, presets }`).
 * `executeAiIterationToolCalls` in main.js routes these tool names here
 * and owns the shared `actions` / `toolResults` accumulators.
 *
 * Preset removal is deferred to `finalize()`: a later `set_preset` on the
 * same id in the same batch cancels the removal, and a preset still
 * referenced by a node is kept.
 */

import { serializeToolResultContent } from '../../../lib/iter-tool-calling.js';
import { ORCH_NODE_TYPE_WORKER } from '../defaults.js';
import { sanitizeConnectionProfileName, sanitizePromptPresetName } from '../agent-resolution.js';
import { createPresetDraft, isPresetReferencedInSpec, normalizeIdToken, resolveStoredIdReference, resolveStoredIdToken } from '../editable-spec.js';
import { readIterationStringArg } from '../iter-arg-validator.js';
import { sanitizeAgentToolFlags } from '../persistence.js';
import { normalizeNodeType, sanitizeSpec } from '../spec-schema.js';
import { normalizeTemplateForRuntime } from '../template-vars.js';
import { ambiguousIdFailure } from './tool-failures.js';

export const SPEC_STRUCTURE_TOOL_NAMES = new Set([
    'luker_orch_set_stage',
    'luker_orch_remove_stage',
    'luker_orch_set_node',
    'luker_orch_remove_node',
    'luker_orch_set_preset',
    'luker_orch_remove_preset',
    'luker_orch_set_spec_default_tools',
    'luker_orch_set_spec_node_tools',
    'luker_orch_clear_spec_node_tools',
]);

/**
 * Resolve a stage by `resolveStoredIdToken`.
 * @returns {{ stage: object|null, stageId: string, ambiguous?: string[] }}
 *   `stageId` is the stored id when found, else the trimmed request.
 */
function resolveIterationStage(session, stageArg, createIfMissing = false) {
    const stages = session?.workingProfile?.spec?.stages || [];
    const resolved = resolveStoredIdToken(stages.map(item => item?.id), stageArg);
    if (resolved.status === 'found') {
        return { stage: stages[resolved.index], stageId: resolved.id };
    }
    if (resolved.status === 'ambiguous') {
        return { stage: null, stageId: resolved.id, ambiguous: resolved.matches };
    }
    if (resolved.status === 'missing' && createIfMissing) {
        const stage = { id: resolved.id, mode: 'serial', nodes: [] };
        stages.push(stage);
        return { stage, stageId: resolved.id };
    }
    return { stage: null, stageId: resolved.id || '' };
}

/**
 * Resolve a node within a stage by `resolveStoredIdToken`.
 * @returns {{ index: number, nodeId: string, ambiguous?: string[] }}
 */
function resolveIterationNode(stage, nodeArg) {
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    const resolved = resolveStoredIdToken(nodes.map(item => (typeof item === 'string' ? item : item?.id)), nodeArg);
    if (resolved.status === 'found') {
        return { index: resolved.index, nodeId: resolved.id };
    }
    return {
        index: -1,
        nodeId: resolved.id || '',
        ...(resolved.status === 'ambiguous' ? { ambiguous: resolved.matches } : {}),
    };
}

function applyIndexReorder(list, currentIndex, position) {
    if (!Array.isArray(list) || currentIndex < 0 || currentIndex >= list.length) {
        return;
    }
    if (!Number.isInteger(position)) {
        return;
    }
    const targetIndex = Math.max(0, Math.min(list.length - 1, position));
    if (targetIndex === currentIndex) {
        return;
    }
    const [item] = list.splice(currentIndex, 1);
    list.splice(targetIndex, 0, item);
}

/**
 * @param {object} session spec-mode iteration session
 * @param {{ actions: string[], toolResults: object[] }} accumulators shared with the caller
 * @returns {{ execute: (name: string, args: object, pushToolResult: (payload: object) => void) => boolean, finalize: () => boolean }}
 *   `execute` and `finalize` return whether the working profile changed.
 */
export function createSpecStructureToolExecutor(session, { actions, toolResults }) {
    const allowedPresetFallback = Object.keys(session?.workingProfile?.presets || {})[0] || 'distiller';
    const pendingPresetRemovalActions = new Map();

    function execute(name, args, pushToolResult) {
        if (name === 'luker_orch_set_stage') {
            const stageId = normalizeIdToken(args.stage_id, '');
            if (!stageId) {
                const actionText = 'Skipped stage update: missing stage_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
                return false;
            }
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            const resolvedStage = resolveIterationStage(session, args.stage_id, true);
            if (resolvedStage.ambiguous) {
                const failure = ambiguousIdFailure('stage update', 'stage', resolvedStage.stageId, resolvedStage.ambiguous);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: resolvedStage.stageId });
                return false;
            }
            const { stage, stageId: resolvedStageId } = resolvedStage;
            stage.mode = mode;
            if (!Array.isArray(stage.nodes)) {
                stage.nodes = [];
            }
            const stages = session.workingProfile.spec.stages;
            const index = stages.indexOf(stage);
            applyIndexReorder(stages, index, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const actionText = `Stage "${resolvedStageId}" updated (${mode}).`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, stage_id: resolvedStageId, mode });
            return true;
        }
        if (name === 'luker_orch_remove_stage') {
            const { stage, stageId, ambiguous } = resolveIterationStage(session, args.stage_id, false);
            if (ambiguous) {
                const failure = ambiguousIdFailure('stage removal', 'stage', stageId, ambiguous);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: stageId });
                return false;
            }
            const stages = session?.workingProfile?.spec?.stages || [];
            const index = stage ? stages.indexOf(stage) : -1;
            if (index >= 0) {
                stages.splice(index, 1);
                const actionText = `Stage "${stageId}" removed.`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId });
                return true;
            }
            const actionText = `Skipped stage removal: "${stageId}" not found.`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId });
            return false;
        }
        if (name === 'luker_orch_set_node') {
            const stageId = normalizeIdToken(args.stage_id, '');
            const nodeId = normalizeIdToken(args.node_id, '');
            if (!stageId || !nodeId) {
                const actionText = 'Skipped node update: missing stage_id or node_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
                return false;
            }
            const resolvedStage = resolveIterationStage(session, args.stage_id, false);
            const resolvedNode = resolveIterationNode(resolvedStage.stage, args.node_id);
            const presetRequest = normalizeIdToken(args.preset, '') ? args.preset : (nodeId || allowedPresetFallback);
            const resolvedPreset = resolveStoredIdToken(Object.keys(session.workingProfile.presets || {}), presetRequest);
            const ambiguity = resolvedStage.ambiguous
                ? ['stage', resolvedStage.stageId, resolvedStage.ambiguous]
                : resolvedNode.ambiguous
                    ? ['node', resolvedNode.nodeId, resolvedNode.ambiguous]
                    : resolvedPreset.status === 'ambiguous'
                        ? ['preset', resolvedPreset.id, resolvedPreset.matches]
                        : null;
            if (ambiguity) {
                const failure = ambiguousIdFailure('node update', ...ambiguity);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: stageId, node_id: nodeId });
                return false;
            }
            const presetId = resolvedPreset.id || allowedPresetFallback;
            if (presetId !== presetId.trim()
                && resolveStoredIdReference(session.workingProfile.presets, presetId.trim()) !== presetId) {
                // Node refs are trimmed on read (`sanitizeSpec`) and resolve
                // back to their key, so a whitespace-padded key is only
                // reachable when its trimmed id resolves to it.
                const actionText = `Skipped node update: preset id ${JSON.stringify(presetId)} has surrounding whitespace and a node reference would resolve to another preset. Rename the preset in the orchestration editor.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'invalid_args', detail: actionText, action: actionText, stage_id: stageId, node_id: nodeId, preset_id: presetId });
                return false;
            }
            const stage = resolvedStage.stage || resolveIterationStage(session, stageId, true).stage;
            if (!session.workingProfile.presets[presetId]) {
                session.workingProfile.presets[presetId] = createPresetDraft();
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            const existingIndex = resolvedNode.index;
            // Strict optional-string fields. Wrong-type args throw and
            // surface as `{ok:false, error:'invalid_args'}` tool replies
            // — silently falling back to the existing value (the old
            // behavior) collapsed onto the iter-studio's "already
            // matches" noop and the AI never learned what was wrong.
            let nextType, nextUserPromptTemplate;
            try {
                nextType = readIterationStringArg(args, 'type', name);
                nextUserPromptTemplate = readIterationStringArg(args, 'userPromptTemplate', name);
            } catch (err) {
                const detail = String(err?.message || err || 'invalid_args');
                actions.push(`Skipped node "${nodeId}" patch: ${detail}`);
                pushToolResult({ ok: false, error: 'invalid_args', detail, action: `Skipped node "${nodeId}" patch: ${detail}` });
                return false;
            }
            const existingNode = existingIndex >= 0 && nodes[existingIndex] && typeof nodes[existingIndex] === 'object'
                ? nodes[existingIndex]
                : null;
            const nextNodeType = nextType !== undefined
                ? normalizeNodeType(nextType)
                : normalizeNodeType(existingNode?.type ?? ORCH_NODE_TYPE_WORKER);
            const nextNode = {
                id: resolvedNode.nodeId || nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: nextUserPromptTemplate !== undefined
                    ? normalizeTemplateForRuntime(nextUserPromptTemplate)
                    : String(existingNode?.userPromptTemplate || ''),
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" updated in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
                const actionText = `Node "${nodeId}" added to stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({
                    ok: true,
                    changed: true,
                    action: actionText,
                    stage_id: stageId,
                    node_id: nodeId,
                    preset_id: presetId,
                });
            }
            stage.nodes = nodes;
            return true;
        }
        if (name === 'luker_orch_remove_node') {
            const { stage, stageId, ambiguous: stageAmbiguous } = resolveIterationStage(session, args.stage_id, false);
            const { index, nodeId, ambiguous: nodeAmbiguous } = resolveIterationNode(stage, args.node_id);
            if (stageAmbiguous || nodeAmbiguous) {
                const failure = stageAmbiguous
                    ? ambiguousIdFailure('node removal', 'stage', stageId, stageAmbiguous)
                    : ambiguousIdFailure('node removal', 'node', nodeId, nodeAmbiguous);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (!stage || !Array.isArray(stage.nodes)) {
                const actionText = `Skipped node removal: stage "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (index >= 0) {
                stage.nodes.splice(index, 1);
                const actionText = `Node "${nodeId}" removed from stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: true, action: actionText, stage_id: stageId, node_id: nodeId });
                return true;
            }
            const actionText = `Skipped node removal: "${nodeId}" not found in stage "${stageId}".`;
            actions.push(actionText);
            pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
            return false;
        }
        if (name === 'luker_orch_set_preset') {
            const resolvedPreset = resolveStoredIdToken(Object.keys(session.workingProfile.presets || {}), args.preset_id);
            if (resolvedPreset.status === 'empty') {
                const actionText = 'Skipped preset update: missing preset_id.';
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'invalid_args', action: actionText });
                return false;
            }
            const presetId = resolvedPreset.id;
            if (resolvedPreset.status === 'ambiguous') {
                const failure = ambiguousIdFailure('preset update', 'preset', presetId, resolvedPreset.matches);
                actions.push(failure.action);
                pushToolResult({ ...failure, preset_id: presetId });
                return false;
            }
            const queuedRemovalActionIndexes = pendingPresetRemovalActions.get(presetId) || [];
            for (const actionIndex of queuedRemovalActionIndexes) {
                if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                    const actionText = `Skipped preset removal: "${presetId}" overridden by later preset update.`;
                    actions[actionIndex] = actionText;
                    if (toolResults[actionIndex]) {
                        toolResults[actionIndex].content = serializeToolResultContent({
                            ok: false,
                            error: actionText,
                            preset_id: presetId,
                        });
                    }
                }
            }
            pendingPresetRemovalActions.delete(presetId);
            const beforePreset = session.workingProfile.presets[presetId] || null;
            session.workingProfile.presets[presetId] = createPresetDraft({
                ...(beforePreset || {}),
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
                ...(Object.prototype.hasOwnProperty.call(args, 'apiPresetName')
                    ? { apiPresetName: sanitizeConnectionProfileName(args.apiPresetName) }
                    : {}),
                ...(Object.prototype.hasOwnProperty.call(args, 'promptPresetName')
                    ? { promptPresetName: sanitizePromptPresetName(args.promptPresetName) }
                    : {}),
            });
            const actionText = `Preset "${presetId}" updated.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: true, action: actionText, preset_id: presetId });
            return true;
        }
        if (name === 'luker_orch_remove_preset') {
            const resolvedPreset = resolveStoredIdToken(Object.keys(session?.workingProfile?.presets || {}), args.preset_id);
            const presetId = resolvedPreset.id || '';
            if (resolvedPreset.status === 'empty') {
                const actionText = `Skipped preset removal: "${presetId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, preset_id: presetId });
                return false;
            }
            if (resolvedPreset.status === 'ambiguous') {
                const failure = ambiguousIdFailure('preset removal', 'preset', presetId, resolvedPreset.matches);
                actions.push(failure.action);
                pushToolResult({ ...failure, preset_id: presetId });
                return false;
            }
            if (!pendingPresetRemovalActions.has(presetId)) {
                pendingPresetRemovalActions.set(presetId, []);
            }
            const actionText = `Preset "${presetId}" removal requested.`;
            actions.push(actionText);
            pendingPresetRemovalActions.get(presetId).push(actions.length - 1);
            pushToolResult({ ok: true, action: actionText, preset_id: presetId });
            return false;
        }
        if (name === 'luker_orch_set_spec_default_tools') {
            const spec = session.workingProfile.spec;
            if (!spec.defaultTools || typeof spec.defaultTools !== 'object') {
                spec.defaultTools = sanitizeAgentToolFlags({});
            }
            const before = JSON.stringify(spec.defaultTools);
            const incoming = args.tools && typeof args.tools === 'object' ? args.tools : {};
            for (const [ns, verbs] of Object.entries(incoming)) {
                if (!verbs || typeof verbs !== 'object') continue;
                if (!spec.defaultTools[ns] || typeof spec.defaultTools[ns] !== 'object') {
                    spec.defaultTools[ns] = {};
                }
                for (const [verb, value] of Object.entries(verbs)) {
                    spec.defaultTools[ns][verb] = Boolean(value);
                }
            }
            session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
            const after = JSON.stringify(session.workingProfile.spec.defaultTools);
            const profileChanged = before !== after;
            const actionText = profileChanged ? 'Spec default tools updated.' : 'Spec default tools patch produced no changes.';
            actions.push(actionText);
            pushToolResult({ ok: true, changed: profileChanged, action: actionText, tools: session.workingProfile.spec.defaultTools });
            return profileChanged;
        }
        if (name === 'luker_orch_set_spec_node_tools') {
            const { stage, stageId, ambiguous: stageAmbiguous } = resolveIterationStage(session, args.stage_id, false);
            const { index: nodeIndex, nodeId, ambiguous: nodeAmbiguous } = resolveIterationNode(stage, args.node_id);
            if (stageAmbiguous || nodeAmbiguous) {
                const failure = stageAmbiguous
                    ? ambiguousIdFailure('node tools update', 'stage', stageId, stageAmbiguous)
                    : ambiguousIdFailure('node tools update', 'node', nodeId, nodeAmbiguous);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (!stage || !Array.isArray(stage.nodes)) {
                const actionText = `Skipped node tools update: stage "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (nodeIndex < 0) {
                const actionText = `Skipped node tools update: node "${nodeId}" not found in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (typeof stage.nodes[nodeIndex] === 'string') {
                stage.nodes[nodeIndex] = { id: nodeId, preset: nodeId, type: ORCH_NODE_TYPE_WORKER };
            }
            const node = stage.nodes[nodeIndex];
            if (!node.tools || typeof node.tools !== 'object') {
                node.tools = session.workingProfile.spec?.defaultTools && typeof session.workingProfile.spec.defaultTools === 'object'
                    ? JSON.parse(JSON.stringify(session.workingProfile.spec.defaultTools))
                    : sanitizeAgentToolFlags({});
            }
            const before = JSON.stringify(node.tools);
            const incoming = args.tools && typeof args.tools === 'object' ? args.tools : {};
            for (const [ns, verbs] of Object.entries(incoming)) {
                if (!verbs || typeof verbs !== 'object') continue;
                if (!node.tools[ns] || typeof node.tools[ns] !== 'object') {
                    node.tools[ns] = {};
                }
                for (const [verb, value] of Object.entries(verbs)) {
                    node.tools[ns][verb] = Boolean(value);
                }
            }
            session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
            // sanitizeSpec rebuilds the stages and trims their ids.
            const refreshedStage = (session.workingProfile.spec.stages || []).find(s => String(s?.id || '') === stageId.trim());
            const refreshedNode = refreshedStage?.nodes?.find(n => String(n?.id || '') === nodeId.trim());
            const after = JSON.stringify(refreshedNode?.tools || {});
            const profileChanged = before !== after;
            const actionText = profileChanged
                ? `Node "${nodeId}" tools override updated in stage "${stageId}".`
                : `Node "${nodeId}" tools patch produced no changes.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: profileChanged, action: actionText, tools: refreshedNode?.tools });
            return profileChanged;
        }
        if (name === 'luker_orch_clear_spec_node_tools') {
            const { stage, stageId, ambiguous: stageAmbiguous } = resolveIterationStage(session, args.stage_id, false);
            const { index: nodeIndex, nodeId, ambiguous: nodeAmbiguous } = resolveIterationNode(stage, args.node_id);
            if (stageAmbiguous || nodeAmbiguous) {
                const failure = stageAmbiguous
                    ? ambiguousIdFailure('node tools clear', 'stage', stageId, stageAmbiguous)
                    : ambiguousIdFailure('node tools clear', 'node', nodeId, nodeAmbiguous);
                actions.push(failure.action);
                pushToolResult({ ...failure, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (!stage || !Array.isArray(stage.nodes)) {
                const actionText = `Skipped node tools clear: stage "${stageId}" not found.`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
                return false;
            }
            const node = nodeIndex >= 0 ? stage.nodes[nodeIndex] : null;
            if (!node) {
                const actionText = `Skipped node tools clear: node "${nodeId}" not found in stage "${stageId}".`;
                actions.push(actionText);
                pushToolResult({ ok: false, error: 'not_found', action: actionText, stage_id: stageId, node_id: nodeId });
                return false;
            }
            if (typeof node === 'string') {
                const actionText = `Node "${nodeId}" tools already inheriting default.`;
                actions.push(actionText);
                pushToolResult({ ok: true, changed: false, action: actionText });
                return false;
            }
            const hadOverride = node.tools && typeof node.tools === 'object';
            node.tools = null;
            session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
            const actionText = hadOverride
                ? `Node "${nodeId}" tools cleared in stage "${stageId}" (now inherits default).`
                : `Node "${nodeId}" tools already inheriting default.`;
            actions.push(actionText);
            pushToolResult({ ok: true, changed: hadOverride, action: actionText });
            return Boolean(hadOverride);
        }
        throw new Error(`spec structure tools: unknown_tool — ${name}`);
    }

    function finalize() {
        let changed = false;
        for (const [presetId, actionIndexes] of pendingPresetRemovalActions.entries()) {
            const presetExists = Boolean(session?.workingProfile?.presets?.[presetId]);
            const inUse = isPresetReferencedInSpec(session?.workingProfile?.spec, presetId, session?.workingProfile?.presets);
            let message = '';
            if (!presetExists) {
                message = `Skipped preset removal: "${presetId}" not found.`;
            } else if (inUse) {
                message = `Skipped preset removal: "${presetId}" is still used by nodes.`;
            } else {
                delete session.workingProfile.presets[presetId];
                message = `Preset "${presetId}" removed.`;
                changed = true;
            }
            for (const actionIndex of actionIndexes) {
                if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                    actions[actionIndex] = message;
                    if (toolResults[actionIndex]) {
                        toolResults[actionIndex].content = serializeToolResultContent({
                            ok: !message.startsWith('Skipped'),
                            action: message,
                            ...(message.startsWith('Skipped') ? { error: message } : { changed: true }),
                            preset_id: presetId,
                        });
                    }
                }
            }
        }
        return changed;
    }

    return { execute, finalize };
}
