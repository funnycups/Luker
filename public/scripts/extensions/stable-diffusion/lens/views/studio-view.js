// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, copyText, put } from '../../../../lens-shared/util.js';
import { requireStoredPrompt } from '../../../../lib/prompt-values.js';
import {
    button,
    emptyState,
    iconButton,
    sectionTitle,
    selectInput,
    switchControl,
} from '../../../../lens-shared/ui.js';
import {
    appendStandardToolRoundMessages,
    makeRuntimeToolCallId,
    requestToolCallsWithRetry,
} from '../../../../lib/iter-tool-calling.js';
import { defaultLoadVisualPreviewDataUrl } from '../../exploration/agent.js';
import { makeIllustrationId } from '../../illustration/presets.js';
import { getPresetById, selectPreset } from '../../illustration/settings.js';
import {
    GENERATE_IMAGE_TOOL,
    buildGenerateImageTool,
    validateGenerateImageArgs,
} from '../../illustration/tools.js';
import { resolveReplayLoras } from '../../lora/tool.js';
import {
    appendStudioAssistantTurn,
    appendStudioUserMessage,
    buildStudioHistoryMessages,
    createStudioSession,
    createStudioSessionStore,
} from '../studio-store.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';

function resolveGalleryOrManagedPath(idOrPath, session) {
    const token = String(idOrPath || '').trim();
    if (!token) return '';
    const byId = (session?.images || []).find(img => img.id === token && img.status === 'ready' && img.imageUrl);
    if (byId) return byId.imageUrl;
    if (token.startsWith('/user/images/') || token.startsWith('/characters/') || token.startsWith('/User Avatars/')) {
        return token;
    }
    return '';
}

export function createStudioView(app) {
    const el = h('div', { class: 'sdlens-studio', dataset: { sdView: 'studio' } });
    let sessions = [];
    let session = null;
    let selectedImageId = '';
    let draftInput = '';
    let busy = false;
    let abortController = null;

    function getCtx() {
        return app.getContext();
    }

    function getIllSettings() {
        return getCtx()?.extensionSettings?.sd?.illustration || null;
    }

    function resolveImageBackend() {
        if (app.imageService) return app.imageService;
        const ctx = getCtx();
        return {
            async getAvailableLoras() {
                const caps = await ctx?.imageGeneration?.getCapabilities?.();
                return caps?.availableLoras || { names: [], includeWeight: false };
            },
            async getCapabilities() {
                return (await ctx?.imageGeneration?.getCapabilities?.()) || null;
            },
            async generate(prompt, opts) {
                const res = await ctx.imageGeneration.generate({ prompt, ...opts });
                return res.imagePath;
            },
        };
    }

    async function refreshLists() {
        const ctx = getCtx();
        if (typeof ctx?.getGlobalState !== 'function') return;
        const sessionStore = createStudioSessionStore(ctx);
        sessions = await sessionStore.listSessions();
    }

    async function ensureSessionLoaded() {
        await refreshLists();
        const ill = getIllSettings();
        if (!session) {
            if (sessions.length > 0) {
                session = JSON.parse(JSON.stringify(sessions[0]));
            } else {
                session = createStudioSession({ presetId: ill?.currentPresetId || '' });
            }
            selectedImageId = session.images.at(-1)?.id || '';
        }
        paint();
    }

    async function persistCurrentSession(target = session) {
        const ctx = getCtx();
        if (!target || typeof ctx?.updateGlobalState !== 'function') return;
        if (target.messages.length === 0 && target.images.length === 0) {
            return;
        }
        const saved = await createStudioSessionStore(ctx).saveSession(target);
        if (session?.id === target.id) {
            target.updatedAt = saved.updatedAt;
        }
        await refreshLists();
    }

    async function startNewSession(overrides = {}) {
        if (busy) return;
        const ill = getIllSettings();
        session = createStudioSession({
            presetId: ill?.currentPresetId || '',
            ...overrides,
        });
        selectedImageId = '';
        await refreshLists();
        paint();
    }

    function resolveActivePreset() {
        const ill = getIllSettings();
        if (!ill) return null;
        return getPresetById(ill, session?.presetId || ill.currentPresetId)
            || getPresetById(ill, ill.currentPresetId)
            || ill.presets?.[0]
            || null;
    }

    function buildStudioTools(loraState, capabilities) {
        return [buildGenerateImageTool(loraState.names, {
            includeWeight: loraState.includeWeight,
            capabilities,
            includeStudioFields: true,
        })];
    }

    function buildStudioSystemPrompt(preset) {
        return requireStoredPrompt(preset.studioPrompt, i18n('Fill in the prompt or reset it to the default.'));
    }

    async function executeSingleStudioTool(rawCall, { loraState, capabilities, imageBackend, signal }) {
        const name = String(rawCall?.name || '');
        const args = rawCall?.args || {};

        if (name === GENERATE_IMAGE_TOOL.function.name) {
            const validation = validateGenerateImageArgs(args, {
                availableLoras: loraState.names,
                includeWeight: loraState.includeWeight,
                capabilities,
            });
            if (!validation.ok) {
                return { toolResult: { status: 'failed', error: validation.error }, generatedImage: null };
            }
            const val = validation.value;
            const references = [];

            // Explicit or attached source image
            const sourceToken = val.sourceImageId
                || session.attachedReferences.find(r => r.role === 'source')?.imagePath
                || '';
            if (sourceToken) {
                const resolvedSource = resolveGalleryOrManagedPath(sourceToken, session);
                if (!resolvedSource) {
                    return {
                        toolResult: { status: 'failed', error: `Unknown source_image_id "${sourceToken}".` },
                        generatedImage: null,
                    };
                }
                references.push({ imagePath: resolvedSource, role: 'source' });
            }

            // Character reference images from gallery or attached references
            for (const charToken of val.characterImageIds || []) {
                const resolvedChar = resolveGalleryOrManagedPath(charToken, session);
                if (!resolvedChar) {
                    return {
                        toolResult: { status: 'failed', error: `Unknown character_image_id "${charToken}".` },
                        generatedImage: null,
                    };
                }
                references.push({ imagePath: resolvedChar, role: 'character' });
            }
            for (const att of session.attachedReferences.filter(r => r.role === 'character')) {
                if (att?.imagePath && !references.some(r => r.imagePath === att.imagePath)) {
                    references.push({ imagePath: att.imagePath, role: 'character', label: att.label || '' });
                }
            }

            const genOpts = {
                attribution: 'none',
                subdir: '_studio',
                loras: val.loras,
                signal,
            };
            if (val.negativePrompt) genOpts.negativePrompt = val.negativePrompt;
            if (val.aspectRatio) genOpts.aspectRatio = val.aspectRatio;
            if (references.length > 0) genOpts.references = references;

            const imgId = makeIllustrationId('img');
            try {
                const imageUrl = await imageBackend.generate(val.prompt, genOpts);
                // Clear one-shot source attachment once used
                session.attachedReferences = session.attachedReferences.filter(r => r.role !== 'source');
                const imgRecord = {
                    id: imgId,
                    prompt: val.prompt,
                    negativePrompt: val.negativePrompt || '',
                    aspectRatio: val.aspectRatio || '',
                    imageUrl,
                    sourceImageId: val.sourceImageId || '',
                    characterImageIds: val.characterImageIds || [],
                    loras: val.loras,
                    status: 'ready',
                    error: '',
                    createdAt: Date.now(),
                };
                return {
                    toolResult: { status: 'ready', image_id: imgId, url: imageUrl, prompt: val.prompt },
                    generatedImage: imgRecord,
                };
            } catch (err) {
                const reason = String(err?.message || err);
                const imgRecord = {
                    id: imgId,
                    prompt: val.prompt,
                    negativePrompt: val.negativePrompt || '',
                    aspectRatio: val.aspectRatio || '',
                    imageUrl: '',
                    sourceImageId: val.sourceImageId || '',
                    characterImageIds: val.characterImageIds || [],
                    loras: val.loras,
                    status: 'failed',
                    error: reason,
                    createdAt: Date.now(),
                };
                return {
                    toolResult: { status: 'failed', error: reason, prompt: val.prompt },
                    generatedImage: imgRecord,
                };
            }
        }

        return {
            toolResult: { status: 'failed', error: `Unsupported studio tool "${name}".` },
            generatedImage: null,
        };
    }

    async function runTurn(rawText) {
        const text = String(rawText || '').trim();
        if (!text || busy) return;

        const ctx = getCtx();
        const preset = resolveActivePreset();
        if (!preset) {
            app.toast(i18n('No illustration preset is selected.'), { error: true });
            return;
        }
        let systemPrompt;
        try {
            systemPrompt = buildStudioSystemPrompt(preset);
        } catch (error) {
            app.toast(String(error?.message || error), { error: true });
            return;
        }

        const turnSession = session;
        busy = true;
        abortController = new AbortController();
        draftInput = '';
        appendStudioUserMessage(turnSession, text);
        paint();

        try {
            const imageBackend = resolveImageBackend();
            const [loraState, capabilities] = await Promise.all([
                imageBackend.getAvailableLoras(),
                imageBackend.getCapabilities?.() ?? Promise.resolve(null),
            ]);
            const tools = buildStudioTools(loraState, capabilities);
            const allowedNames = tools.map(t => t.function.name);
            const taskMessages = [
                { role: 'system', content: systemPrompt },
                ...buildStudioHistoryMessages(turnSession),
            ];

            while (true) {
                const response = await requestToolCallsWithRetry(ctx, { toolCallRetryMax: 1 }, {
                    taskMessages,
                    apiPresetName: preset.llm?.apiPresetName || '',
                    llmPresetName: preset.llm?.llmPresetName || '',
                    tools,
                    allowedNames,
                    allowNoToolCalls: true,
                    includeAssistantText: true,
                    substituteMacros: true,
                    abortSignal: abortController.signal,
                });

                const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
                const assistantText = String(response?.assistantText || '');

                if (calls.length === 0) {
                    if (assistantText || turnSession.messages.at(-1)?.role === 'user') {
                        appendStudioAssistantTurn(turnSession, {
                            text: assistantText,
                            toolCalls: [],
                            toolResults: [],
                            images: [],
                        });
                    }
                    break;
                }

                const roundImages = [];
                const toolResultsForPersist = [];
                const executedForHistory = [];
                const generatedPathsForPreview = [];

                for (const call of calls) {
                    const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
                    let toolResult;
                    let generatedImage = null;
                    try {
                        const out = await executeSingleStudioTool(call, {
                            loraState,
                            capabilities,
                            imageBackend,
                            signal: abortController.signal,
                        });
                        toolResult = out.toolResult;
                        generatedImage = out.generatedImage;
                    } catch (toolErr) {
                        if (abortController.signal.aborted) {
                            throw toolErr;
                        }
                        toolResult = { status: 'failed', error: String(toolErr?.message || toolErr) };
                    }
                    const serialized = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
                    toolResultsForPersist.push({ tool_call_id: callId, content: serialized });
                    executedForHistory.push({
                        id: callId,
                        name: call.name,
                        args: call.args,
                        result: toolResult,
                    });
                    if (generatedImage) {
                        roundImages.push(generatedImage);
                        if (generatedImage.status === 'ready' && generatedImage.imageUrl && turnSession.visualReview) {
                            generatedPathsForPreview.push(generatedImage.imageUrl);
                        }
                    }
                }

                appendStudioAssistantTurn(turnSession, {
                    text: assistantText,
                    toolCalls: calls.map((c, idx) => ({
                        id: toolResultsForPersist[idx].tool_call_id,
                        name: c.name,
                        arguments: c.args,
                    })),
                    toolResults: toolResultsForPersist,
                    images: roundImages,
                });

                if (roundImages.length > 0 && session === turnSession) {
                    selectedImageId = roundImages.at(-1).id;
                }

                appendStandardToolRoundMessages(taskMessages, executedForHistory, assistantText, {
                    reasoning: response?.reasoning,
                    reasoningBlocks: response?.reasoningBlocks,
                    reasoningDetails: response?.reasoningDetails,
                });

                if (turnSession.visualReview && generatedPathsForPreview.length > 0) {
                    const previewParts = [];
                    for (const imgPath of generatedPathsForPreview) {
                        try {
                            const dataUrl = await defaultLoadVisualPreviewDataUrl(imgPath, ctx);
                            if (dataUrl) {
                                previewParts.push({ type: 'text', text: `[Visual preview: ${imgPath}]` });
                                previewParts.push({ type: 'image_url', image_url: { url: dataUrl } });
                            }
                        } catch (err) {
                            previewParts.push({
                                type: 'text',
                                text: `[Visual preview unavailable for ${imgPath}: ${String(err?.message || err)}]`,
                            });
                        }
                    }
                    if (previewParts.length > 0) {
                        taskMessages.push({ role: 'user', content: previewParts });
                    }
                }

                await persistCurrentSession(turnSession);
                if (session === turnSession) {
                    paint();
                }

                if (!turnSession.visualReview && roundImages.length > 0) {
                    break;
                }
            }

            await persistCurrentSession(turnSession);
        } catch (err) {
            if (!abortController?.signal?.aborted) {
                app.toast(`${i18n('Studio request failed')}: ${String(err?.message || err)}`, { error: true });
            }
            await persistCurrentSession(turnSession);
        } finally {
            busy = false;
            abortController = null;
            if (session === turnSession) {
                paint();
            }
        }
    }

    async function regenerateGalleryImage(image) {
        if (busy || !image?.prompt) return;
        try {
            const imageBackend = resolveImageBackend();
            const savedLoras = Array.isArray(image.loras) ? image.loras : [];
            let loras = [];
            if (savedLoras.length > 0) {
                const loraState = await imageBackend.getAvailableLoras();
                loras = resolveReplayLoras(savedLoras, loraState.names, (dropped) => {
                    const msg = i18nFormat('Some LoRAs are unavailable and were skipped: ${0}', dropped.join(', '));
                    globalThis.toastr?.warning?.(msg, i18n('Image Generation'));
                    app.toast(msg);
                }).loras;
            }
            const reconstructedRefs = [];
            if (image.sourceImageId) {
                const resolvedSource = resolveGalleryOrManagedPath(image.sourceImageId, session);
                if (resolvedSource) {
                    reconstructedRefs.push({ imagePath: resolvedSource, role: 'source' });
                }
            }
            for (const charToken of Array.isArray(image.characterImageIds) ? image.characterImageIds : []) {
                const resolvedChar = resolveGalleryOrManagedPath(charToken, session);
                if (resolvedChar) {
                    reconstructedRefs.push({ imagePath: resolvedChar, role: 'character' });
                }
            }
            const imageUrl = await imageBackend.generate(image.prompt, {
                attribution: 'none',
                subdir: '_studio',
                negativePrompt: image.negativePrompt || undefined,
                aspectRatio: image.aspectRatio || undefined,
                references: reconstructedRefs.length > 0 ? reconstructedRefs : undefined,
                loras,
            });
            const record = {
                id: makeIllustrationId('img'),
                messageId: image.messageId || '',
                prompt: image.prompt,
                negativePrompt: image.negativePrompt || '',
                aspectRatio: image.aspectRatio || '',
                imageUrl,
                sourceImageId: image.sourceImageId || '',
                characterImageIds: image.characterImageIds || [],
                loras,
                status: 'ready',
                error: '',
                createdAt: Date.now(),
            };
            session.images.push(record);
            selectedImageId = record.id;
            await persistCurrentSession();
            paint();
        } catch (err) {
            app.toast(String(err?.message || err), { error: true });
        }
    }

    function renderSessionsPane() {
        const ill = getIllSettings();
        const presetOpts = (ill?.presets || []).map(p => ({ value: p.id, label: p.name || p.id }));
        const presetSelect = selectInput(
            presetOpts.length > 0 ? presetOpts : [{ value: '', label: '—' }],
            session?.presetId || ill?.currentPresetId || '',
            async (nextId) => {
                if (!ill || busy) return;
                try {
                    selectPreset(ill, nextId);
                    if (session) session.presetId = nextId;
                    await persistCurrentSession();
                    paint();
                } catch (err) {
                    app.toast(String(err?.message || err), { error: true });
                }
            },
            { ariaLabel: i18n('Preset'), disabled: busy },
        );
        presetSelect.dataset.sdRole = 'studio-preset';

        const newBtn = iconButton('plus', i18n('New studio session'), () => { void startNewSession(); }, {
            disabled: busy,
            renderIcon: icon,
        });
        newBtn.dataset.sdRole = 'studio-new-session';

        return h('aside', { class: 'sdlens-studio-sessions' },
            h('div', { style: { display: 'flex', gap: '6px', padding: '10px', borderBottom: '1px solid var(--lw-border)' } },
                presetSelect,
                newBtn),
            h('div', { class: 'sdlens-studio-list' },
                sessions.map(entry => h('div', {
                    class: `sdlens-session-item ${entry.id === session?.id ? 'is-active' : ''}`.trim(),
                    dataset: { studioSessionId: entry.id },
                    onClick: async (e) => {
                        if (busy || e.target.closest?.('[data-studio-session-delete]')) return;
                        const loaded = await createStudioSessionStore(getCtx()).getSession(entry.id);
                        if (loaded) {
                            session = loaded;
                            selectedImageId = session.images.at(-1)?.id || '';
                            paint();
                        }
                    },
                },
                h('span', {
                    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12.5px' },
                    text: entry.title || entry.id,
                }),
                iconButton('trash', i18n('Delete'), async (e) => {
                    e.stopPropagation();
                    if (busy) return;
                    await createStudioSessionStore(getCtx()).deleteSession(entry.id);
                    await refreshLists();
                    if (session?.id === entry.id) {
                        session = sessions[0] ? JSON.parse(JSON.stringify(sessions[0])) : createStudioSession({ presetId: ill?.currentPresetId || '' });
                        selectedImageId = session.images.at(-1)?.id || '';
                    }
                    paint();
                }, { className: 'is-sm', renderIcon: icon, disabled: busy })))));
    }

    function renderCenterPane() {
        const toolbarItems = [];
        if (session) {
            const visualSwitch = switchControl(i18n('Visual review'), Boolean(session.visualReview), (next) => {
                session.visualReview = next;
                void persistCurrentSession();
            });
            visualSwitch.style.width = 'auto';
            toolbarItems.push(visualSwitch);
        }

        const messageNodes = (session?.messages || []).map((msg, idx) => h('div', {
            class: `sdlens-msg ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`.trim(),
            dataset: { studioMessageId: msg.id },
        },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11.5px', color: 'var(--lw-muted)' } },
            h('strong', { text: msg.role === 'user' ? (getCtx()?.name1 || 'User') : i18n('Studio AI') }),
            iconButton('fork', i18n('Branch from here'), async () => {
                if (busy || !session?.id) return;
                await persistCurrentSession();
                const forked = await createStudioSessionStore(getCtx()).forkSessionAt(session.id, idx + 1);
                session = forked;
                selectedImageId = session.images.at(-1)?.id || '';
                await refreshLists();
                paint();
            }, { className: 'is-sm', renderIcon: icon, disabled: busy })),
        msg.content ? h('div', { style: { whiteSpace: 'pre-wrap' }, text: msg.content }) : null,
        Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
            ? h('details', null,
                h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--lw-muted)' }, text: i18nFormat('${0} tool call(s)', msg.tool_calls.length) }),
                ...msg.tool_calls.map((tc, tcIdx) => h('pre', {
                    class: 'sdlens-pre',
                    text: `${tc.function?.name || tc.name}(${tc.function?.arguments || ''})\n→ ${msg.tool_results?.[tcIdx]?.content || ''}`,
                })))
            : null));

        const attachedSource = session?.attachedReferences?.find(r => r.role === 'source');
        const attachedBanner = attachedSource
            ? h('div', { class: 'sdlens-studio-source-banner' },
                h('span', { title: attachedSource.imagePath, text: i18nFormat('Editing source image: ${0}', attachedSource.imagePath) }),
                iconButton('x', i18n('Remove'), () => {
                    session.attachedReferences = session.attachedReferences.filter(r => r !== attachedSource);
                    paint();
                }, { className: 'is-sm', renderIcon: icon }))
            : null;

        const inputEl = h('textarea', {
            class: 'sdlens-textarea',
            rows: 2,
            placeholder: i18n('Describe the scene or feedback for the next image…'),
            dataset: { sdRole: 'studio-input' },
            onInput: (e) => { draftInput = e.target.value; },
            onKeydown: (e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void runTurn(e.target.value);
                }
            },
        });
        inputEl.value = draftInput;

        const sendOrStopBtn = busy
            ? (() => {
                const b = button(i18n('Stop studio run'), () => abortController?.abort('Stopped by user'), {
                    danger: true,
                    iconName: 'stop',
                    renderIcon: icon,
                });
                b.dataset.sdRole = 'studio-stop';
                return b;
            })()
            : (() => {
                const b = button(i18n('Send to studio AI'), () => { void runTurn(inputEl.value || draftInput); }, {
                    primary: true,
                    iconName: 'send',
                    renderIcon: icon,
                });
                b.dataset.sdRole = 'studio-send';
                return b;
            })();

        return h('section', { class: 'sdlens-studio-main' },
            h('div', { class: 'sdlens-studio-toolbar' }, ...toolbarItems),
            h('div', { class: 'sdlens-studio-messages' }, ...messageNodes),
            attachedBanner,
            h('div', { class: 'sdlens-studio-compose' }, inputEl, sendOrStopBtn));
    }

    function renderGalleryPane() {
        const images = session?.images || [];
        const selected = images.find(img => img.id === selectedImageId) || images.at(-1) || null;

        if (images.length === 0) {
            return h('aside', { class: 'sdlens-studio-gallery' },
                sectionTitle(i18n('Studio gallery')),
                emptyState('image', i18n('No images generated in this session yet'), '', null, { renderIcon: icon }));
        }

        const previewBlock = selected
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, dataset: { sdRole: 'studio-preview' } },
                selected.status === 'ready' && selected.imageUrl
                    ? h('img', {
                        src: selected.imageUrl,
                        alt: selected.prompt,
                        style: { width: '100%', borderRadius: 'var(--lw-r)', border: '1px solid var(--lw-border-strong)' },
                    })
                    : h('div', { class: 'sdlens-pre', text: selected.error || i18n('Failed') }),
                h('pre', { class: 'sdlens-pre', text: selected.prompt }),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                    (() => {
                        const b = button(i18n('Copy'), async () => { await copyText(selected.prompt); }, { small: true });
                        b.dataset.studioAction = 'copy';
                        return b;
                    })(),
                    (() => {
                        const b = button(i18n('Regenerate'), () => { void regenerateGalleryImage(selected); }, { small: true, disabled: busy });
                        b.dataset.studioAction = 'regenerate';
                        return b;
                    })(),
                    selected.status === 'ready' && selected.imageUrl
                        ? (() => {
                            const b = button(i18n('Edit source'), () => {
                                session.attachedReferences = [
                                    ...session.attachedReferences.filter(r => r.role !== 'source'),
                                    { imagePath: selected.imageUrl, role: 'source' },
                                ];
                                paint();
                            }, { small: true });
                            b.dataset.studioAction = 'edit-source';
                            return b;
                        })()
                        : null))
            : null;

        return h('aside', { class: 'sdlens-studio-gallery' },
            sectionTitle(i18n('Studio gallery')),
            previewBlock,
            h('div', { class: 'sdlens-gallery-grid' },
                images.map(img => h('div', {
                    class: `sdlens-gallery-card ${img.id === (selected?.id || '') ? 'is-selected' : ''}`.trim(),
                    dataset: { studioImageId: img.id },
                    onClick: () => {
                        selectedImageId = img.id;
                        paint();
                    },
                },
                img.status === 'ready' && img.imageUrl
                    ? h('img', { src: img.imageUrl, alt: img.prompt })
                    : h('div', { style: { padding: '8px', fontSize: '11px', color: 'var(--lw-danger)' }, text: img.error || i18n('Failed') })))));
    }

    function paint() {
        clear(el);
        put(el, renderSessionsPane(), renderCenterPane(), renderGalleryPane());
    }

    return {
        el,
        show() {
            void ensureSessionLoaded();
        },
        destroy() {
            abortController?.abort('Studio closed');
        },
    };
}
