// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure controller for Stable Diffusion image generation tracking,
 * activity-guard leases, abort forwarding, and swipe generation orchestration.
 */
export function createSdGenerationTracker({
    getContext,
    getEventSource,
    getEventTypes,
    t,
    getActiveGenerations,
    setActiveGenerations,
    generationAbortControllers,
    trackedGenerationControllers,
    getSettings,
    transientSessionHeaders,
    resolveSdConnectionBinding,
    getPrompt,
    sendGenerationRequest,
    refinePrompt,
    setTypeSpecificDimensions,
    restoreOriginalDimensions,
    beginImageActivityJob,
    isVideo,
    getGenerationMode,
    getInitiators,
    MEDIA_TYPE,
    MEDIA_SOURCE,
    getDocument = () => globalThis.document,
    getJQuery = () => globalThis.$,
    getToastr = () => globalThis.toastr,
}) {
    /** @type {WeakMap<AbortController, () => void>} */
    const controllerActivityLeases = new WeakMap();
    /** @type {Array<() => void>} */
    const untrackedActivityLeases = [];

    function syncGenerationTrackingState() {
        const activeControllers = new Set();
        for (const controller of generationAbortControllers) {
            if (controller instanceof AbortController && !controller.signal.aborted) {
                activeControllers.add(controller);
            }
        }

        const prevActive = getActiveGenerations();
        const nextActive = activeControllers.size;
        setActiveGenerations(nextActive);
        console.debug(`SD: syncGenerationTrackingState, controllers=${generationAbortControllers.length}, activeGenerations: ${prevActive} → ${nextActive}`);
    }

    function acquireGenerationActivityLease(controller, { scope = 'chat', label = t`Image generation`, skipActivityLease = false } = {}) {
        if (skipActivityLease) {
            return;
        }
        const acquire = getContext()?.activityGuard?.acquire;
        if (typeof acquire !== 'function') {
            return;
        }
        const leaseOptions = {
            source: 'sd:image',
            label,
            scope,
        };
        if (scope === 'chat' && controller instanceof AbortController) {
            leaseOptions.onCancel = () => {
                if (!controller.signal.aborted) {
                    controller.abort('Aborted by user');
                }
            };
        }
        const release = acquire(leaseOptions);
        if (typeof release !== 'function') {
            return;
        }
        if (controller instanceof AbortController) {
            const previous = controllerActivityLeases.get(controller);
            if (typeof previous === 'function') {
                previous();
            }
            controllerActivityLeases.set(controller, release);
        } else {
            untrackedActivityLeases.push(release);
        }
    }

    function releaseGenerationActivityLease(controller) {
        if (controller instanceof AbortController) {
            const release = controllerActivityLeases.get(controller);
            if (release) {
                controllerActivityLeases.delete(controller);
                release();
            }
            return;
        }
        if (controller === null || controller === undefined) {
            const release = untrackedActivityLeases.pop();
            if (typeof release === 'function') {
                release();
            }
        }
    }

    function startGenerationTracking(controller = null, { scope = 'chat', label = t`Image generation`, skipActivityLease = false } = {}) {
        let added = false;
        if (controller instanceof AbortController) {
            const before = trackedGenerationControllers.size;
            trackedGenerationControllers.add(controller);
            added = trackedGenerationControllers.size > before;
        } else {
            added = true;
        }
        if (added) {
            acquireGenerationActivityLease(controller, { scope, label, skipActivityLease });
        }
        syncGenerationTrackingState();
        if (added) getEventSource().emit(getEventTypes().IMAGE_GENERATION_STARTED);
    }

    function endGenerationTracking(controller = null) {
        let removed = false;
        if (controller instanceof AbortController) {
            removed = trackedGenerationControllers.delete(controller);
        } else {
            removed = true;
        }
        releaseGenerationActivityLease(controller);
        syncGenerationTrackingState();
        if (removed) getEventSource().emit(getEventTypes().IMAGE_GENERATION_ENDED);
    }

    function endGenerationTrackingEarly(controller) {
        if (!(controller instanceof AbortController) || !trackedGenerationControllers.has(controller)) {
            console.debug('SD: endGenerationTrackingEarly skipped, controller not tracked or invalid');
            return;
        }
        console.debug('SD: endGenerationTrackingEarly called (abort event listener)');
        releaseGenerationActivityLease(controller);
        syncGenerationTrackingState();
    }

    function registerAbortController(controller) {
        if (!(controller instanceof AbortController)) {
            return;
        }
        generationAbortControllers.push(controller);
    }

    function unregisterAbortController(controller) {
        const index = generationAbortControllers.lastIndexOf(controller);
        if (index !== -1) {
            generationAbortControllers.splice(index, 1);
        }
    }

    async function generateBridgeImage(prompt, {
        characterName = '',
        negativePrompt = '',
        aspectRatio = undefined,
        width = undefined,
        height = undefined,
        seed = undefined,
        references = undefined,
        characterPrompts = undefined,
        attribution = 'active_chat',
        subdir = undefined,
        transientSessionId = undefined,
        skipActivityTracking = false,
        skipActivityLease = false,
        onRetry = undefined,
        signal = undefined,
        loras = [],
    } = {}) {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(signal?.reason);
        if (signal?.aborted) {
            forwardAbort();
        } else {
            signal?.addEventListener('abort', forwardAbort, { once: true });
        }
        if (controller.signal.aborted) {
            signal?.removeEventListener('abort', forwardAbort);
            const error = new Error('Image generation aborted.');
            error.name = 'AbortError';
            throw error;
        }

        transientSessionHeaders(transientSessionId);
        const trackActivity = !skipActivityTracking && transientSessionId === undefined;
        let capturedError = null;
        if (trackActivity) {
            const scope = attribution === 'none' ? 'global' : 'chat';
            registerAbortController(controller);
            startGenerationTracking(controller, { scope, skipActivityLease: Boolean(skipActivityLease) });
        }
        try {
            const generationMode = getGenerationMode();
            const initiators = getInitiators();
            const preparedPrompt = await getPrompt(generationMode.FREE, prompt, prompt, '', null);
            const imagePath = await sendGenerationRequest(
                generationMode.FREE,
                preparedPrompt,
                negativePrompt || '',
                characterName,
                async () => {},
                initiators.tool,
                controller.signal,
                error => { capturedError = error; },
                null,
                loras,
                {
                    aspectRatio,
                    width,
                    height,
                    seed,
                    references,
                    characterPrompts,
                    attribution,
                    subdir,
                    transientSessionId,
                    onRetry,
                },
            );
            if (capturedError) {
                throw capturedError;
            }
            if (controller.signal.aborted) {
                const error = new Error('Image generation aborted.');
                error.name = 'AbortError';
                throw error;
            }
            if (!imagePath) {
                throw new Error('Image generation returned no file path.');
            }
            return imagePath;
        } finally {
            signal?.removeEventListener('abort', forwardAbort);
            if (trackActivity) {
                unregisterAbortController(controller);
                endGenerationTracking(controller);
            }
        }
    }

    async function generateServiceImage(req = {}) {
        transientSessionHeaders(req.transientSessionId);
        try {
            resolveSdConnectionBinding(getSettings(), getContext());
        } catch (error) {
            getToastr()?.error(String(error?.message || error), t`Image Generation`);
            throw error;
        }

        const prompt = String(req.prompt || '').trim();
        const negativePrompt = String(req.negativePrompt || '');
        const loras = Array.isArray(req.loras) ? req.loras : [];
        const context = getContext();
        const defaultCharName = req.attribution === 'none'
            ? ''
            : (context.groupId
                ? context.groups?.find?.(g => g.id === context.groupId)?.id?.toString() || ''
                : context.characters?.[context.characterId]?.name || '');
        const characterName = req.characterName !== undefined ? String(req.characterName || '') : defaultCharName;

        const controller = new AbortController();
        const forwardAbort = () => controller.abort(req.signal?.reason);
        if (req.signal?.aborted) {
            forwardAbort();
        } else {
            req.signal?.addEventListener('abort', forwardAbort, { once: true });
        }
        if (controller.signal.aborted) {
            req.signal?.removeEventListener('abort', forwardAbort);
            const error = new Error('Image generation aborted.');
            error.name = 'AbortError';
            throw error;
        }

        let capturedError = null;
        let capturedMeta = { format: 'png', prefixedPrompt: prompt };
        const trackActivity = !req.skipActivityTracking && req.transientSessionId === undefined;
        if (trackActivity) {
            const scope = req.attribution === 'none' ? 'global' : 'chat';
            registerAbortController(controller);
            startGenerationTracking(controller, { scope, skipActivityLease: Boolean(req.skipActivityLease) });
        }
        try {
            const generationMode = getGenerationMode();
            const initiators = getInitiators();
            const preparedPrompt = req.skipPromptPrefix
                ? prompt
                : await getPrompt(generationMode.FREE, prompt, prompt, '', null);
            const imagePath = await sendGenerationRequest(
                generationMode.FREE,
                preparedPrompt,
                negativePrompt,
                characterName,
                async (_p, _img, _gt, _neg, _init, prefixedPrompt, format) => {
                    capturedMeta = { format: format || 'png', prefixedPrompt };
                },
                initiators.tool,
                controller.signal,
                error => { capturedError = error; },
                null,
                loras,
                {
                    aspectRatio: req.aspectRatio,
                    width: req.width,
                    height: req.height,
                    seed: req.seed,
                    references: req.references,
                    characterPrompts: req.characterPrompts,
                    attribution: req.attribution ?? 'active_chat',
                    subdir: req.subdir,
                    transientSessionId: req.transientSessionId,
                    includePresetStyleReferences: req.includePresetStyleReferences,
                },
            );
            if (capturedError) {
                throw capturedError;
            }
            if (controller.signal.aborted) {
                const error = new Error('Image generation aborted.');
                error.name = 'AbortError';
                throw error;
            }
            if (!imagePath) {
                throw new Error('Image generation returned no file path.');
            }
            return {
                imagePath,
                format: capturedMeta.format,
                prompt: capturedMeta.prefixedPrompt,
                negativePrompt,
            };
        } finally {
            req.signal?.removeEventListener('abort', forwardAbort);
            if (trackActivity) {
                unregisterAbortController(controller);
                endGenerationTracking(controller);
            }
        }
    }

    async function generateMediaSwipe(mediaAttachment, message, onStart, onComplete, abortController = new AbortController()) {
        const doc = getDocument();
        const $ = getJQuery();
        const sdSettings = getSettings();
        const generationMode = getGenerationMode();
        const initiators = getInitiators();
        const stopButton = doc?.getElementById?.('sd_stop_gen') ?? null;
        const generationType = mediaAttachment.generation_type ?? message?.extra?.generationType ?? generationMode.FREE;
        let dimensions = { width: sdSettings.width, height: sdSettings.height };
        sdSettings.original_seed = sdSettings.seed;
        sdSettings.seed = sdSettings.seed >= 0 ? Math.round(Math.random() * (Math.pow(2, 32) - 1)) : -1;

        const result = {
            url: '',
            type: MEDIA_TYPE.IMAGE,
            source: MEDIA_SOURCE.GENERATED,
        };

        const activityJob = beginImageActivityJob({
            kind: 'generation',
            abort: () => {
                if (!abortController.signal.aborted) abortController.abort('Aborted by user');
            },
        });

        try {
            registerAbortController(abortController);
            startGenerationTracking(abortController);
            $?.(stopButton)?.show?.();
            const callback = (_a, _b, _c, _d, _e, _f, format) => { result.type = isVideo(format) ? MEDIA_TYPE.VIDEO : MEDIA_TYPE.IMAGE; };
            const savedPrompt = mediaAttachment.title ?? message.extra.title ?? '';
            const savedNegative = mediaAttachment.negative ?? message.extra.negative ?? '';
            const refineArgs = {
                negative: savedNegative,
                resolution: mediaAttachment.width && mediaAttachment.height ? `${mediaAttachment.width}x${mediaAttachment.height}` : null,
            };
            const prompt = await refinePrompt(savedPrompt, refineArgs);
            dimensions = setTypeSpecificDimensions(generationType, refineArgs.resolution ? mediaAttachment : null);

            const context = getContext();
            const characterName = context.groupId
                ? context.groups[Object.keys(context.groups).filter(x => context.groups[x].id === context.groupId)[0]]?.id?.toString()
                : context.characters[context.characterId]?.name;

            onStart();
            result.url = await sendGenerationRequest(generationType, prompt, refineArgs.negative, characterName, callback, initiators.swipe, abortController.signal, null, activityJob);
            result.generation_type = generationType;
            result.title = prompt;
            result.negative = refineArgs.negative;
            if (refineArgs.resolution) {
                result.width = mediaAttachment.width;
                result.height = mediaAttachment.height;
            }
        } catch (error) {
            if (!abortController.signal.aborted && error?.name !== 'AbortError') {
                activityJob.setError(String(error?.message || error));
            }
            throw error;
        } finally {
            onComplete();
            $?.(stopButton)?.hide?.();
            endGenerationTracking(abortController);
            unregisterAbortController(abortController);
            restoreOriginalDimensions(dimensions);
            sdSettings.seed = sdSettings.original_seed;
            delete sdSettings.original_seed;
            if (abortController.signal.aborted) activityJob.finish('aborted');
            else if (result.url) activityJob.finish('done');
            else activityJob.finish('failed');
        }

        if (!result.url) {
            return null;
        }

        return result;
    }

    return {
        syncGenerationTrackingState,
        acquireGenerationActivityLease,
        releaseGenerationActivityLease,
        startGenerationTracking,
        endGenerationTracking,
        endGenerationTrackingEarly,
        registerAbortController,
        unregisterAbortController,
        generateBridgeImage,
        generateServiceImage,
        generateMediaSwipe,
    };
}
