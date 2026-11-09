import { extension_settings, getContext } from '../../../extensions.js';
import { ensureSwipes, eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { normalizeIllustrationSettings, imageConfigFingerprint } from './settings.js';
import { initSettingsUi } from './settings-ui.js';
import { initMenus, setIllustrationEnabled } from './menus.js';
import { GenerationQueue } from './queue.js';
import { createImageService } from './image-service.js';
import { createIllustrationPipeline } from './pipeline.js';
import { initIllustrationActions } from './actions.js';
import { clearSwipeIllustrationRecords } from './records.js';
import { openIllustrationStudio } from './studio/index.js';
import { stripIllustrationMarkup } from './message.js';

export async function initIllustration(bridge) {
    const context = getContext();
    const sdSettings = extension_settings.sd;

    const currentProfileId = String(extension_settings.connectionManager?.selectedProfile || '');
    const currentProfile = (context.connectionProfiles?.list?.() || [])
        .find(profile => String(profile.id || '') === currentProfileId);
    const currentLlmPreset = context.getPresetManager?.('openai')?.getSelectedPresetName?.() || '';

    sdSettings.illustration = normalizeIllustrationSettings(sdSettings.illustration, {
        imageConfig: bridge.readImageConfig(),
        llm: {
            apiPresetName: String(currentProfile?.name || ''),
            llmPresetName: String(currentLlmPreset || ''),
        },
        presetNames: {
            tagStyle: t`Tag style`,
            naturalStyle: t`Natural language style`,
        },
    });
    const settings = sdSettings.illustration;

    const settingsUi = await initSettingsUi({
        bridge,
        settings,
        saveSettings: () => saveSettingsDebounced(),
        context,
        onEnabledChange: setIllustrationEnabled,
    });

    const queue = new GenerationQueue({
        maxConcurrent: settings.maxConcurrentGenerations,
        minInterval: settings.minGenerationInterval,
    });
    const imageService = createImageService({
        bridge,
        queue,
        readImageConfig: () => bridge.readImageConfig(),
        fingerprint: config => imageConfigFingerprint(config),
        getQueueConfig: () => ({
            maxConcurrent: settings.maxConcurrentGenerations,
            minInterval: settings.minGenerationInterval,
        }),
    });
    let actions = null;
    const pipeline = createIllustrationPipeline({
        context,
        imageService,
        settings,
        hooks: {
            toast: (message, type = 'error') => toastr[type]?.(message, t`Image Generation`),
            t,
            saveChat: () => context.saveChat(),
            updateMessageBlock: (messageId, message) => context.updateMessageBlock(messageId, message),
            ensureSwipes,
            getChatId: () => context.chatId,
            getChat: () => context.chat,
            imageConfigFingerprint: () => imageConfigFingerprint(bridge.readImageConfig()),
            confirmReplace: async () => {
                const result = await callGenericPopup(
                    t`This message already has illustrations. Replace them?`,
                    POPUP_TYPE.CONFIRM,
                );
                return Number(result) === 1;
            },
        },
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        void pipeline.handleMessageReceived(messageId, type);
    });

    eventSource.on(event_types.MESSAGE_SWIPED, (messageId, payload) => {
        const id = Number(messageId);
        pipeline.cancelForMessage(id);
        actions?.cancelForMessage(id);
        if (payload?.pendingGeneration) {
            clearSwipeIllustrationRecords(context.chat?.[id]);
        }
    });
    eventSource.on(event_types.MESSAGE_DELETED, chatLength => {
        const length = Number(chatLength);
        pipeline.cancelInvalidJobs(length);
        actions?.cancelFrom(length);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        pipeline.cancelAll();
        actions?.cancelAll();
    });

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, eventData => {
        if (!Array.isArray(eventData?.chat)) {
            return;
        }
        for (const message of eventData.chat) {
            if (typeof message?.content === 'string' && message.content.includes('data-illustration-id')) {
                message.content = stripIllustrationMarkup(message.content);
            }
        }
    });

    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, eventData => {
        if (typeof eventData?.prompt === 'string' && eventData.prompt.includes('data-illustration-id')) {
            eventData.prompt = stripIllustrationMarkup(eventData.prompt);
        }
    });

    for (const event of [event_types.PRESET_CHANGED, event_types.PRESET_RENAMED, event_types.PRESET_DELETED]) {
        eventSource.on(event, () => {
            settingsUi.refreshLlmPresetOptions();
        });
    }
    for (const event of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_UPDATED, event_types.CONNECTION_PROFILE_DELETED]) {
        eventSource.on(event, () => {
            settingsUi.refreshConnectionOptions();
        });
    }

    await initMenus({
        settings,
        onGenerateLast: () => { void pipeline.runForLastAssistantMessage(); },
        onGenerateMessage: messageId => { void pipeline.runForMessage({ messageId, source: 'manual' }); },
        onOpenStudio: () => {
            void openIllustrationStudio({
                context,
                settings,
                bridge,
                imageService,
                saveSettings: () => saveSettingsDebounced(),
            });
        },
    });

    actions = initIllustrationActions({
        context,
        pipeline,
        imageService,
        settings,
        fingerprint: () => imageConfigFingerprint(bridge.readImageConfig()),
        ensureSwipes,
        toast: (message, type = 'error') => toastr[type]?.(message, t`Image Generation`),
        t,
    });
}
