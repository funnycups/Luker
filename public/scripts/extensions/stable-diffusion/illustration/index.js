import { extension_settings, getContext } from '../../../extensions.js';
import { ensureSwipes, eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { normalizeIllustrationSettings } from './settings.js';
import { initSettingsUi } from './settings-ui.js';
import { initMenus, setIllustrationEnabled } from './menus.js';
import { GenerationQueue } from './queue.js';
import { createImageService } from './image-service.js';
import { createIllustrationPipeline } from './pipeline.js';
import { initIllustrationActions } from './actions.js';
import { clearSwipeIllustrationRecords } from './records.js';
import { buildIllustrationStripRegexScript } from './message.js';
import { emitMessageChanged } from './message-events.js';
import { createStudioSessionStore } from '../lens/studio-store.js';
import { initSdLens } from '../lens/index.js';
import { attachImageActivityDock, getImageActivityStore } from '../activity.js';

let activeIllustrationErrorToast = null;

function clearIllustrationErrorToast() {
    if (!activeIllustrationErrorToast) {
        return;
    }
    try {
        toastr.clear(activeIllustrationErrorToast);
    } catch (error) {
        console.error('[sd] could not clear image generation error toast', error);
    }
    activeIllustrationErrorToast = null;
}

function notifyIllustrationError(message) {
    if (typeof toastr === 'undefined') {
        return;
    }
    clearIllustrationErrorToast();
    const toast = toastr.error(String(message || ''), t`Image Generation`, {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        tapToDismiss: true,
        progressBar: false,
        onHidden: () => {
            if (activeIllustrationErrorToast === toast) {
                activeIllustrationErrorToast = null;
            }
        },
    });
    if (toast?.length) {
        activeIllustrationErrorToast = toast;
    }
}

export async function initIllustration(bridge) {
    const context = getContext();
    const sdSettings = extension_settings.sd;

    const currentProfileId = String(extension_settings.connectionManager?.selectedProfile || '');
    const currentProfile = (context.connectionProfiles?.list?.() || [])
        .find(profile => String(profile.id || '') === currentProfileId);
    const currentLlmPreset = context.getPresetManager?.('openai')?.getSelectedPresetName?.() || '';

    sdSettings.illustration = normalizeIllustrationSettings(sdSettings.illustration, {
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

    if (typeof context.updateGlobalState === 'function') {
        try {
            await createStudioSessionStore(context).migrateLegacySettingsSessionsOnce(
                settings,
                () => saveSettingsDebounced(),
            );
        } catch (error) {
            console.error('[sd] failed to migrate legacy studio sessions to GlobalState:', error);
            notifyIllustrationError(String(error?.message || error));
        }
    }

    attachImageActivityDock(getImageActivityStore(), context);

    let regexRegistration = null;
    if (typeof context.regex?.registerRegexProvider === 'function') {
        regexRegistration = context.regex.registerRegexProvider('sd-illustration', () => (
            settings.enabled
                ? [buildIllustrationStripRegexScript({ placement: context.regex?.placement })]
                : []
        ));
    }

    const settingsUi = await initSettingsUi({
        settings,
        saveSettings: () => saveSettingsDebounced(),
        context,
        onEnabledChange: enabled => {
            setIllustrationEnabled(enabled);
            regexRegistration?.refresh?.();
        },
    });

    const queue = new GenerationQueue({
        maxConcurrent: settings.maxConcurrentGenerations,
        minInterval: settings.minGenerationInterval,
    });
    const imageService = createImageService({
        bridge,
        queue,
        getQueueConfig: () => ({
            maxConcurrent: settings.maxConcurrentGenerations,
            minInterval: settings.minGenerationInterval,
        }),
    });

    initSdLens({
        getContext: () => context,
        imageService,
        getRunStore: () => getImageActivityStore(),
    });
    let actions = null;
    const pipeline = createIllustrationPipeline({
        context,
        imageService,
        settings,
        hooks: {
            toast: (message, type = 'error') => toastr[type]?.(message, t`Image Generation`),
            notifyError: notifyIllustrationError,
            t,
            beginActivityJob: typeof bridge.beginActivityJob === 'function'
                ? options => {
                    clearIllustrationErrorToast();
                    return bridge.beginActivityJob(options);
                }
                : null,
            saveChat: () => context.saveChat(),
            updateMessageBlock: (messageId, message) => context.updateMessageBlock(messageId, message),
            notifyMessageChanged: messageId => emitMessageChanged(context, messageId),
            ensureSwipes,
            getChatId: () => context.chatId,
            getChat: () => context.chat,
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

    const openWorkbenchStudio = () => {
        void context.workbench?.open?.({ ws: 'sd', subview: 'studio' });
    };

    $('#sd_open_workbench_studio').off('click.sdWorkbench').on('click.sdWorkbench', openWorkbenchStudio);

    await initMenus({
        settings,
        onGenerateLast: () => { void pipeline.runForLastAssistantMessage(); },
        onGenerateMessage: messageId => { void pipeline.runForMessage({ messageId, source: 'manual' }); },
        onOpenStudio: openWorkbenchStudio,
    });

    actions = initIllustrationActions({
        context,
        pipeline,
        imageService,
        settings,
        ensureSwipes,
        toast: (message, type = 'error') => toastr[type]?.(message, t`Image Generation`),
        notifyError: notifyIllustrationError,
        t,
    });
}
