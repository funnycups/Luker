// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, clear, put } from '../../../../lens-shared/util.js';
import {
    button,
    formField,
    sectionTitle,
    selectInput,
} from '../../../../lens-shared/ui.js';
import {
    createImageAttachmentTray,
    renderMessageAttachments,
} from '../../../../lens-shared/image-attachments.js';
import { createCharacterProfileStore, profileVersion } from '../../character-archive/store.js';
import { resolveExplorationLlm } from '../../exploration/agent.js';
import { runCharacterBuilderTurn } from '../../exploration/dialog-agent.js';
import {
    commitCharacterDraft,
    createCharacterDraft,
    isStagedTempImagePath,
} from '../../exploration/dialog-draft.js';
import { createSourcePolicy } from '../../exploration/source-policy.js';
import { makeIllustrationId } from '../../illustration/presets.js';
import { getPresetById } from '../../illustration/settings.js';
import { icon } from '../icons.js';
import { i18n, i18nFormat } from '../i18n.js';
import { createTempMediaTracker } from '../temp-media-tracker.js';

function parseCsvList(text) {
    return String(text || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function formatConflictValue(value) {
    if (Array.isArray(value)) {
        if (value.length === 0) return i18n('(empty)');
        if (typeof value[0] === 'string') return value.join(', ');
        return value.map(ref => {
            const path = String(ref?.path || '').trim();
            const label = String(ref?.label || '').trim();
            return label ? `${label} (${path})` : path;
        }).filter(Boolean).join(', ') || i18n('(empty)');
    }
    const text = String(value ?? '').trim();
    return text || i18n('(empty)');
}

function conflictFieldLabel(path) {
    switch (path) {
        case 'name': return i18n('Canonical display name');
        case 'aliases': return i18n('Aliases (comma-separated)');
        case 'sourceWork': return i18n('Source work or franchise');
        case 'description': return i18n('Character visual description');
        case 'referenceImages': return i18n('Reference images');
        default: return path;
    }
}

function buildSourceOptions(ctx) {
    const options = [
        { value: 'none', label: i18n('Do not read a character card') },
    ];
    const chars = Array.isArray(ctx?.characters) ? ctx.characters : [];
    let activeAvatar = '';
    if (!ctx?.groupId && ctx?.characterId !== undefined && ctx?.characterId !== null && ctx?.characterId !== '') {
        const currentCard = chars[ctx.characterId];
        if (currentCard?.avatar) {
            activeAvatar = String(currentCard.avatar);
            const labelName = String(currentCard.name || activeAvatar).trim();
            options.push({
                value: `card:${activeAvatar}`,
                label: i18nFormat('Current chat card: ${0}', labelName),
            });
        }
    }
    const personaName = String(ctx?.name1 || 'User').trim();
    options.push({
        value: 'persona',
        label: i18nFormat('Current user persona: ${0}', personaName),
    });
    for (const ch of chars) {
        const avatar = String(ch?.avatar || '');
        if (!avatar || avatar === activeAvatar) continue;
        const name = String(ch?.name || avatar).trim();
        options.push({
            value: `card:${avatar}`,
            label: `${name} (${avatar})`,
        });
    }
    return options;
}

function parseSourceSelection(value) {
    const raw = String(value || 'none');
    if (raw === 'persona') return { kind: 'persona' };
    if (raw.startsWith('card:')) return { kind: 'card', card_avatar: raw.slice('card:'.length) };
    return { kind: 'none' };
}

export async function openCharacterBuilderDialog({ app, initialProfile = null, onSaved = null } = {}) {
    const ctx = app.getContext();
    if (typeof ctx?.Popup !== 'function' || !ctx?.POPUP_TYPE) {
        throw new Error('Popup API is unavailable in the current context.');
    }

    const isEditing = Boolean(initialProfile && typeof initialProfile === 'object');
    const initialSnapshot = isEditing ? JSON.parse(JSON.stringify(initialProfile)) : null;
    const initialVersion = initialSnapshot ? profileVersion(initialSnapshot) : null;
    const draft = createCharacterDraft(initialSnapshot);
    const tracker = createTempMediaTracker(ctx);
    const store = createCharacterProfileStore(ctx);

    let sourceValue = 'none';
    let conversationMessages = [];
    const transcriptEntries = [];
    let composerText = '';
    let turnBusy = false;
    let turnAbort = null;
    let turnPromise = null;
    let saveBusy = false;
    let closingBusy = false;
    let savedResult = null;
    let cleanupDone = false;
    let cleanupErrorMessage = '';
    let errorBannerMessage = '';
    let dialogResult = { saved: false, cancelled: true, profile: null };
    let popup = null;

    const previewCache = new Map();

    const root = h('div', {
        class: 'lw-surface sdlens-builder-dialog',
        dataset: { sdRole: 'character-builder-dialog' },
    });
    const headerEl = h('header', { class: 'sdlens-builder-header' });
    const bodyEl = h('div', { class: 'sdlens-builder-split' });
    const chatPaneEl = h('section', { class: 'sdlens-builder-chat-pane' });
    const chatLogEl = h('div', { class: 'sdlens-builder-messages', dataset: { sdRole: 'builder-messages' } });
    const composerWrapEl = h('div', { class: 'sdlens-builder-compose' });
    const composerRowEl = h('div', { class: 'sdlens-compose-row' });
    const composerInputEl = h('textarea', {
        class: 'sdlens-textarea sdlens-builder-input',
        rows: 2,
        placeholder: i18n('Describe the character or request appearance, outfit, or reference updates…'),
        dataset: { sdRole: 'builder-input' },
        onInput: e => { composerText = e.target.value; },
        onKeydown: e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                if (!turnBusy) void handleSend();
            }
        },
    });
    const attachmentTray = createImageAttachmentTray({
        composerEl: composerWrapEl,
        textareaEl: composerInputEl,
        onError: msg => app.toast(msg, { error: true }),
    });
    const composerActionSlotEl = h('div', { class: 'sdlens-compose-action' });
    put(composerRowEl, attachmentTray.attachButton, attachmentTray.fileInput, composerInputEl, composerActionSlotEl);
    put(composerWrapEl, attachmentTray.trayEl, composerRowEl);
    const draftPaneEl = h('section', { class: 'sdlens-builder-draft-pane', dataset: { sdRole: 'builder-draft-pane' } });
    const footerEl = h('footer', { class: 'sdlens-builder-footer' });

    put(chatPaneEl, chatLogEl, composerWrapEl);
    put(bodyEl, chatPaneEl, draftPaneEl);
    put(root, headerEl, bodyEl, footerEl);

    function resolveActivePreset() {
        const ill = ctx?.extensionSettings?.sd?.illustration;
        return getPresetById(ill, ill?.currentPresetId) || ill?.presets?.[0] || {};
    }

    async function loadCachedPreview(imagePath) {
        if (!isStagedTempImagePath(imagePath)) {
            return imagePath;
        }
        const cached = previewCache.get(imagePath);
        if (cached) return cached;
        const dataUrl = await tracker.preview(imagePath);
        previewCache.set(imagePath, dataUrl);
        return dataUrl;
    }

    function createManagedThumbnail(imagePath, altText) {
        if (!isStagedTempImagePath(imagePath)) {
            return h('img', { src: imagePath, alt: altText, dataset: { imagePath } });
        }
        const cached = previewCache.get(imagePath);
        if (cached) {
            return h('img', { src: cached, alt: altText, dataset: { imagePath } });
        }
        const img = h('img', { alt: altText, dataset: { imagePath, loading: 'true' } });
        loadCachedPreview(imagePath).then(dataUrl => {
            img.src = dataUrl;
            delete img.dataset.loading;
        }).catch(err => {
            img.dataset.previewError = String(err?.message || err);
        });
        return img;
    }

    function renderHeader() {
        clear(headerEl);
        const title = h('h3', {
            class: 'sdlens-builder-title',
            text: isEditing ? i18n('Refine character profile with AI') : i18n('Build character profile with AI'),
        });
        const sourceId = `sd_builder_source_${makeIllustrationId('src')}`;
        const sourceLabel = h('label', {
            class: 'sdlens-builder-source-label',
            for: sourceId,
            text: i18n('Source material'),
        });
        const sourceSelect = selectInput(buildSourceOptions(ctx), sourceValue, nextVal => {
            sourceValue = nextVal;
        }, { ariaLabel: i18n('Source material') });
        sourceSelect.id = sourceId;
        sourceSelect.dataset.sdRole = 'builder-source-select';
        sourceSelect.disabled = turnBusy || saveBusy || closingBusy || Boolean(savedResult);

        put(headerEl,
            title,
            h('div', { class: 'sdlens-builder-source-wrap' }, sourceLabel, sourceSelect));
    }

    function renderChatMessages() {
        clear(chatLogEl);
        if (transcriptEntries.length === 0) {
            put(chatLogEl, h('div', {
                class: 'sdlens-builder-empty-chat',
                text: i18n('Describe the character, ask AI to search public sources or generate candidate portraits, and edit the draft on the right at any time.'),
            }));
            return;
        }
        for (const entry of transcriptEntries) {
            const msgEl = h('div', {
                class: `sdlens-msg ${entry.role === 'user' ? 'is-user' : 'is-assistant'}`,
                dataset: { sdBuilderMsg: entry.role },
            });
            put(msgEl, h('div', {
                class: 'sdlens-builder-msg-role',
                text: entry.role === 'user' ? i18n('You') : i18n('Character Builder AI'),
            }));
            if (entry.text) {
                put(msgEl, h('div', { class: 'sdlens-builder-msg-text', text: entry.text }));
            }
            if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
                put(msgEl, renderMessageAttachments(entry.attachments, { loadPreview: loadCachedPreview }));
            }
            if (Array.isArray(entry.tools) && entry.tools.length > 0) {
                const toolList = h('div', { class: 'sdlens-builder-tool-list' });
                for (const tool of entry.tools) {
                    put(toolList, h('span', {
                        class: `lw-pilltag ${tool.isError ? 'is-err' : ''}`.trim(),
                        text: tool.label,
                    }));
                }
                put(msgEl, toolList);
            }
            if (Array.isArray(entry.images) && entry.images.length > 0) {
                const strip = h('div', { class: 'sdlens-ref-strip' });
                for (const imagePath of entry.images) {
                    put(strip, h('div', { class: 'sdlens-ref-item' },
                        h('div', { class: 'sdlens-ref-thumb' }, createManagedThumbnail(imagePath, 'Candidate reference'))));
                }
                put(msgEl, strip);
            }
            put(chatLogEl, msgEl);
        }
        chatLogEl.scrollTop = chatLogEl.scrollHeight;
    }

    function renderComposer() {
        const disabled = saveBusy || closingBusy || Boolean(savedResult);
        composerInputEl.disabled = disabled;
        if (composerInputEl.value !== composerText) {
            composerInputEl.value = composerText;
        }
        attachmentTray.setDisabled(turnBusy || disabled);

        clear(composerActionSlotEl);
        const actionBtn = turnBusy
            ? button(i18n('Stop'), () => {
                turnAbort?.abort('Stopped by user');
            }, {
                danger: true,
                iconName: 'stop',
                renderIcon: icon,
            })
            : button(i18n('Send'), () => { void handleSend(); }, {
                primary: true,
                iconName: 'send',
                renderIcon: icon,
                disabled,
            });
        actionBtn.dataset.sdRole = turnBusy ? 'builder-stop' : 'builder-send';

        put(composerActionSlotEl, actionBtn);
    }

    function renderConflictsSection() {
        const conflicts = draft.getConflicts();
        if (conflicts.length === 0) return null;
        return h('div', { class: 'sdlens-builder-conflicts', dataset: { sdRole: 'builder-conflicts' } },
            h('div', {
                class: 'sdlens-builder-conflicts-title',
                text: i18n('Draft conflicts need your choice before saving'),
            }),
            ...conflicts.map(conflict => {
                const keepBtn = button(i18n('Keep my edit'), () => {
                    draft.resolveConflict(conflict.id, 'keep_manual');
                    errorBannerMessage = '';
                    renderDraftPane();
                    renderFooter();
                }, { small: true });
                keepBtn.dataset.sdChoice = 'keep_manual';
                const acceptBtn = button(i18n('Use AI suggestion'), () => {
                    draft.resolveConflict(conflict.id, 'accept_agent');
                    errorBannerMessage = '';
                    renderDraftPane();
                    renderFooter();
                }, { small: true, primary: true });
                acceptBtn.dataset.sdChoice = 'accept_agent';

                return h('div', {
                    class: 'sdlens-builder-conflict-card',
                    dataset: { sdRole: 'builder-conflict', conflictPath: conflict.path, conflictId: conflict.id },
                },
                h('strong', { text: conflictFieldLabel(conflict.path) }),
                h('div', { class: 'sdlens-builder-conflict-diff' },
                    h('div', { text: `${i18n('Your edit')}: ${formatConflictValue(conflict.manualValue)}` }),
                    h('div', { text: `${i18n('AI suggestion')}: ${formatConflictValue(conflict.agentValue)}` })),
                h('div', { class: 'sdlens-builder-conflict-actions' }, keepBtn, acceptBtn));
            }));
    }

    function renderDraftReferences(snapshot) {
        const disabled = saveBusy || closingBusy || Boolean(savedResult);
        const refs = Array.isArray(snapshot.referenceImages) ? snapshot.referenceImages : [];

        const fileInput = h('input', {
            type: 'file',
            accept: 'image/*',
            hidden: true,
            disabled,
            onChange: async e => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                    const stagedPath = await tracker.upload(file);
                    const current = draft.getSnapshot();
                    const existing = Array.isArray(current.referenceImages) ? current.referenceImages : [];
                    const nextRefs = existing.some(item => item.path === stagedPath)
                        ? existing
                        : [...existing, { path: stagedPath, label: '' }];
                    draft.edit('referenceImages', nextRefs);
                    errorBannerMessage = '';
                    renderDraftPane();
                    renderFooter();
                } catch (err) {
                    errorBannerMessage = String(err?.message || err);
                    app.toast(errorBannerMessage, { error: true });
                    renderFooter();
                }
            },
        });

        const uploadBtn = button(i18n('Upload local reference image'), () => fileInput.click(), {
            small: true,
            iconName: 'upload',
            renderIcon: icon,
            disabled,
        });
        uploadBtn.dataset.sdRole = 'builder-upload-ref';

        const refGrid = refs.length === 0
            ? h('div', { class: 'sdlens-ref-empty', text: i18n('No reference images added yet.') })
            : h('div', { class: 'sdlens-ref-strip' },
                refs.map((entry, idx) => h('div', {
                    class: 'sdlens-ref-item',
                    dataset: { sdRole: 'builder-ref-item', imagePath: entry.path },
                },
                h('div', { class: 'sdlens-ref-thumb' },
                    createManagedThumbnail(entry.path, entry.label || 'Reference'),
                    h('button', {
                        type: 'button',
                        class: 'sdlens-ref-remove',
                        title: i18n('Remove'),
                        'aria-label': i18n('Remove'),
                        disabled,
                        dataset: { sdRole: 'builder-ref-remove' },
                        onClick: () => {
                            const current = draft.getSnapshot();
                            const nextRefs = (current.referenceImages || []).filter((_, i) => i !== idx);
                            draft.edit('referenceImages', nextRefs);
                            renderDraftPane();
                        },
                    }, icon('x', { size: 12 }))),
                h('div', { class: 'sdlens-ref-body' },
                    h('input', {
                        type: 'text',
                        class: 'sdlens-input sdlens-ref-label',
                        value: entry.label || '',
                        placeholder: i18n('Reference label (e.g. default outfit, side view)'),
                        'aria-label': i18n('Reference label'),
                        disabled,
                        dataset: { sdBuilderRefLabel: String(idx) },
                        onInput: e => {
                            draft.edit(`referenceImages.${idx}.label`, e.target.value);
                        },
                    })))));

        return h('section', { class: 'sdlens-refs-section' },
            sectionTitle(i18n('Reference images')),
            refGrid,
            h('div', { class: 'sdlens-ref-controls' }, uploadBtn, fileInput));
    }

    function renderDraftPane() {
        clear(draftPaneEl);
        const snapshot = draft.getSnapshot();
        const disabled = saveBusy || closingBusy || Boolean(savedResult);

        const conflictsBlock = renderConflictsSection();
        if (conflictsBlock) {
            put(draftPaneEl, conflictsBlock);
        }

        const descTextarea = h('textarea', {
            class: 'sdlens-textarea sdlens-description-textarea',
            placeholder: i18n('Describe appearance, Danbooru character tag if applicable, outfits, and visual notes…'),
            disabled,
            dataset: { sdBuilderField: 'description' },
            onInput: e => { draft.edit('description', e.target.value); },
        });
        descTextarea.value = snapshot.description || '';

        put(draftPaneEl,
            sectionTitle(i18n('Editable profile draft')),
            h('div', { class: 'sdlens-grid-2' },
                formField(i18n('Canonical display name'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: snapshot.name,
                    disabled,
                    dataset: { sdBuilderField: 'name' },
                    onInput: e => { draft.edit('name', e.target.value); },
                })),
                formField(i18n('Aliases (comma-separated)'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: (snapshot.aliases || []).join(', '),
                    disabled,
                    dataset: { sdBuilderField: 'aliases' },
                    onInput: e => { draft.edit('aliases', parseCsvList(e.target.value)); },
                })),
                formField(i18n('Source work or franchise'), h('input', {
                    type: 'text',
                    class: 'sdlens-input',
                    value: snapshot.sourceWork,
                    disabled,
                    dataset: { sdBuilderField: 'sourceWork' },
                    onInput: e => { draft.edit('sourceWork', e.target.value); },
                }))),
            formField(i18n('Character visual description'), descTextarea),
            renderDraftReferences(snapshot));
    }

    function renderFooter() {
        clear(footerEl);
        const errorText = cleanupErrorMessage || errorBannerMessage;
        if (errorText) {
            const errRow = h('div', {
                class: 'sdlens-builder-error',
                role: 'alert',
                dataset: { sdRole: 'builder-error' },
            }, h('span', { text: errorText }));
            if (cleanupErrorMessage) {
                const retryBtn = button(i18n('Retry cleanup'), () => { void handleRetryCleanup(); }, {
                    small: true,
                    danger: true,
                    disabled: closingBusy,
                });
                retryBtn.dataset.sdRole = 'builder-retry-cleanup';
                put(errRow, retryBtn);
            }
            put(footerEl, errRow);
        }

        const cancelBtn = button(i18n('Cancel'), () => { void handleCancel(); }, {
            disabled: saveBusy || closingBusy,
        });
        cancelBtn.dataset.sdRole = 'builder-cancel';

        const confirmBtn = button(
            saveBusy ? i18n('Saving…') : i18n('Confirm & save to archive'),
            () => { void handleConfirmSave(); },
            {
                primary: true,
                iconName: 'check',
                renderIcon: icon,
                disabled: saveBusy || closingBusy || Boolean(savedResult),
            },
        );
        confirmBtn.dataset.sdRole = 'builder-confirm';

        put(footerEl, h('div', { class: 'sdlens-builder-footer-actions' }, cancelBtn, confirmBtn));
    }

    async function handleSend() {
        const text = String(composerText || '').trim();
        const hasPendingImages = attachmentTray.hasItems();
        if ((!text && !hasPendingImages) || turnBusy || saveBusy || closingBusy || savedResult) return;

        const preset = resolveActivePreset();
        const expLlm = resolveExplorationLlm(preset);
        errorBannerMessage = '';

        let sourcePolicy;
        let promptContext = null;
        let attachments = [];
        try {
            sourcePolicy = await createSourcePolicy(ctx, parseSourceSelection(sourceValue));
            if (typeof ctx?.captureTaskPromptContext === 'function') {
                promptContext = await ctx.captureTaskPromptContext({
                    scope: 'preset',
                    apiPresetName: expLlm.apiPresetName,
                    llmPresetName: expLlm.llmPresetName,
                });
            }
            if (hasPendingImages) {
                await tracker.ready();
                attachments = await attachmentTray.commit(async (files) => {
                    const out = [];
                    for (const file of files) {
                        const stagedPath = await tracker.upload(file);
                        out.push({
                            path: stagedPath,
                            ...(file.name ? { name: file.name } : {}),
                            ...(file.type ? { mime: file.type } : {}),
                        });
                    }
                    return out;
                });
            }
        } catch (err) {
            errorBannerMessage = String(err?.message || err);
            app.toast(errorBannerMessage, { error: true });
            renderFooter();
            return;
        }

        composerText = '';
        const userMessage = {
            role: 'user',
            content: text,
            ...(attachments.length ? { attachments } : {}),
        };
        const nextInputMessages = [...conversationMessages, userMessage];
        transcriptEntries.push({
            role: 'user',
            text,
            ...(attachments.length ? { attachments } : {}),
        });
        const assistantEntry = { role: 'assistant', text: '', tools: [], images: [] };
        transcriptEntries.push(assistantEntry);

        turnBusy = true;
        turnAbort = new AbortController();
        renderHeader();
        renderChatMessages();
        renderComposer();
        renderFooter();

        const runPromise = (async () => {
            try {
                await tracker.ready();
                const result = await runCharacterBuilderTurn({
                    context: ctx,
                    preset,
                    messages: nextInputMessages,
                    draft,
                    sourcePolicy,
                    profileStore: store,
                    media: tracker,
                    promptContext,
                    transientSessionId: tracker.sessionId,
                    abortSignal: turnAbort.signal,
                    onDraftChange: () => {
                        renderDraftPane();
                        renderFooter();
                    },
                    onTrace: event => {
                        if (event.type === 'tool_result') {
                            assistantEntry.tools.push({
                                label: event.name,
                                isError: Boolean(event.isError),
                            });
                            if (event.name === 'fetch_reference_image' && event.result?.ok && event.result?.imagePath) {
                                assistantEntry.images.push(event.result.imagePath);
                            }
                            renderChatMessages();
                        } else if (event.type === 'generated_image' && event.imagePath) {
                            assistantEntry.images.push(event.imagePath);
                            renderChatMessages();
                        }
                    },
                });
                conversationMessages = result.messages;
                assistantEntry.text = result.finalText || i18n('Draft updated.');
            } catch (err) {
                if (turnAbort?.signal?.aborted) {
                    assistantEntry.text = i18n('Builder stopped.');
                } else {
                    const msg = String(err?.message || err);
                    assistantEntry.text = msg;
                    errorBannerMessage = msg;
                    app.toast(msg, { error: true });
                }
            } finally {
                turnBusy = false;
                turnAbort = null;
                turnPromise = null;
                renderHeader();
                renderChatMessages();
                renderComposer();
                renderDraftPane();
                renderFooter();
            }
        })();

        turnPromise = runPromise;
        await runPromise;
    }

    async function stopActiveTurn() {
        if (turnBusy && turnAbort) {
            turnAbort.abort('Stopped by user');
        }
        if (turnPromise) {
            await turnPromise.catch(() => {});
        }
    }

    async function runSessionCleanup() {
        if (cleanupDone) return true;
        closingBusy = true;
        renderFooter();
        try {
            await tracker.waitForIdle();
            await tracker.cleanup();
            cleanupDone = true;
            cleanupErrorMessage = '';
            return true;
        } catch (err) {
            cleanupErrorMessage = i18nFormat('Temporary media cleanup failed: ${0}', String(err?.message || err));
            app.toast(cleanupErrorMessage, { error: true });
            return false;
        } finally {
            closingBusy = false;
            renderFooter();
        }
    }

    async function handleRetryCleanup() {
        const ok = await runSessionCleanup();
        if (ok && popup) {
            await popup.complete(savedResult ? ctx.POPUP_RESULT.AFFIRMATIVE : ctx.POPUP_RESULT.CANCELLED);
        }
    }

    async function handleConfirmSave() {
        if (saveBusy || closingBusy || savedResult) return;
        errorBannerMessage = '';
        await stopActiveTurn();

        saveBusy = true;
        renderHeader();
        renderComposer();
        renderDraftPane();
        renderFooter();

        let committed;
        try {
            committed = await commitCharacterDraft({
                draft,
                initialVersion,
                store,
                tracker,
            });
        } catch (err) {
            saveBusy = false;
            errorBannerMessage = String(err?.message || err);
            app.toast(errorBannerMessage, { error: true });
            renderHeader();
            renderComposer();
            renderDraftPane();
            renderFooter();
            return;
        }

        const { saved, savedVersion, cleanupWarning } = committed;
        savedResult = saved;
        dialogResult = { saved: true, cancelled: false, profile: saved };

        const undoStore = createCharacterProfileStore(ctx);
        app.recordHistory?.({
            label: `${i18n('Save profile')}: ${saved.name}`,
            undo: async () => {
                if (initialSnapshot) {
                    await undoStore.upsertProfile(initialSnapshot, Date.now(), { expectedVersion: savedVersion });
                } else {
                    await undoStore.deleteProfile(saved.id, { expectedVersion: savedVersion });
                }
                await onSaved?.(initialSnapshot || null);
            },
        });

        await onSaved?.(saved);
        saveBusy = false;

        if (cleanupWarning) {
            errorBannerMessage = cleanupWarning;
            app.toast(cleanupWarning, { error: true });
        }

        const cleaned = await runSessionCleanup();
        if (cleaned && popup) {
            await popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
        } else {
            renderHeader();
            renderComposer();
            renderDraftPane();
            renderFooter();
        }
    }

    async function handleCancel() {
        if (saveBusy || closingBusy) return;
        await stopActiveTurn();
        if (savedResult) {
            const cleaned = await runSessionCleanup();
            if (cleaned && popup) {
                await popup.complete(ctx.POPUP_RESULT.AFFIRMATIVE);
            }
            return;
        }
        dialogResult = { saved: false, cancelled: true, profile: null };
        const cleaned = await runSessionCleanup();
        if (cleaned && popup) {
            await popup.complete(ctx.POPUP_RESULT.CANCELLED);
        }
    }

    async function handlePopupClosing() {
        if (cleanupDone) return true;
        if (saveBusy || closingBusy) return false;
        await stopActiveTurn();
        const cleaned = await runSessionCleanup();
        return cleaned;
    }

    renderHeader();
    renderChatMessages();
    renderComposer();
    renderDraftPane();
    renderFooter();

    popup = new ctx.Popup(root, ctx.POPUP_TYPE.DISPLAY, '', {
        wide: true,
        large: true,
        allowEscapeClose: true,
        onClosing: handlePopupClosing,
    });
    popup.dlg?.classList?.add('sdlens-builder-popup');

    await popup.show();
    attachmentTray.destroy();
    return dialogResult;
}
