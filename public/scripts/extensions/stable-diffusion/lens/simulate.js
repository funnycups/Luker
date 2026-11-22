// SPDX-License-Identifier: AGPL-3.0-or-later

import { requireStoredPrompt } from '../../../lib/prompt-values.js';
import { buildSimulationToolResult } from '../../../iteration-library/simulation-review/feedback-builder.js';
import { SourceError } from '../../../workbench/model/errors.js';
import { resolveExplorationLlm, runExplorationAgent } from '../exploration/agent.js';
import { runCharacterBuilderTurn } from '../exploration/dialog-agent.js';
import { createCharacterDraft, isStagedTempImagePath } from '../exploration/dialog-draft.js';
import { createSourcePolicy } from '../exploration/source-policy.js';
import { runIllustrationAgent } from '../illustration/agent.js';
import { captureIllustrationInput } from '../illustration/execution-context.js';
import { i18n as defaultLensI18n } from './i18n.js';
import { createSandboxProfileStore } from './simulation-sandbox.js';
import { createTempMediaTracker } from './temp-media-tracker.js';

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertOptionalString(value, fieldName) {
    if (value === undefined) return '';
    if (typeof value !== 'string') {
        throw new SourceError('invalid_args', `${fieldName} must be a string.`);
    }
    return value;
}

function assertOptionalBoolean(value, fieldName, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
        throw new SourceError('invalid_args', `${fieldName} must be a boolean.`);
    }
    return value;
}

function resolveDraftPreset(context, draftSnapshot, rawPresetId) {
    const requested = assertOptionalString(rawPresetId, 'preset_id').trim();
    const presets = Array.isArray(draftSnapshot?.presets) ? draftSnapshot.presets : [];
    const defaultId = String(
        context?.extensionSettings?.sd?.illustration?.currentPresetId
        || presets[0]?.id
        || '',
    ).trim();
    const targetId = requested || defaultId;
    if (!targetId) {
        throw new SourceError('not_found', 'No illustration preset exists in the draft.');
    }
    const found = presets.find(p => p?.id === targetId);
    if (!found) {
        throw new SourceError('not_found', `Preset not found in draft: ${targetId}`);
    }
    return clone(found);
}

function validateTargets(rawTargets) {
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
        throw new SourceError('invalid_args', 'targets must be a non-empty array when mode is "background".');
    }
    const out = [];
    for (const item of rawTargets) {
        if (typeof item === 'string') {
            if (!item.trim()) {
                throw new SourceError('invalid_args', 'Each target name must be a non-empty string.');
            }
            out.push({ name: item.trim() });
            continue;
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new SourceError('invalid_args', 'Each target must be an object with a non-empty name string.');
        }
        if (typeof item.name !== 'string' || !item.name.trim()) {
            throw new SourceError('invalid_args', 'Each target must have a non-empty name string.');
        }
        if (item.work !== undefined && typeof item.work !== 'string') {
            throw new SourceError('invalid_args', 'target.work must be a string.');
        }
        if (item.hint !== undefined && typeof item.hint !== 'string') {
            throw new SourceError('invalid_args', 'target.hint must be a string.');
        }
        out.push({
            name: item.name.trim(),
            ...(item.work ? { work: item.work.trim() } : {}),
            ...(item.hint ? { hint: item.hint.trim() } : {}),
        });
    }
    return out;
}

function validateUserTurns(rawTurns) {
    if (!Array.isArray(rawTurns) || rawTurns.length === 0) {
        throw new SourceError('invalid_args', 'user_turns must be a non-empty array of strings when mode is "dialog".');
    }
    const out = [];
    for (const item of rawTurns) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new SourceError('invalid_args', 'Each item in user_turns must be a non-empty string.');
        }
        out.push(item);
    }
    return out;
}

async function resolveSourcePolicyValidated(context, rawSource) {
    if (rawSource === undefined || rawSource === null) {
        return { kind: 'none' };
    }
    if (typeof rawSource !== 'object' || Array.isArray(rawSource)) {
        throw new SourceError('invalid_args', 'source must be an object with kind "none", "card", or "persona".');
    }
    if (rawSource.kind !== 'none' && rawSource.kind !== 'card' && rawSource.kind !== 'persona') {
        throw new SourceError('invalid_args', 'source.kind must be "none", "card", or "persona".');
    }
    if (rawSource.card_avatar !== undefined && typeof rawSource.card_avatar !== 'string') {
        throw new SourceError('invalid_args', 'source.card_avatar must be a string.');
    }
    try {
        return await createSourcePolicy(context, rawSource);
    } catch (error) {
        const msg = String(error?.message || error);
        const code = msg.includes('not_found') ? 'not_found' : 'invalid_args';
        throw new SourceError(code, msg);
    }
}

async function defaultOpenSimulationReview(args) {
    const [{ openSimulationReview }, { ensureSimulationReviewLocaleData }] = await Promise.all([
        import('../../../iteration-library/simulation-review/index.js'),
        import('../../../iteration-library/simulation-review/i18n/index.js'),
    ]);
    ensureSimulationReviewLocaleData();
    return await openSimulationReview(args);
}

function buildI18nAdapter(context, providedI18n) {
    if (typeof providedI18n === 'function') {
        return providedI18n;
    }
    return (key, fallback) => {
        const text = fallback ?? key;
        if (typeof context?.translate === 'function') {
            return context.translate(text, key);
        }
        return text;
    };
}

async function loadImagePreviews(tracker, paths) {
    const previews = {};
    const previewErrors = {};
    const unique = [...new Set((Array.isArray(paths) ? paths : []).filter(Boolean))];
    for (const imagePath of unique) {
        if (!isStagedTempImagePath(imagePath)) continue;
        try {
            const dataUrl = await tracker.preview(imagePath);
            if (dataUrl) {
                previews[imagePath] = dataUrl;
            }
        } catch (error) {
            const message = String(error?.message || error);
            previewErrors[imagePath] = message;
            console.error(`[sd/simulate] Failed to load transient preview for ${imagePath}:`, error);
        }
    }
    return { previews, previewErrors };
}

function collectProfileImagePaths(profiles) {
    const paths = [];
    for (const profile of Array.isArray(profiles) ? profiles : []) {
        for (const entry of Array.isArray(profile?.referenceImages) ? profile.referenceImages : []) {
            const imagePath = typeof entry === 'string' ? entry.trim() : String(entry?.path || '').trim();
            if (imagePath) paths.push(imagePath);
        }
    }
    return paths;
}

async function cleanupAllTrackers(trackers) {
    const errors = [];
    const settled = await Promise.allSettled(trackers.map(async tracker => {
        await tracker.waitForIdle?.();
        await tracker.cleanup();
    }));
    settled.forEach((outcome, index) => {
        if (outcome.status === 'rejected') {
            const sid = trackers[index]?.sessionId || `attempt_${index + 1}`;
            errors.push(`session ${sid}: ${String(outcome.reason?.message || outcome.reason)}`);
        }
    });
    return errors;
}

function formatCleanupFailureResult(kind, cleanupErrors, preservedToolResultText = '') {
    const detail = cleanupErrors.join('\n');
    const sections = [
        `<simulation_result kind="${kind}" ok="false">`,
        '',
        '<error reason="cleanup_failed">',
        `Temporary simulation media cleanup failed:\n${detail}`,
        '</error>',
    ];
    if (preservedToolResultText) {
        sections.push('', preservedToolResultText);
    }
    sections.push('', '</simulation_result>');
    return sections.join('\n');
}

function normalizeBackgroundTraceEvents(events) {
    const roundsMap = new Map();
    const ensureRound = (roundIndex) => {
        const key = Number(roundIndex) || 1;
        if (!roundsMap.has(key)) {
            roundsMap.set(key, {
                roundIndex: key,
                reasoning: '',
                assistantText: '',
                toolCalls: [],
                visualPreviews: [],
                preparedRequests: [],
            });
        }
        return roundsMap.get(key);
    };

    for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== 'object') continue;
        const round = ensureRound(event.roundIndex);
        if (event.type === 'model_response') {
            if (event.reasoning) round.reasoning = event.reasoning;
            if (event.assistantText) round.assistantText = event.assistantText;
        } else if (event.type === 'tool_result') {
            round.toolCalls.push({
                id: event.callId || '',
                name: event.name || '',
                args: event.args ?? {},
                result: event.result ?? null,
                isError: Boolean(event.isError),
            });
        } else if (event.type === 'visual_preview') {
            round.visualPreviews.push({
                imagePath: event.imagePath || '',
                dataUrl: event.dataUrl || '',
                error: event.error || '',
            });
        } else if (event.type === 'prepared_request') {
            round.preparedRequests.push({ roundIndex: round.roundIndex, record: event.record });
        }
    }

    return {
        rounds: [...roundsMap.values()].sort((a, b) => a.roundIndex - b.roundIndex),
    };
}

export async function simulateSdIllustration({
    context,
    live,
    args = {},
    signal = null,
    i18n = null,
    openReview = defaultOpenSimulationReview,
    createTracker = createTempMediaTracker,
} = {}) {
    if (args !== null && args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new SourceError('invalid_args', 'sd_simulate_illustration arguments must be an object.');
    }
    const safeArgs = args || {};
    const draftSnapshot = clone(live || {});
    const preset = resolveDraftPreset(context, draftSnapshot, safeArgs.preset_id);

    try {
        requireStoredPrompt(preset.illustrationPrompt, defaultLensI18n('Fill in the prompt or reset it to the default.'));
    } catch (error) {
        throw new SourceError('invalid_args', String(error?.message || error));
    }

    let messageIndex = null;
    if (safeArgs.message_index !== undefined) {
        if (typeof safeArgs.message_index !== 'number' || !Number.isInteger(safeArgs.message_index) || safeArgs.message_index < 0) {
            throw new SourceError('invalid_args', 'message_index must be a non-negative integer.');
        }
        const chatLen = Array.isArray(context?.chat) ? context.chat.length : 0;
        if (safeArgs.message_index >= chatLen) {
            throw new SourceError('invalid_args', `message_index ${safeArgs.message_index} is out of range (chat length: ${chatLen}).`);
        }
        messageIndex = safeArgs.message_index;
    }

    let sampleMessage = '';
    if (safeArgs.sample_message !== undefined) {
        if (typeof safeArgs.sample_message !== 'string' || !safeArgs.sample_message.trim()) {
            throw new SourceError('invalid_args', 'sample_message must be a non-empty string when provided.');
        }
        sampleMessage = safeArgs.sample_message;
    }

    const allowExploration = assertOptionalBoolean(safeArgs.allow_exploration, 'allow_exploration', true);
    const contextMessageCount = Number(context?.extensionSettings?.sd?.illustration?.contextMessageCount ?? 10);

    let fixedInput;
    try {
        fixedInput = await captureIllustrationInput({
            context,
            preset,
            messageIndex,
            sampleMessage,
            contextMessageCount,
            capturePromptContext: true,
        });
    } catch (error) {
        throw new SourceError('invalid_args', String(error?.message || error));
    }

    const trackers = [];
    const kind = 'sd-illustration';
    const simI18n = buildI18nAdapter(context, i18n);

    async function runAttempt() {
        const sandboxStore = createSandboxProfileStore(draftSnapshot.characters || []);
        const tracker = createTracker(context);
        trackers.push(tracker);
        await tracker.ready();

        const agentResult = await runIllustrationAgent({
            context,
            preset: clone(preset),
            input: fixedInput,
            profileStore: sandboxStore,
            media: tracker,
            abortSignal: signal,
            allowExploration,
            transientSessionId: tracker.sessionId,
            capturePreparedRequests: true,
        });

        const savedProfiles = sandboxStore.getRecordedChanges();
        const previewCandidates = [
            ...agentResult.results.map(item => item.imageUrl).filter(Boolean),
            ...collectProfileImagePaths(savedProfiles),
        ];
        const { previews: imagePreviews, previewErrors } = await loadImagePreviews(tracker, previewCandidates);

        const illustrations = agentResult.results.map((item, idx) => ({
            index: idx,
            status: item.status,
            prompt: item.prompt?.prompt || '',
            negativePrompt: item.prompt?.negativePrompt || '',
            aspectRatio: item.prompt?.aspectRatio || '',
            insertAfter: item.prompt?.insertAfter || '',
            insertBefore: item.prompt?.insertBefore || '',
            loras: Array.isArray(item.prompt?.loras) ? clone(item.prompt.loras) : [],
            characterRefs: Array.isArray(item.prompt?.characterRefs) ? clone(item.prompt.characterRefs) : [],
            references: Array.isArray(item.prompt?.references) ? clone(item.prompt.references) : [],
            imageUrl: item.imageUrl || '',
            dataUrl: item.imageUrl ? (imagePreviews[item.imageUrl] || '') : '',
            previewError: item.imageUrl ? (previewErrors[item.imageUrl] || '') : '',
            error: item.error || '',
        }));

        const payload = {
            preset: { id: preset.id, name: preset.name },
            inputSnapshot: {
                scope: fixedInput.scope,
                messageIndex: fixedInput.messageIndex,
                characterName: fixedInput.characterName,
                current: fixedInput.current,
                context: fixedInput.context,
                memoryRecall: fixedInput.memoryRecall,
                cardAvatar: fixedInput.cardAvatar,
                allowExploration,
            },
            illustrations,
            savedProfiles,
            imagePreviews,
            previewErrors,
            failure: agentResult.trace?.failure || null,
            trace: agentResult.trace,
        };

        return { payload, worldInfoHits: [] };
    }

    let reviewResultText = '';
    let executionError = null;
    let cleanupErrors = [];
    try {
        const firstAttempt = await runAttempt();
        const review = await openReview({
            kind,
            payload: firstAttempt.payload,
            worldInfoHits: firstAttempt.worldInfoHits,
            i18n: simI18n,
            abortSignal: signal,
            onRerun: async () => await runAttempt(),
        });
        reviewResultText = String(review?.toolResultText || '');
    } catch (error) {
        executionError = error;
    } finally {
        cleanupErrors = await cleanupAllTrackers(trackers);
    }

    if (cleanupErrors.length > 0) {
        const baseResult = reviewResultText || (executionError
            ? buildSimulationToolResult({
                kind,
                cancelled: false,
                error: {
                    reason: signal?.aborted ? 'aborted_by_user' : 'simulation_failed',
                    message: String(executionError?.message || executionError),
                },
            })
            : '');
        return formatCleanupFailureResult(kind, cleanupErrors, baseResult);
    }

    if (executionError) {
        return buildSimulationToolResult({
            kind,
            cancelled: false,
            error: {
                reason: signal?.aborted ? 'aborted_by_user' : 'simulation_failed',
                message: String(executionError?.message || executionError),
            },
        });
    }
    return reviewResultText;
}

export async function simulateSdExploration({
    context,
    live,
    args = {},
    signal = null,
    i18n = null,
    openReview = defaultOpenSimulationReview,
    createTracker = createTempMediaTracker,
} = {}) {
    if (args !== null && args !== undefined && (typeof args !== 'object' || Array.isArray(args))) {
        throw new SourceError('invalid_args', 'sd_simulate_exploration arguments must be an object.');
    }
    const safeArgs = args || {};
    const mode = safeArgs.mode;
    if (mode !== 'background' && mode !== 'dialog') {
        throw new SourceError('invalid_args', 'mode is required and must be "background" or "dialog".');
    }

    const draftSnapshot = clone(live || {});
    const preset = resolveDraftPreset(context, draftSnapshot, safeArgs.preset_id);

    try {
        requireStoredPrompt(preset.explorationPrompt, defaultLensI18n('Fill in the prompt or reset it to the default.'));
    } catch (error) {
        throw new SourceError('invalid_args', String(error?.message || error));
    }

    const userHint = assertOptionalString(safeArgs.user_hint, 'user_hint');
    const sourcePolicy = await resolveSourcePolicyValidated(context, safeArgs.source);

    let targets = [];
    let userTurns = [];
    let initialProfile = null;
    let initialProfileId = '';

    if (mode === 'background') {
        targets = validateTargets(safeArgs.targets);
    } else {
        userTurns = validateUserTurns(safeArgs.user_turns);
        initialProfileId = assertOptionalString(safeArgs.initial_profile_id, 'initial_profile_id').trim();
        if (initialProfileId) {
            const found = (draftSnapshot.characters || []).find(ch => ch?.id === initialProfileId);
            if (!found) {
                throw new SourceError('not_found', `Character profile not found in draft: ${initialProfileId}`);
            }
            initialProfile = clone(found);
        }
    }

    const expLlm = resolveExplorationLlm(preset);
    const promptContext = typeof context?.captureTaskPromptContext === 'function'
        ? await context.captureTaskPromptContext({
            scope: 'preset',
            apiPresetName: expLlm.apiPresetName,
            llmPresetName: expLlm.llmPresetName,
        })
        : null;

    const inputSnapshot = {
        mode,
        source: sourcePolicy.kind === 'card'
            ? { kind: 'card', card_avatar: sourcePolicy.card.avatar }
            : { kind: sourcePolicy.kind },
        ...(mode === 'background'
            ? { targets: clone(targets), userHint }
            : { userTurns: clone(userTurns), initialProfileId }),
    };

    const trackers = [];
    const kind = 'sd-exploration';
    const simI18n = buildI18nAdapter(context, i18n);

    async function runAttempt() {
        const sandboxStore = createSandboxProfileStore(draftSnapshot.characters || []);
        const tracker = createTracker(context);
        trackers.push(tracker);
        await tracker.ready();

        if (mode === 'background') {
            const traceEvents = [];
            const fetchedPaths = [];
            const expResult = await runExplorationAgent({
                context,
                profileStore: sandboxStore,
                targets: clone(targets),
                sourcePolicy,
                userHint,
                preset: clone(preset),
                media: tracker,
                promptContext,
                transientSessionId: tracker.sessionId,
                onTrace: event => {
                    traceEvents.push(event);
                    if (event?.type === 'tool_result' && event.name === 'fetch_reference_image' && event.result?.ok && event.result?.imagePath) {
                        fetchedPaths.push(event.result.imagePath);
                    }
                },
                abortSignal: signal,
            });
            const savedProfiles = sandboxStore.getRecordedChanges();
            const { previews: imagePreviews, previewErrors } = await loadImagePreviews(tracker, [
                ...fetchedPaths,
                ...collectProfileImagePaths(savedProfiles),
            ]);
            return {
                payload: {
                    mode: 'background',
                    preset: { id: preset.id, name: preset.name },
                    inputSnapshot: clone(inputSnapshot),
                    savedProfiles,
                    finalText: expResult.finalText || '',
                    trace: normalizeBackgroundTraceEvents(traceEvents),
                    imagePreviews,
                    previewErrors,
                },
                worldInfoHits: [],
            };
        }

        // Dialog mode: replay real multi-turn conversation using runCharacterBuilderTurn.
        const draft = createCharacterDraft(initialProfile ? clone(initialProfile) : null);
        let conversationMessages = [];
        const turns = [];
        const previewCandidates = [];

        for (let idx = 0; idx < userTurns.length; idx += 1) {
            const userText = userTurns[idx];
            const nextMessages = [...conversationMessages, { role: 'user', content: userText }];
            const turnResult = await runCharacterBuilderTurn({
                context,
                preset: clone(preset),
                messages: nextMessages,
                draft,
                sourcePolicy,
                profileStore: sandboxStore,
                media: tracker,
                promptContext,
                transientSessionId: tracker.sessionId,
                abortSignal: signal,
            });
            conversationMessages = turnResult.messages;
            for (const gen of turnResult.trace?.generatedImages || []) {
                if (gen?.imagePath) previewCandidates.push(gen.imagePath);
            }
            for (const fetched of turnResult.trace?.fetchedImages || []) {
                if (fetched?.imagePath) previewCandidates.push(fetched.imagePath);
            }
            turns.push({
                turnIndex: idx + 1,
                userText,
                assistantText: turnResult.finalText || '',
                trace: turnResult.trace,
                draftAfter: draft.getSnapshot(),
                conflictsAfter: draft.getConflicts(),
            });
        }

        const finalDraft = draft.getSnapshot();
        previewCandidates.push(...collectProfileImagePaths([finalDraft]));
        const { previews: imagePreviews, previewErrors } = await loadImagePreviews(tracker, previewCandidates);

        return {
            payload: {
                mode: 'dialog',
                preset: { id: preset.id, name: preset.name },
                inputSnapshot: clone(inputSnapshot),
                turns,
                finalDraft,
                conflicts: draft.getConflicts(),
                imagePreviews,
                previewErrors,
            },
            worldInfoHits: [],
        };
    }

    let reviewResultText = '';
    let executionError = null;
    let cleanupErrors = [];
    try {
        const firstAttempt = await runAttempt();
        const review = await openReview({
            kind,
            payload: firstAttempt.payload,
            worldInfoHits: firstAttempt.worldInfoHits,
            i18n: simI18n,
            abortSignal: signal,
            onRerun: async () => await runAttempt(),
        });
        reviewResultText = String(review?.toolResultText || '');
    } catch (error) {
        executionError = error;
    } finally {
        cleanupErrors = await cleanupAllTrackers(trackers);
    }

    if (cleanupErrors.length > 0) {
        const baseResult = reviewResultText || (executionError
            ? buildSimulationToolResult({
                kind,
                cancelled: false,
                error: {
                    reason: signal?.aborted ? 'aborted_by_user' : 'simulation_failed',
                    message: String(executionError?.message || executionError),
                },
            })
            : '');
        return formatCleanupFailureResult(kind, cleanupErrors, baseResult);
    }

    if (executionError) {
        return buildSimulationToolResult({
            kind,
            cancelled: false,
            error: {
                reason: signal?.aborted ? 'aborted_by_user' : 'simulation_failed',
                message: String(executionError?.message || executionError),
            },
        });
    }
    return reviewResultText;
}
