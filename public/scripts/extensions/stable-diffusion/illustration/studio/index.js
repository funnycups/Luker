import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { t } from '../../../../i18n.js';
import { requestToolCallsWithRetry, makeRuntimeToolCallId } from '../../../../lib/iter-tool-calling.js';
import { createExtensionSettingsSessionStorage } from '../../../../iteration-library/storage.js';
import { GENERATE_IMAGE_TOOL, validateGenerateImageArgs } from '../tools.js';
import { getPresetById, selectPreset } from '../settings.js';
import { makeIllustrationId } from '../presets.js';
import { escapeHtml } from '../message.js';
import {
    appendStudioAssistantTurn,
    appendStudioUserMessage,
    buildStudioHistoryMessages,
    createStudioSession,
} from './session.js';
import { renderStudio, renderStudioPreview } from './render.js';

const SCOPE = 'global';
const ROOT_ID = 'sd_studio';

function studioShellHtml() {
    return `
        <div id="${ROOT_ID}" class="sd_studio">
            <div class="sd_studio_topbar">
                <select id="sd_studio_preset" class="text_pole"></select>
                <div class="sd_studio_topbar_actions">
                    <div id="sd_studio_new" class="menu_button">${escapeHtml(t`New session`)}</div>
                </div>
            </div>
            <div class="sd_studio_body">
                <aside id="sd_studio_sessions" class="sd_studio_sessions"></aside>
                <section class="sd_studio_chat">
                    <div id="sd_studio_messages" class="sd_studio_messages"></div>
                    <div class="sd_studio_composer">
                        <textarea id="sd_studio_input" class="text_pole" rows="3" placeholder="${escapeHtml(t`Describe the image or give feedback`)}"></textarea>
                        <div class="sd_studio_composer_actions">
                            <div id="sd_studio_stop" class="menu_button">${escapeHtml(t`Stop`)}</div>
                            <div id="sd_studio_send" class="menu_button">${escapeHtml(t`Send`)}</div>
                        </div>
                    </div>
                </section>
                <aside class="sd_studio_sidebar">
                    <div id="sd_studio_images" class="sd_studio_images"></div>
                    <div id="sd_studio_preview" class="sd_studio_preview"></div>
                </aside>
            </div>
        </div>`;
}

export async function openIllustrationStudio({ context, settings, imageService, saveSettings }) {
    if (document.getElementById(ROOT_ID)) {
        return;
    }

    const storage = createExtensionSettingsSessionStorage({
        getBucket: () => {
            if (!settings.studioSessions || typeof settings.studioSessions !== 'object') {
                settings.studioSessions = {};
            }
            return settings.studioSessions;
        },
        persistSettings: () => saveSettings(),
        persistSettingsImmediate: () => context.saveSettings(),
    });

    const popup = new Popup(studioShellHtml(), POPUP_TYPE.DISPLAY, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: false,
    });
    const shown = popup.show();
    const $root = $(`#${ROOT_ID}`);

    let session = null;
    let selectedImageId = '';
    let busy = false;
    let abortController = null;
    let closed = false;

    const currentPreset = () => getPresetById(settings, settings.currentPresetId);

    function renderPresetOptions() {
        const options = settings.presets.map(preset => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`);
        const select = $root.find('#sd_studio_preset');
        select.html(options.join(''));
        select.val(settings.currentPresetId);
    }

    async function renderSessionList() {
        const sessions = await storage.listSessions(SCOPE);
        const items = sessions.map(entry => `<div class="sd_studio_session${entry.id === session?.id ? ' active' : ''}" data-studio-session-id="${escapeHtml(entry.id)}">
            <span class="sd_studio_session_title">${escapeHtml(entry.title || entry.id)}</span>
            <span class="sd_studio_session_delete" data-studio-session-delete="${escapeHtml(entry.id)}" title="${escapeHtml(t`Delete session`)}"><i class="fa-solid fa-trash"></i></span>
        </div>`);
        $root.find('#sd_studio_sessions').html(items.join('') || `<div class="sd_studio_empty">${escapeHtml(t`No saved sessions`)}</div>`);
    }

    function renderAll() {
        renderPresetOptions();
        renderStudio(session, $root, { selectedImageId });
        renderStudioPreview(session.images.find(image => image.id === selectedImageId), $root);
        $root.find('#sd_studio_stop').toggle(busy);
        $root.find('#sd_studio_send').toggleClass('disabled', busy);
    }

    async function persistSession(target = session) {
        if (!target) {
            return;
        }
        if (target.messages.length === 0) {
            return;
        }
        await storage.saveSession(SCOPE, target);
        await renderSessionList();
    }

    async function newSession() {
        if (busy) {
            return;
        }
        session = createStudioSession({ presetId: settings.currentPresetId });
        selectedImageId = '';
        renderAll();
        await renderSessionList();
    }

    async function loadSession(id) {
        if (busy) {
            return;
        }
        const loaded = await storage.loadSession(SCOPE, id);
        if (!loaded) {
            return;
        }
        session = loaded;
        selectedImageId = session.images.at(-1)?.id || '';
        renderAll();
        await renderSessionList();
    }

    async function executeToolCalls(toolCalls) {
        const images = [];
        const toolResults = [];
        for (const call of toolCalls) {
            const callId = String(call?.id || '').trim() || makeRuntimeToolCallId();
            if (call?.name !== GENERATE_IMAGE_TOOL.function.name) {
                toolResults.push({ tool_call_id: callId, content: JSON.stringify({ status: 'failed', error: 'Unknown tool.' }) });
                continue;
            }
            const validation = validateGenerateImageArgs(call?.args);
            if (!validation.ok) {
                toolResults.push({ tool_call_id: callId, content: JSON.stringify({ status: 'failed', error: validation.error }) });
                continue;
            }
            const prompt = validation.value.prompt;
            try {
                const imageUrl = await imageService.generate(prompt);
                images.push({ id: makeIllustrationId('img'), prompt, imageUrl, status: 'ready', error: '' });
                toolResults.push({ tool_call_id: callId, content: JSON.stringify({ prompt, url: imageUrl, status: 'ready' }) });
            } catch (error) {
                const reason = String(error?.message || error);
                images.push({ id: makeIllustrationId('img'), prompt, imageUrl: '', status: 'failed', error: reason });
                toolResults.push({ tool_call_id: callId, content: JSON.stringify({ prompt, status: 'failed', error: reason }) });
            }
        }
        return { images, toolResults };
    }

    async function runTurn(text) {
        const turnSession = session;
        const preset = currentPreset();
        if (!preset) {
            toastr.error(t`No illustration preset is selected.`, t`Image Generation`);
            return;
        }
        const systemPrompt = String(preset.studioPrompt || '').trim();
        if (!systemPrompt) {
            toastr.error(t`The studio prompt is empty.`, t`Image Generation`);
            return;
        }

        busy = true;
        abortController = new AbortController();
        $root.find('#sd_studio_input').val('');
        appendStudioUserMessage(turnSession, text);
        renderAll();

        try {
            const history = buildStudioHistoryMessages(turnSession);
            const result = await requestToolCallsWithRetry(context, { toolCallRetryMax: 0 }, {
                taskMessages: [{ role: 'system', content: systemPrompt }, ...history],
                apiPresetName: preset.llm?.apiPresetName || '',
                llmPresetName: preset.llm?.llmPresetName || '',
                tools: [GENERATE_IMAGE_TOOL],
                allowNoToolCalls: true,
                includeAssistantText: true,
                substituteMacros: true,
                abortSignal: abortController.signal,
            });

            const toolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
            const { images, toolResults } = await executeToolCalls(toolCalls);
            appendStudioAssistantTurn(turnSession, {
                text: result?.assistantText || '',
                toolCalls,
                toolResults,
                images,
            });
            if (session === turnSession) {
                selectedImageId = images.at(-1)?.id || selectedImageId;
            }
            await persistSession(turnSession);
            if (session === turnSession) {
                renderAll();
            }
        } catch (error) {
            if (abortController.signal.aborted) {
                await persistSession(turnSession);
                if (session === turnSession) {
                    renderAll();
                }
                return;
            }
            console.error('Studio turn failed.', error);
            toastr.error(`${t`Studio request failed`}: ${error?.message || error}`, t`Image Generation`);
            if (session === turnSession) {
                renderAll();
            }
        } finally {
            busy = false;
            abortController = null;
            if (!closed && session === turnSession) {
                renderAll();
            }
        }
    }

    $root.find('#sd_studio_send').on('click', async () => {
        if (busy) {
            return;
        }
        const text = String($root.find('#sd_studio_input').val() || '').trim();
        if (!text) {
            return;
        }
        await runTurn(text);
    });

    $root.find('#sd_studio_stop').on('click', () => {
        abortController?.abort('Stopped by user');
    });

    $root.find('#sd_studio_input').on('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            $root.find('#sd_studio_send').trigger('click');
        }
    });

    $root.find('#sd_studio_preset').on('change', async function () {
        if (busy) {
            $(this).val(settings.currentPresetId);
            return;
        }
        const presetId = String($(this).val() || '');
        const preset = getPresetById(settings, presetId);
        if (!preset) {
            return;
        }
        selectPreset(settings, presetId);
        session.presetId = presetId;
        saveSettings();
        await persistSession();
    });

    $root.find('#sd_studio_new').on('click', () => { void newSession(); });

    $root.on('click', '[data-studio-session-id]', async function (event) {
        if ($(event.target).closest('[data-studio-session-delete]').length > 0) {
            return;
        }
        const id = String($(this).attr('data-studio-session-id') || '');
        if (id && id !== session?.id) {
            await loadSession(id);
        }
    });

    $root.on('click', '[data-studio-session-delete]', async function (event) {
        event.stopPropagation();
        if (busy) {
            return;
        }
        const id = String($(this).attr('data-studio-session-delete') || '');
        if (!id) {
            return;
        }
        await storage.deleteSession(SCOPE, id);
        if (session?.id === id) {
            const sessions = await storage.listSessions(SCOPE);
            if (sessions.length > 0) {
                await loadSession(sessions[0].id);
            } else {
                await newSession();
            }
        } else {
            await renderSessionList();
        }
    });

    $root.on('click', '[data-studio-image-id]', function (event) {
        if ($(event.target).closest('[data-studio-action]').length > 0) {
            return;
        }
        selectedImageId = String($(event.target).closest('[data-studio-image-id]').attr('data-studio-image-id') || '');
        renderAll();
    });

    $root.on('click', '[data-studio-action]', async function (event) {
        event.stopPropagation();
        const action = String($(this).attr('data-studio-action') || '');
        const id = String($(this).closest('[data-studio-image-id]').attr('data-studio-image-id') || '');
        const image = session.images.find(entry => entry.id === id);
        if (!image) {
            return;
        }
        if (action === 'zoom') {
            if (image.status === 'failed') {
                return;
            }
            const zoomPopup = new Popup(`<img class="sd_studio_zoom" src="${escapeHtml(image.imageUrl)}" alt="${escapeHtml(image.prompt)}" />`, POPUP_TYPE.DISPLAY, '', {
                wider: true,
                allowVerticalScrolling: true,
            });
            zoomPopup.show();
            return;
        }
        if (action === 'copy') {
            try {
                await navigator.clipboard.writeText(image.prompt);
                toastr.success(t`Prompt copied.`, t`Image Generation`);
            } catch (error) {
                toastr.error(String(error?.message || error), t`Image Generation`);
            }
            return;
        }
        if (action === 'regenerate') {
            try {
                const imageUrl = await imageService.generate(image.prompt);
                const record = {
                    id: makeIllustrationId('img'),
                    prompt: image.prompt,
                    imageUrl,
                    status: 'ready',
                    error: '',
                    createdAt: Date.now(),
                };
                session.images.push(record);
                selectedImageId = record.id;
                await persistSession();
                renderAll();
            } catch (error) {
                toastr.error(`${t`Illustration failed`}: ${error?.message || error}`, t`Image Generation`);
            }
        }
    });

    const sessions = await storage.listSessions(SCOPE);
    if (sessions.length > 0) {
        const loaded = await storage.loadSession(SCOPE, sessions[0].id);
        session = loaded || createStudioSession({ presetId: settings.currentPresetId });
    } else {
        session = createStudioSession({ presetId: settings.currentPresetId });
    }
    selectedImageId = session.images.at(-1)?.id || '';
    renderAll();
    await renderSessionList();

    try {
        await shown;
    } finally {
        closed = true;
        abortController?.abort('Studio closed');
        if (session && session.messages.length > 0) {
            await storage.saveSessionFlush(SCOPE, session);
        }
    }
}
