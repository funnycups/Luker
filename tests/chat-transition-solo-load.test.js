// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from '@jest/globals';
import { createChatTransitionCoordinator } from '../public/scripts/lib/chat-transition-coordinator.js';

function makeCoordinator() {
    return createChatTransitionCoordinator({
        isGenerating: () => false,
        hasActiveMessageEdit: () => false,
        getStreamingProcessor: () => null,
        clearStreamingProcessorIfSame: () => {},
        stopGeneration: () => {},
        confirmPopup: async () => true,
        escapeHtml: (s) => String(s),
        t: (strings, ...values) => String.raw({ raw: strings }, ...values),
        translate: (s) => s,
    });
}

describe('chatTransitionCoordinator solo chat load guards', () => {
    test('newer solo chat load invalidates an earlier in-flight load and protects chatTransitionInProgress', () => {
        const coordinator = makeCoordinator();

        coordinator.beginChatTransition();
        let activeAvatar = 'alice.png';
        const loadA = coordinator.beginSoloChatLoad(() => activeAvatar === 'alice.png');
        expect(loadA.isCurrent()).toBe(true);
        expect(coordinator.isChatTransitionInProgress()).toBe(true);

        // User switches to Bob before Alice finishes loading
        coordinator.beginChatTransition();
        activeAvatar = 'bob.png';
        const loadB = coordinator.beginSoloChatLoad(() => activeAvatar === 'bob.png');

        expect(loadA.isCurrent()).toBe(false);
        expect(loadB.isCurrent()).toBe(true);

        // Late failure or completion from Alice must NOT clear Bob's transition flag
        expect(loadA.endTransition()).toBe(false);
        expect(coordinator.isChatTransitionInProgress()).toBe(true);

        // Bob finishing clears the transition flag
        expect(loadB.endTransition()).toBe(true);
        expect(coordinator.isChatTransitionInProgress()).toBe(false);
    });

    test('starting a second solo load without an intervening epoch bump still invalidates the first', () => {
        const coordinator = makeCoordinator();
        const first = coordinator.beginSoloChatLoad();
        const second = coordinator.beginSoloChatLoad();

        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
    });

    test('bumping chat transition epoch (e.g. group switch or close chat) invalidates an active solo load', () => {
        const coordinator = makeCoordinator();
        coordinator.beginChatTransition();
        const soloLoad = coordinator.beginSoloChatLoad();
        expect(soloLoad.isCurrent()).toBe(true);

        coordinator.bumpChatTransitionEpoch();
        expect(soloLoad.isCurrent()).toBe(false);
        expect(soloLoad.endTransition()).toBe(false);
        expect(coordinator.isChatTransitionInProgress()).toBe(true);
    });

    test('endChatTransition with a stale expectedEpoch does not clear a newer transition', () => {
        const coordinator = makeCoordinator();
        coordinator.beginChatTransition();
        const epochA = coordinator.getChatTransitionEpoch();

        coordinator.beginChatTransition();
        const epochB = coordinator.getChatTransitionEpoch();

        expect(coordinator.endChatTransition(epochA)).toBe(false);
        expect(coordinator.isChatTransitionInProgress()).toBe(true);

        expect(coordinator.endChatTransition(epochB)).toBe(true);
        expect(coordinator.isChatTransitionInProgress()).toBe(false);
    });
});
