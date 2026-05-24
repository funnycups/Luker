/**
 * Capsule injection helpers for the orchestrator.
 *
 * The "capsule" is the final orchestration guidance text that gets
 * injected into the next generation pass. This module owns the
 * settings → injection-position translation, the actual payload-mutation
 * call (`injectCapsuleToPayload`), and the inverse `clearCapsulePrompt`
 * cleanup hook.
 *
 *   - `normalizeCapsuleInjectPosition` clamps a stored numeric position
 *     to one of the world-info positions actually supported by this
 *     extension (`SUPPORTED_WORLD_INFO_POSITIONS`).
 *   - `normalizeCapsuleInjectRole` clamps a stored numeric role to one
 *     of the three legal `extension_prompt_roles` values.
 *   - `migrateLegacyCapsuleInjectPosition` converts the v1 schema
 *     (which stored the SillyTavern `extension_prompt_types` enum) into
 *     the current v2 schema's `world_info_position` enum. v1 settings
 *     bumped to v2 by `ensureSettings` rely on this for the migration.
 *   - `injectCapsuleToPayload` is the runtime mutator: it reads the
 *     user's preferred position from `settings`, then funnels through
 *     the `appendUnique*` helpers from `world-info.js` (with depth +
 *     role bookkeeping for the `atDepth` branch).
 *   - `clearCapsulePrompt` is the inverse used when the orchestrator is
 *     bypassed (cancellation, early abort) so a stale capsule from a
 *     previous turn never leaks into the next request.
 *   - `getTargetAssistantLayer` infers the assistant turn that the
 *     anchor capsule will land on for a given generation type.
 *
 * `buildCapsule` (synthesizes the final guidance text from
 * `stageOutputs`) and `reapplyLatestCapsuleInjection` (re-syncs the
 * cached capsule after an edit) live in main.js because they read
 * `latestOrchestrationSnapshot` / `getChatKey` /
 * `persistEditedSnapshotToFloorState` — module-level state that the
 * orchestrator owns at the main.js level.
 */

import { extension_prompt_roles, extension_prompt_types } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { wi_anchor_position, world_info_position } from '../../world-info.js';
import { SUPPORTED_WORLD_INFO_POSITIONS } from './defaults.js';
import {
    appendUniqueNoteEntry,
    appendUniqueWorldInfoBlock,
    appendUniqueWorldInfoExample,
} from './world-info.js';

const MODULE_NAME = 'orchestrator';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';

export function normalizeCapsuleInjectPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : world_info_position.atDepth;
}

export function normalizeCapsuleInjectRole(value) {
    const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
    const numeric = Number(value);
    return allowedRoles.includes(numeric) ? numeric : extension_prompt_roles.SYSTEM;
}

export function migrateLegacyCapsuleInjectPosition(value) {
    switch (Number(value)) {
        case extension_prompt_types.BEFORE_PROMPT:
            return world_info_position.before;
        case extension_prompt_types.IN_PROMPT:
            return world_info_position.after;
        case extension_prompt_types.IN_CHAT:
            return world_info_position.atDepth;
        default:
            return world_info_position.atDepth;
    }
}

export function injectCapsuleToPayload(payload, text, settings = extension_settings[MODULE_NAME]) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const packet = String(text || '').trim();
    if (!packet) {
        return false;
    }
    const position = normalizeCapsuleInjectPosition(settings?.capsuleInjectPosition);
    if (position === world_info_position.before) {
        return appendUniqueWorldInfoBlock(payload, 'worldInfoBefore', packet);
    }
    if (position === world_info_position.after) {
        return appendUniqueWorldInfoBlock(payload, 'worldInfoAfter', packet);
    }
    if (position === world_info_position.ANTop) {
        if (!Array.isArray(payload.anBefore)) {
            payload.anBefore = [];
        }
        return appendUniqueNoteEntry(payload.anBefore, packet);
    }
    if (position === world_info_position.ANBottom) {
        if (!Array.isArray(payload.anAfter)) {
            payload.anAfter = [];
        }
        return appendUniqueNoteEntry(payload.anAfter, packet);
    }
    if (position === world_info_position.EMTop) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.before, packet);
    }
    if (position === world_info_position.EMBottom) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.after, packet);
    }
    const depth = Math.max(0, Math.min(10000, Math.floor(Number(settings?.capsuleInjectDepth) || 0)));
    const role = normalizeCapsuleInjectRole(settings?.capsuleInjectRole);
    if (!Array.isArray(payload.worldInfoDepth)) {
        payload.worldInfoDepth = [];
    }
    let target = payload.worldInfoDepth.find((entry) => (
        Math.max(0, Math.floor(Number(entry?.depth) || 0)) === depth
        && normalizeCapsuleInjectRole(entry?.role) === role
    ));
    if (!target) {
        target = { depth, role, entries: [] };
        payload.worldInfoDepth.push(target);
    } else if (!Array.isArray(target.entries)) {
        target.entries = [];
    }
    target.role = role;
    if (target.entries.includes(packet)) {
        return false;
    }
    target.entries.push(packet);
    return true;
}

export function clearCapsulePrompt(context) {
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        '',
        extension_prompt_types.NONE,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

export function getTargetAssistantLayer(payload) {
    const type = String(payload?.type || 'normal').trim().toLowerCase();
    const messages = Array.isArray(payload?.coreChat) ? payload.coreChat : [];
    const assistantCount = messages.filter(message => !message?.is_user).length;
    return (type === 'regenerate' || type === 'swipe' || type === 'continue')
        ? Math.max(assistantCount, 1)
        : Math.max(assistantCount + 1, 1);
}
