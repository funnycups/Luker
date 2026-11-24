// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure live behavioral summary models for AI Illustration (Main + Character
// Profile Agent) and Image Generation Top-Level Mode. No DOM dependencies.

function defaultTranslate(text) {
    const fn = globalThis.Luker?.getContext?.()?.translate;
    return typeof fn === 'function' ? fn(String(text ?? '')) : String(text ?? '');
}

function clampInt(raw, min, max, fallback) {
    const isBlank = raw === '' || raw === null || raw === undefined
        || (typeof raw === 'string' && raw.trim() === '');
    const parsed = isBlank ? NaN : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function resolveConflictReason(conflict, translate) {
    if (!conflict) {
        return '';
    }
    const code = typeof conflict === 'object' ? String(conflict.code || '').trim() : '';
    switch (code) {
        case 'comfy_workflow_invalid':
            return translate('Current ComfyUI workflow JSON could not be parsed to inspect %ref_image% reference nodes, so requests with reference images or img2img will fail.');
        case 'comfy_missing_ref_slots':
            return translate('Current ComfyUI workflow does not contain any %ref_image% LoadImage nodes, so requests with reference images or img2img will fail.');
        case 'comfy_runpod_no_references':
            return translate('RunPod Serverless mode does not support uploading reference images. Disable reference images and img2img, or switch character reference mode to text-only.');
        case 'shared_slots_exhausted_by_style':
            return translate('Enabled style references occupy all available reference slots, leaving no room for character reference images or img2img.');
        case 'backend_no_image_input':
            return translate('The selected image backend does not support image inputs. Switch character reference mode to text-only or disable reference images and img2img.');
        case 'webui_source_only':
            return translate('The selected WebUI backend only supports source image editing (img2img) and does not support character or style reference images.');
        case 'novel_char_ref_requires_v45':
            return translate('NovelAI character reference images require a V4.5 model. Switch to a V4.5 model or use text-only character descriptions.');
        case 'google_model_no_image_input':
            return translate('The selected Google model uses :predict or video generation and does not support reference images or img2img.');
        case 'openai_model_no_image_input':
            return translate('The selected OpenAI model does not support image edits or reference image inputs.');
        default: {
            const rawMsg = typeof conflict === 'string'
                ? conflict.trim()
                : String(conflict.message || '').trim();
            return rawMsg || translate('Character reference images are incompatible with the active image backend or workflow.');
        }
    }
}

/**
 * 5A Card 1: AI Illustration Trigger, Model, Queue & Display summary.
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildIllustrationMainSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const enabled = Boolean(state.enabled);
    const autoGenerate = Boolean(state.autoGenerate);
    const presetName = String(state.presetName || '').trim();
    const hasPreset = state.hasPreset !== undefined
        ? Boolean(state.hasPreset)
        : Boolean(presetName || String(state.presetId || '').trim());
    const apiPresetName = String(state.apiPresetName || '').trim();
    const llmPresetName = String(state.llmPresetName || '').trim();
    const contextMessageCount = clampInt(state.contextMessageCount, 0, 50, 10);
    const maxConcurrentGenerations = clampInt(state.maxConcurrentGenerations, 1, 5, 1);
    const minGenerationInterval = clampInt(state.minGenerationInterval, 0, 10000, 0);
    const imageDisplayWidth = clampInt(state.imageDisplayWidth, 10, 100, 100);
    const conflict = state.characterImageConflict || null;

    const presetToken = hasPreset
        ? { field: 'preset', text: presetName || translate('(Unnamed preset)'), tone: 'active' }
        : { field: 'preset', text: translate('no preset selected'), tone: 'danger' };
    const apiToken = {
        field: 'apiPresetName',
        text: apiPresetName || translate('(Current API config)'),
        tone: 'active',
    };
    const llmToken = {
        field: 'llmPresetName',
        text: llmPresetName || translate('(Current preset)'),
        tone: 'active',
    };

    let triggerRow;
    if (!enabled) {
        triggerRow = hasPreset
            ? {
                role: translate('Trigger'),
                tone: 'off',
                template: translate('${enabled} — chat auto/manual illustration and prompt tag stripping are inactive. Workbench Studio still uses ${preset} via ${apiPresetName} + ${llmPresetName} and the queue below.'),
                tokens: {
                    enabled: {
                        field: 'enabled',
                        text: translate('AI illustration off'),
                        tone: 'off',
                    },
                    preset: presetToken,
                    apiPresetName: apiToken,
                    llmPresetName: llmToken,
                },
            }
            : {
                role: translate('Trigger'),
                tone: 'off',
                template: translate('${enabled} — chat auto/manual illustration and prompt tag stripping are inactive. Workbench Studio still uses ${preset} and the queue below.'),
                tokens: {
                    enabled: {
                        field: 'enabled',
                        text: translate('AI illustration off'),
                        tone: 'off',
                    },
                    preset: presetToken,
                },
            };
    } else {
        const hasContext = contextMessageCount > 0;
        triggerRow = {
            role: translate('Trigger'),
            template: hasContext
                ? translate('${autoGenerate} using ${preset} (${apiPresetName} + ${llmPresetName}), reading ${contextMessageCount} preceding messages.')
                : translate('${autoGenerate} using ${preset} (${apiPresetName} + ${llmPresetName}), reading ${contextMessageCount} preceding chat context.'),
            tokens: {
                autoGenerate: {
                    field: 'autoGenerate',
                    text: autoGenerate
                        ? translate('Auto-illustrates every new assistant reply')
                        : translate('Manual illustration only'),
                    tone: autoGenerate ? 'active' : 'off',
                },
                preset: presetToken,
                apiPresetName: apiToken,
                llmPresetName: llmToken,
                contextMessageCount: {
                    field: 'contextMessageCount',
                    text: hasContext ? String(contextMessageCount) : translate('none'),
                    tone: hasContext ? 'active' : 'off',
                },
            },
        };
    }

    const queueRow = {
        role: translate('Queue & display'),
        template: translate('Up to ${maxConcurrentGenerations} concurrent image requests spaced by at least ${minGenerationInterval} ms — newly generated images render at ${imageDisplayWidth} width.'),
        tokens: {
            maxConcurrentGenerations: {
                field: 'maxConcurrentGenerations',
                text: String(maxConcurrentGenerations),
                tone: 'active',
            },
            minGenerationInterval: {
                field: 'minGenerationInterval',
                text: String(minGenerationInterval),
                tone: minGenerationInterval > 0 ? 'active' : 'off',
            },
            imageDisplayWidth: {
                field: 'imageDisplayWidth',
                text: `${imageDisplayWidth}%`,
                tone: 'active',
            },
        },
    };

    const warnings = [];
    if (!hasPreset) {
        warnings.push({
            severity: 'danger',
            template: translate('No ${preset} is selected — chat illustration and Workbench Studio cannot generate prompts until a preset exists.'),
            tokens: {
                preset: {
                    field: 'preset',
                    text: translate('prompt preset'),
                    tone: 'danger',
                },
            },
        });
    }
    if (conflict) {
        warnings.push({
            severity: 'danger',
            template: translate('Character reference image conflict — ${conflictReason}'),
            tokens: {
                conflictReason: {
                    field: null,
                    text: resolveConflictReason(conflict, translate),
                    tone: 'danger',
                },
            },
        });
    }

    const hasDanger = warnings.some((w) => w.severity === 'danger');
    let tone = 'active';
    if (hasDanger) {
        tone = 'danger';
    } else if (!enabled) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [triggerRow, queueRow],
        warnings,
        dormantFields: enabled ? [] : ['autoGenerate'],
    };
}

/**
 * 5A Card 2: Character Profile Agent summary (cross-drawer character reference
 * gating, paired-inheritance rule honesty, and visual inspection model requirement).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildIllustrationProfileAgentSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const characterReferenceEnabled = Boolean(state.characterReferenceEnabled);
    const onActivate = typeof state.onCharacterReferenceActivate === 'function'
        ? state.onCharacterReferenceActivate
        : null;
    const canActivate = Boolean(state.canActivateCharacterReference || onActivate);

    const expApi = String(state.explorationApiPreset || '').trim();
    const expLlm = String(state.explorationLlmPreset || '').trim();
    const illApi = String(state.illustrationApiPreset || '').trim();
    const illLlm = String(state.illustrationLlmPreset || '').trim();
    const visualInspection = Boolean(state.visualInspection);

    const charRefField = canActivate ? 'characterReferenceEnabled' : null;
    const charRefToken = characterReferenceEnabled
        ? {
            field: charRefField,
            text: translate('Character references are enabled'),
            tone: 'active',
            ...(onActivate ? { onActivate } : {}),
        }
        : {
            field: charRefField,
            text: translate('Character references are off'),
            tone: 'off',
            ...(onActivate ? { onActivate } : {}),
        };

    const chatTriggerRow = characterReferenceEnabled
        ? {
            role: translate('Chat trigger'),
            template: translate('Active during chat illustration when ${characterReferenceEnabled} in Image Generation settings — also runnable manually in Workbench.'),
            tokens: {
                characterReferenceEnabled: charRefToken,
            },
        }
        : {
            role: translate('Chat trigger'),
            tone: 'off',
            template: translate('Skipped during chat illustration while ${characterReferenceEnabled} in Image Generation settings. Still runnable manually in Workbench.'),
            tokens: {
                characterReferenceEnabled: charRefToken,
            },
        };

    const visualToken = visualInspection
        ? {
            field: 'visualInspection',
            text: translate('Visual inspection on — requires a vision-capable model'),
            tone: 'active',
        }
        : {
            field: 'visualInspection',
            text: translate('Visual inspection off — text-only profile research'),
            tone: 'off',
        };

    const inheritedPair = !expApi && !expLlm;
    const apiOnlySet = Boolean(expApi) && !expLlm;
    const llmOnlySet = !expApi && Boolean(expLlm);

    let modelRow;
    const warnings = [];

    if (inheritedPair) {
        modelRow = {
            role: translate('Model & vision'),
            template: translate('Inherits illustration preset pair (${explorationApiPreset} + ${explorationLlmPreset}). ${visualInspection}.'),
            tokens: {
                explorationApiPreset: {
                    field: 'explorationApiPreset',
                    text: illApi || translate('(Current API config)'),
                    tone: 'active',
                },
                explorationLlmPreset: {
                    field: 'explorationLlmPreset',
                    text: illLlm || translate('(Current preset)'),
                    tone: 'active',
                },
                visualInspection: visualToken,
            },
        };
    } else if (apiOnlySet) {
        modelRow = {
            role: translate('Model & vision'),
            template: translate('Uses ${explorationApiPreset} + ${explorationLlmPreset} — only connection is set, so completion preset falls back to Luker current global preset instead of inheriting illustration preset. ${visualInspection}.'),
            tokens: {
                explorationApiPreset: {
                    field: 'explorationApiPreset',
                    text: expApi,
                    tone: 'active',
                },
                explorationLlmPreset: {
                    field: 'explorationLlmPreset',
                    text: translate('(Current preset)'),
                    tone: 'warn',
                },
                visualInspection: visualToken,
            },
        };
        warnings.push({
            severity: 'warn',
            template: translate('Pair inheritance only triggers when both exploration dropdowns are empty — ${explorationLlmPreset} falls back to Luker current global preset rather than the illustration preset.'),
            tokens: {
                explorationLlmPreset: {
                    field: 'explorationLlmPreset',
                    text: translate('Character profile agent completion preset'),
                    tone: 'warn',
                },
            },
        });
    } else if (llmOnlySet) {
        modelRow = {
            role: translate('Model & vision'),
            template: translate('Uses ${explorationApiPreset} + ${explorationLlmPreset} — only completion preset is set, so connection falls back to Luker current global API config instead of inheriting illustration preset. ${visualInspection}.'),
            tokens: {
                explorationApiPreset: {
                    field: 'explorationApiPreset',
                    text: translate('(Current API config)'),
                    tone: 'warn',
                },
                explorationLlmPreset: {
                    field: 'explorationLlmPreset',
                    text: expLlm,
                    tone: 'active',
                },
                visualInspection: visualToken,
            },
        };
        warnings.push({
            severity: 'warn',
            template: translate('Pair inheritance only triggers when both exploration dropdowns are empty — ${explorationApiPreset} falls back to Luker current global API config rather than the illustration preset.'),
            tokens: {
                explorationApiPreset: {
                    field: 'explorationApiPreset',
                    text: translate('Character profile agent connection'),
                    tone: 'warn',
                },
            },
        });
    } else {
        modelRow = {
            role: translate('Model & vision'),
            template: translate('Uses ${explorationApiPreset} + ${explorationLlmPreset}. ${visualInspection}.'),
            tokens: {
                explorationApiPreset: {
                    field: 'explorationApiPreset',
                    text: expApi,
                    tone: 'active',
                },
                explorationLlmPreset: {
                    field: 'explorationLlmPreset',
                    text: expLlm,
                    tone: 'active',
                },
                visualInspection: visualToken,
            },
        };
    }

    const hasWarn = warnings.length > 0;
    let tone = 'active';
    if (hasWarn) {
        tone = 'warn';
    } else if (!characterReferenceEnabled) {
        tone = 'dormant';
    }

    return {
        tone,
        rows: [chatTriggerRow, modelRow],
        warnings,
        dormantFields: [],
    };
}

/**
 * 5B: Image Generation Top-Level Mode summary (trigger suppression, 5 prompt/ratio
 * switches, and explicit AI Illustration independence).
 *
 * @param {object} [state]
 * @returns {object} SummaryModel
 */
export function buildSdModeSummary(state = {}) {
    const translate = typeof state.translate === 'function' ? state.translate : defaultTranslate;
    const functionTool = Boolean(state.functionTool);
    const interactiveMode = Boolean(state.interactiveMode);
    const toolCallingSupported = Boolean(state.toolCallingSupported);
    const refineMode = Boolean(state.refineMode);
    const freeExtend = Boolean(state.freeExtend);
    const minimalPromptProcessing = Boolean(state.minimalPromptProcessing);
    const multimodalCaptioning = Boolean(state.multimodalCaptioning);
    const snap = Boolean(state.snap);

    const interactiveSuppressed = functionTool && interactiveMode && toolCallingSupported;

    let triggerTemplate;
    let functionToolToken;
    let interactiveToken;

    if (functionTool && toolCallingSupported) {
        functionToolToken = {
            field: 'functionTool',
            text: translate('Function tool on'),
            tone: 'active',
        };
        if (interactiveMode) {
            interactiveToken = {
                field: 'interactiveMode',
                text: translate('Interactive mode suppressed'),
                tone: 'warn',
            };
            triggerTemplate = translate('${functionTool} exposes GenerateImage to the main model and suppresses ${interactiveMode} while tool calling is supported.');
        } else {
            interactiveToken = {
                field: 'interactiveMode',
                text: translate('Interactive mode off'),
                tone: 'off',
            };
            triggerTemplate = translate('${functionTool} exposes GenerateImage to the main model — ${interactiveMode} is off.');
        }
    } else if (functionTool && !toolCallingSupported) {
        functionToolToken = {
            field: 'functionTool',
            text: translate('Function tool inactive (unsupported by current chat API)'),
            tone: 'warn',
        };
        if (interactiveMode) {
            interactiveToken = {
                field: 'interactiveMode',
                text: translate('Interactive mode on'),
                tone: 'active',
            };
            triggerTemplate = translate('${functionTool} — ${interactiveMode} still triggers on chat phrases because tool calling is unavailable.');
        } else {
            interactiveToken = {
                field: 'interactiveMode',
                text: translate('Interactive mode off'),
                tone: 'off',
            };
            triggerTemplate = translate('${functionTool} — ${interactiveMode} on chat phrases is off.');
        }
    } else if (interactiveMode) {
        functionToolToken = {
            field: 'functionTool',
            text: translate('Function tool off'),
            tone: 'off',
        };
        interactiveToken = {
            field: 'interactiveMode',
            text: translate('Interactive mode on'),
            tone: 'active',
        };
        triggerTemplate = translate('${functionTool} — ${interactiveMode} auto-triggers image generation on matching user chat phrases.');
    } else {
        functionToolToken = {
            field: 'functionTool',
            text: translate('Function tool off'),
            tone: 'off',
        };
        interactiveToken = {
            field: 'interactiveMode',
            text: translate('Interactive mode off'),
            tone: 'off',
        };
        triggerTemplate = translate('${functionTool} and ${interactiveMode} — image generation runs only via commands or the wand menu.');
    }

    const triggersRow = {
        role: translate('Triggers'),
        template: triggerTemplate,
        tokens: {
            functionTool: functionToolToken,
            interactiveMode: interactiveToken,
        },
    };

    const pipelineRow = {
        role: translate('Prompt pipeline'),
        template: translate('Free prompts ${freeExtend}, non-free prompts ${refineMode} and ${minimalPromptProcessing}, portraits ${multimodalCaptioning}, forced portrait/background ratios ${snap} — none of these 5 switches affect AI Illustration.'),
        tokens: {
            freeExtend: {
                field: 'freeExtend',
                text: freeExtend ? translate('LLM-extended') : translate('sent verbatim'),
                tone: freeExtend ? 'active' : 'off',
            },
            refineMode: {
                field: 'refineMode',
                text: refineMode ? translate('edit popup before generating') : translate('send directly'),
                tone: refineMode ? 'active' : 'off',
            },
            minimalPromptProcessing: {
                field: 'minimalPromptProcessing',
                text: minimalPromptProcessing ? translate('preserve raw structured output') : translate('strip to comma tags'),
                tone: minimalPromptProcessing ? 'active' : 'off',
            },
            multimodalCaptioning: {
                field: 'multimodalCaptioning',
                text: multimodalCaptioning ? translate('caption avatars with multimodal') : translate('describe avatars via text LLM'),
                tone: multimodalCaptioning ? 'active' : 'off',
            },
            snap: {
                field: 'snap',
                text: snap ? translate('snap to nearest resolution') : translate('keep exact aspect dimensions'),
                tone: snap ? 'active' : 'off',
            },
        },
    };

    const warnings = [];
    if (interactiveSuppressed) {
        warnings.push({
            severity: 'warn',
            template: translate('${interactiveMode} is suppressed while ${functionTool} is active and tool calling is supported.'),
            tokens: {
                interactiveMode: {
                    field: 'interactiveMode',
                    text: translate('Interactive mode'),
                    tone: 'warn',
                },
                functionTool: {
                    field: 'functionTool',
                    text: translate('Function tool'),
                    tone: 'active',
                },
            },
        });
    }

    return {
        tone: interactiveSuppressed ? 'warn' : 'active',
        rows: [triggersRow, pipelineRow],
        warnings,
        dormantFields: interactiveSuppressed ? ['interactiveMode'] : [],
    };
}
