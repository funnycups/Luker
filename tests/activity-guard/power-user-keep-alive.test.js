/**
 * @jest-environment jsdom
 */
import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from '../../public/lib/eventemitter.js';
import { createActivityGuardRegistry } from '../../public/scripts/activity-guard.js';
import {
    createMobileKeepAliveController,
    selectRandomCharacter,
} from '../../public/scripts/lib/mobile-keep-alive-controller.js';

const EVENT_TYPES = {
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'generation_after_commands',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
    MESSAGE_RECEIVED: 'message_received',
    IMPERSONATE_READY: 'impersonate_ready',
    GENERATION_STOPPED: 'generation_stopped',
};

function makeChain(overrides = {}) {
    const chain = { length: 0, is: () => false, hasClass: () => false };
    for (const method of ['on', 'off', 'one', 'val', 'text', 'html', 'attr', 'prop', 'css', 'addClass', 'removeClass', 'toggleClass', 'show', 'hide', 'toggle', 'append', 'prepend', 'empty', 'remove', 'find', 'closest', 'children', 'parent', 'filter', 'first', 'last', 'eq', 'each', 'trigger', 'focus', 'blur', 'click', 'data']) {
        chain[method] = () => chain;
    }
    return Object.assign(chain, overrides);
}

describe('mobile keep-alive controller and random chat switch guard', () => {
    let registry;
    let eventSource;
    let powerUser;
    let characters;
    let chat;
    let pipViewStatus;
    let activeKeepAliveMode;
    let pipWindowOpen;
    let updatePipView;
    let setKeepAliveMode;
    let bannerShow;
    let bannerHide;
    let controller;

    beforeEach(() => {
        registry = createActivityGuardRegistry();
        eventSource = new EventEmitter();
        powerUser = {
            luker_mobile_keep_alive_web_audio_enabled: false,
            luker_mobile_keep_alive_web_pip_enabled: false,
            luker_mobile_keep_alive_android_enabled: false,
            luker_mobile_keep_alive_harmony_enabled: false,
            luker_mobile_keep_alive_ios_enabled: false,
        };
        characters = [];
        chat = [];
        pipViewStatus = 'idle';
        activeKeepAliveMode = 'off';
        pipWindowOpen = false;
        updatePipView = jest.fn(({ status }) => {
            if (status) pipViewStatus = status;
        });
        setKeepAliveMode = jest.fn(async (mode) => {
            activeKeepAliveMode = mode;
        });
        bannerShow = jest.fn();
        bannerHide = jest.fn();

        const fallbackChain = makeChain();
        const bannerChain = makeChain({ show: bannerShow, hide: bannerHide });
        const jq = (selector) => (selector === '<button></button>' ? bannerChain : fallbackChain);

        controller = createMobileKeepAliveController({
            getPowerUser: () => powerUser,
            getCharacters: () => characters,
            getChat: () => chat,
            getThisChid: () => undefined,
            getName2: () => 'Assistant',
            getThumbnailUrl: () => '',
            eventSource,
            getEventTypes: () => EVENT_TYPES,
            saveSettingsDebounced: () => {},
            isMobile: () => true,
            shouldSendOnEnter: () => false,
            getActiveKeepAliveMode: () => activeKeepAliveMode,
            getKeepAlivePlatform: () => 'web',
            hasNativeKeepAliveBridge: () => false,
            initKeepAlive: () => {},
            isKeepAliveSupported: () => true,
            isPipWindowOpen: () => pipWindowOpen,
            onKeepAliveStateChanged: () => {},
            setKeepAliveMode,
            setPipPrimingEnabled: () => {},
            getPipViewStatus: () => pipViewStatus,
            updatePipView,
            hasActiveSource: registry.hasActiveSource,
            hasKeepAliveHold: registry.hasKeepAliveHold,
            subscribeActivityGuard: registry.subscribeActivityGuard,
            syncMobileKeepAliveCheckbox: () => {},
            t: (s, ...v) => (Array.isArray(s) ? String.raw(s, ...v) : String(s)),
            getJQuery: () => jq,
            getDocument: () => ({ addEventListener: () => {}, visibilityState: 'visible' }),
            getToastr: () => ({ warning: jest.fn(), error: jest.fn() }),
        });
    });

    afterEach(() => {
        controller.cancelScopedKeepAliveDeactivateTimer();
        jest.useRealTimers();
        const leftover = registry.getActiveActivities();
        if (leftover.length > 0) {
            throw new Error(`Leaked activity leases after test: ${JSON.stringify(leftover)}`);
        }
    });

    test('scopedKeepAliveShouldHold follows hasKeepAliveHold across core, ambient, and plugin leases', () => {
        expect(controller.scopedKeepAliveShouldHold()).toBe(false);

        const relNoKeepAlive = registry.acquireActivityLease({ source: 'test:no-ka', keepAlive: false });
        expect(controller.scopedKeepAliveShouldHold()).toBe(false);
        relNoKeepAlive();

        const relAmbient = registry.acquireActivityLease({ source: 'core:generate-task', ambient: true, keepAlive: true });
        expect(controller.scopedKeepAliveShouldHold()).toBe(true);
        relAmbient();
        expect(controller.scopedKeepAliveShouldHold()).toBe(false);

        const relSd = registry.acquireActivityLease({ source: 'sd:image', scope: 'chat', keepAlive: true });
        expect(controller.scopedKeepAliveShouldHold()).toBe(true);
        relSd();
        expect(controller.scopedKeepAliveShouldHold()).toBe(false);
    });

    test('syncMobileKeepAliveUi subscribes to activityGuard and drives audio keep-alive', () => {
        jest.useFakeTimers();
        powerUser.luker_mobile_keep_alive_web_audio_enabled = true;

        controller.syncMobileKeepAliveUi();

        const release = registry.acquireActivityLease({ source: 'memory-graph:update', scope: 'chat', keepAlive: true });
        try {
            expect(setKeepAliveMode).toHaveBeenCalledWith('audio');
        } finally {
            release();
        }

        jest.advanceTimersByTime(10_000);
        expect(setKeepAliveMode).toHaveBeenCalledWith('off');
    });

    test('PiP generating->done transition ignores memory-graph leases and waits for core:generation and core:group-generation', () => {
        controller.syncMobileKeepAliveUi();

        pipViewStatus = 'generating';
        const relGen = registry.acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        const relMg = registry.acquireActivityLease({ source: 'memory-graph:update', scope: 'chat' });

        relMg();
        expect(updatePipView).not.toHaveBeenCalledWith({ status: 'done' });

        const relMgAfter = registry.acquireActivityLease({ source: 'memory-graph:update', scope: 'chat' });
        relGen();
        expect(updatePipView).toHaveBeenCalledWith({ status: 'done' });
        relMgAfter();

        updatePipView.mockClear();
        pipViewStatus = 'generating';
        const relGroup = registry.acquireActivityLease({ source: 'core:group-generation', scope: 'chat' });
        const relMember = registry.acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        relMember();
        expect(updatePipView).not.toHaveBeenCalledWith({ status: 'done' });
        relGroup();
        expect(updatePipView).toHaveBeenCalledWith({ status: 'done' });
    });

    test('syncPipReopenBanner ignores ambient and core generation sources when idle, and shows for explicit non-core tasks or active PiP generation', () => {
        powerUser.luker_mobile_keep_alive_web_pip_enabled = true;

        const relAmbient = registry.acquireActivityLease({ source: 'core:generate-raw', ambient: true, keepAlive: true });
        try {
            controller.syncPipReopenBanner();
            expect(bannerShow).not.toHaveBeenCalled();
        } finally {
            relAmbient();
        }

        bannerShow.mockClear();
        const relQuiet = registry.acquireActivityLease({ source: 'core:generation-quiet', scope: 'chat', keepAlive: true });
        try {
            controller.syncPipReopenBanner();
            expect(bannerShow).not.toHaveBeenCalled();
        } finally {
            relQuiet();
        }

        bannerShow.mockClear();
        const relSd = registry.acquireActivityLease({ source: 'sd:image', scope: 'chat', keepAlive: true });
        try {
            bannerShow.mockClear();
            controller.syncPipReopenBanner();
            expect(bannerShow).toHaveBeenCalledTimes(1);
        } finally {
            relSd();
        }

        bannerHide.mockClear();
        controller.syncPipReopenBanner();
        expect(bannerHide).toHaveBeenCalledTimes(1);

        bannerShow.mockClear();
        pipViewStatus = 'generating';
        controller.syncPipReopenBanner();
        expect(bannerShow).toHaveBeenCalledTimes(1);
    });

    test('PiP feed triggers generating on GENERATION_AFTER_COMMANDS rather than GENERATION_STARTED and returns to done on lease release', () => {
        controller.syncMobileKeepAliveUi();

        eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
        expect(pipViewStatus).toBe('idle');
        expect(updatePipView).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'generating' }));

        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, true);
        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'quiet', {}, false);
        expect(pipViewStatus).toBe('idle');

        const releaseGen = registry.acquireActivityLease({ source: 'core:generation', scope: 'chat' });
        eventSource.emit(EVENT_TYPES.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        expect(pipViewStatus).toBe('generating');
        expect(updatePipView).toHaveBeenCalledWith({ status: 'generating', text: '' });

        releaseGen();
        expect(pipViewStatus).toBe('done');
        expect(updatePipView).toHaveBeenCalledWith({ status: 'done' });
    });

    test('selectRandomCharacter routes through selectCharacterById and respects switch cancellation', async () => {
        const list = [{ name: 'Alice', avatar: 'alice.png' }];
        const selectCharacterById = jest.fn();
        const setActiveCharacter = jest.fn();
        const setActiveGroup = jest.fn();

        selectCharacterById.mockResolvedValueOnce(false);
        await expect(selectRandomCharacter({
            tagName: '',
            characters: list,
            tagMap: {},
            findTagIdByName: () => undefined,
            selectCharacterById,
            setActiveCharacter,
            setActiveGroup,
            onEmpty: jest.fn(),
        })).resolves.toBe('');
        expect(selectCharacterById).toHaveBeenCalledWith('0');
        expect(setActiveCharacter).not.toHaveBeenCalled();
        expect(setActiveGroup).not.toHaveBeenCalled();

        const order = [];
        selectCharacterById.mockImplementationOnce(async (id) => {
            order.push(['select', id]);
            return true;
        });
        setActiveCharacter.mockImplementationOnce((avatar) => order.push(['activeChar', avatar]));
        setActiveGroup.mockImplementationOnce((grp) => order.push(['activeGroup', grp]));

        await expect(selectRandomCharacter({
            tagName: '',
            characters: list,
            tagMap: {},
            findTagIdByName: () => undefined,
            selectCharacterById,
            setActiveCharacter,
            setActiveGroup,
            onEmpty: jest.fn(),
        })).resolves.toBe('Alice');
        expect(order).toEqual([
            ['select', '0'],
            ['activeChar', 'alice.png'],
            ['activeGroup', null],
        ]);
    });
});
