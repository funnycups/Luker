// SPDX-License-Identifier: AGPL-3.0-or-later

const SCOPED_KEEP_ALIVE_DEACTIVATE_GRACE_MS = 10000;
const PIP_REOPEN_SELECTOR = '#send_but, #mes_continue, #mes_impersonate, #option_regenerate, #option_continue, #option_impersonate, .swipe_right';

/**
 * Pure controller for mobile keep-alive modes, PiP feed status, and restore banner.
 */
export function createMobileKeepAliveController({
    getPowerUser,
    getCharacters,
    getChat,
    getThisChid,
    getName2,
    getThumbnailUrl,
    eventSource,
    getEventTypes,
    saveSettingsDebounced,
    isMobile,
    shouldSendOnEnter,
    getActiveKeepAliveMode,
    getKeepAlivePlatform,
    hasNativeKeepAliveBridge,
    initKeepAlive,
    isKeepAliveSupported,
    isPipWindowOpen,
    onKeepAliveStateChanged,
    setKeepAliveMode,
    setPipPrimingEnabled,
    getPipViewStatus,
    updatePipView,
    hasActiveSource,
    hasKeepAliveHold,
    subscribeActivityGuard,
    syncMobileKeepAliveCheckbox,
    t,
    getJQuery = () => globalThis.$,
    getDocument = () => globalThis.document,
    getToastr = () => globalThis.toastr,
}) {
    let scopedKeepAliveDeactivateTimer = null;
    let pipReopenBanner = null;
    let pipGenerationStopped = false;
    let initialized = false;

    function getScopedKeepAliveMode() {
        const power_user = getPowerUser();
        const platform = getKeepAlivePlatform();
        if (platform === 'web' && power_user.luker_mobile_keep_alive_web_audio_enabled) return 'audio';
        if (platform === 'harmony' && power_user.luker_mobile_keep_alive_harmony_enabled) return 'harmony';
        if (platform === 'ios' && power_user.luker_mobile_keep_alive_ios_enabled) return 'ios';
        return null;
    }

    function scopedKeepAliveShouldHold() {
        return hasKeepAliveHold();
    }

    function scopedKeepAliveActivationSync() {
        const mode = getScopedKeepAliveMode();
        if (!mode) return;
        if (scopedKeepAliveShouldHold()) {
            if (scopedKeepAliveDeactivateTimer) {
                clearTimeout(scopedKeepAliveDeactivateTimer);
                scopedKeepAliveDeactivateTimer = null;
            }
            if (getActiveKeepAliveMode() !== mode) {
                setKeepAliveMode(mode).catch((error) => {
                    console.warn(`[Luker] Failed to enter ${mode} keep-alive`, error);
                });
            } else if (mode === 'harmony' || mode === 'ios') {
                setKeepAliveMode(mode).catch((error) => {
                    console.warn(`[Luker] Failed to renew ${mode} keep-alive`, error);
                });
            }
        } else if (!scopedKeepAliveDeactivateTimer) {
            scopedKeepAliveDeactivateTimer = setTimeout(() => {
                scopedKeepAliveDeactivateTimer = null;
                if (scopedKeepAliveShouldHold()) return;
                const active = getActiveKeepAliveMode();
                if (active === 'audio' || active === 'harmony' || active === 'ios') {
                    setKeepAliveMode('off').catch((error) => {
                        console.warn(`[Luker] Failed to exit ${active} keep-alive`, error);
                    });
                }
            }, SCOPED_KEEP_ALIVE_DEACTIVATE_GRACE_MS);
        }
    }

    function cancelScopedKeepAliveDeactivateTimer() {
        if (scopedKeepAliveDeactivateTimer) {
            clearTimeout(scopedKeepAliveDeactivateTimer);
            scopedKeepAliveDeactivateTimer = null;
        }
    }

    function reopenPipFromGesture() {
        const power_user = getPowerUser();
        if (getKeepAlivePlatform() !== 'web' || !power_user.luker_mobile_keep_alive_web_pip_enabled) return;
        if (isPipWindowOpen()) return;
        setKeepAliveMode('pip')
            .then(() => {
                syncMobileKeepAliveCheckbox();
                syncPipReopenBanner();
            })
            .catch((error) => {
                console.warn('[Luker] Failed to reopen PiP keep-alive', error);
            });
    }

    function reopenPipOnGenerationTap(event) {
        if (event.isTrusted === false) return;
        if (typeof Element === 'undefined' || !(event.target instanceof Element) || !event.target.closest(PIP_REOPEN_SELECTOR)) return;
        reopenPipFromGesture();
    }

    function reopenPipOnGenerationKey(event) {
        if (event.isTrusted === false || event.isComposing || event.key !== 'Enter') return;
        if (event.shiftKey || event.ctrlKey || event.altKey) return;
        if (typeof Element === 'undefined' || !(event.target instanceof Element) || !event.target.closest('#send_textarea')) return;
        if (!shouldSendOnEnter()) return;
        reopenPipFromGesture();
    }

    function ensurePipReopenBanner() {
        if (pipReopenBanner) return pipReopenBanner;
        const $ = getJQuery();
        pipReopenBanner = $('<button></button>')
            .attr({ id: 'luker_pip_reopen', type: 'button' })
            .addClass('menu_button')
            .text(t`Restore Picture-in-Picture`)
            .css({
                position: 'fixed',
                left: '50%',
                bottom: 'calc(88px + env(safe-area-inset-bottom, 0px))',
                transform: 'translateX(-50%)',
                zIndex: 40000,
                display: 'none',
            })
            .on('click', () => {
                setKeepAliveMode('pip')
                    .then(() => {
                        syncMobileKeepAliveCheckbox();
                        syncPipReopenBanner();
                    })
                    .catch((error) => {
                        console.warn('[Luker] Failed to restore PiP keep-alive', error);
                        getToastr()?.warning(t`Picture-in-Picture could not be restored. Tap the page and try again.`);
                    });
            });
        $('body').append(pipReopenBanner);
        return pipReopenBanner;
    }

    function syncPipReopenBanner() {
        const power_user = getPowerUser();
        const visibleGeneration = getPipViewStatus() === 'generating'
            || hasKeepAliveHold({
                excludeAmbient: true,
                excludeSources: ['core:generation', 'core:generation-quiet', 'core:group-generation'],
            });
        const shouldShow = getKeepAlivePlatform() === 'web'
            && !!power_user.luker_mobile_keep_alive_web_pip_enabled
            && visibleGeneration
            && !isPipWindowOpen();
        if (!shouldShow) {
            pipReopenBanner?.hide();
            return;
        }
        ensurePipReopenBanner().show();
    }

    function syncPipViewCharacter() {
        const this_chid = getThisChid();
        const characters = getCharacters();
        const character = this_chid !== undefined ? characters[this_chid] : null;
        updatePipView({
            name: character?.name || getName2() || '',
            avatarUrl: character?.avatar ? getThumbnailUrl('avatar', character.avatar) : '',
        });
    }

    function onActivityGuardChanged() {
        scopedKeepAliveActivationSync();
        if (!hasActiveSource('core:generation') && !hasActiveSource('core:group-generation') && !pipGenerationStopped && getPipViewStatus() === 'generating') {
            updatePipView({ status: 'done' });
        }
        syncPipReopenBanner();
    }

    function initPipViewFeed() {
        const event_types = getEventTypes();
        pipGenerationStopped = false;
        syncPipViewCharacter();
        eventSource.on(event_types.CHAT_CHANGED, () => {
            pipGenerationStopped = false;
            syncPipViewCharacter();
            updatePipView({ status: 'idle', text: '' });
            syncPipReopenBanner();
        });
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, (type, _params, dryRun) => {
            if (dryRun || type === 'quiet') return;
            pipGenerationStopped = false;
            syncPipViewCharacter();
            updatePipView({ status: 'generating', text: '' });
            syncPipReopenBanner();
        });
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, (text) => {
            if (pipGenerationStopped) return;
            updatePipView({ status: 'generating', text: String(text || '') });
        });
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
            if (pipGenerationStopped) return;
            const message = getChat()[messageId];
            if (!message || message.is_user) return;
            updatePipView({ name: message.name || getName2() || '', status: 'done', text: String(message.mes || '') });
            syncPipReopenBanner();
        });
        eventSource.on(event_types.IMPERSONATE_READY, (text) => {
            pipGenerationStopped = false;
            updatePipView({ status: 'done', text: String(text || '') });
            syncPipReopenBanner();
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            pipGenerationStopped = true;
            updatePipView({ status: 'stopped' });
            syncPipReopenBanner();
        });
    }

    function syncMobileKeepAliveUi() {
        const $ = getJQuery();
        const doc = getDocument();
        const power_user = getPowerUser();
        if (!isMobile() && !hasNativeKeepAliveBridge()) {
            $('#luker_mobile_keep_alive').closest('label.checkbox_label').hide();
            return;
        }

        if (!initialized) {
            initKeepAlive();
            setPipPrimingEnabled(!!power_user.luker_mobile_keep_alive_web_pip_enabled);
            subscribeActivityGuard(onActivityGuardChanged);
            doc?.addEventListener?.('click', reopenPipOnGenerationTap, true);
            doc?.addEventListener?.('keydown', reopenPipOnGenerationKey, true);
            doc?.addEventListener?.('visibilitychange', () => {
                if (doc.visibilityState === 'visible') syncPipReopenBanner();
            });
            initPipViewFeed();
            onKeepAliveStateChanged(() => {
                const active = getActiveKeepAliveMode();
                const platform = getKeepAlivePlatform();
                if (platform === 'android') {
                    power_user.luker_mobile_keep_alive_android_enabled = active === 'android';
                    saveSettingsDebounced();
                }
                syncMobileKeepAliveCheckbox();
                syncPipReopenBanner();
            });
            initialized = true;
        }

        const supported = isKeepAliveSupported();
        const $row = $('#luker_mobile_keep_alive').closest('label.checkbox_label');
        $row.toggle(supported);
        syncMobileKeepAliveCheckbox();
        syncPipReopenBanner();

        if (!supported) return;

        const platform = getKeepAlivePlatform();
        if (
            platform === 'android'
            && power_user.luker_mobile_keep_alive_android_enabled
            && getActiveKeepAliveMode() !== 'android'
        ) {
            setKeepAliveMode('android')
                .then(syncMobileKeepAliveCheckbox)
                .catch((error) => {
                    console.warn('[Luker] Failed to restore Android background keep-alive', error);
                });
        }
    }

    return {
        scopedKeepAliveShouldHold,
        scopedKeepAliveActivationSync,
        cancelScopedKeepAliveDeactivateTimer,
        syncPipReopenBanner,
        syncMobileKeepAliveUi,
    };
}

/**
 * Selects a random character (optionally filtered by tag) through selectCharacterById
 * so chat-switch confirmation guards are respected before active markers update.
 */
export async function selectRandomCharacter({
    tagName,
    characters,
    tagMap,
    findTagIdByName,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    onEmpty = () => globalThis.toastr?.error('No characters found'),
    random = Math.random,
}) {
    function getRandomCharacterId() {
        if (!tagName) {
            if (!characters.length) {
                return undefined;
            }
            return Math.floor(random() * characters.length).toString();
        }

        const tagId = findTagIdByName(tagName);
        const taggedCharacters = Object.entries(tagMap)
            .filter(x => x[1].includes(tagId))
            .map(x => x[0])
            .filter(x => characters.find(y => y.avatar === x));
        const randomCharacter = taggedCharacters[Math.floor(random() * taggedCharacters.length)];
        const randomIndex = characters.findIndex(x => x.avatar === randomCharacter);
        if (randomIndex === -1) {
            return undefined;
        }
        return randomIndex.toString();
    }

    const characterId = getRandomCharacterId();
    if (!characterId || characters[characterId] === undefined) {
        onEmpty();
        return;
    }
    if (!await selectCharacterById(characterId)) {
        return '';
    }
    setActiveCharacter(characters[characterId]?.avatar);
    setActiveGroup(null);
    return characters[characterId]?.name;
}
