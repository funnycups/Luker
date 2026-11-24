/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from '@jest/globals';

import {
    CAPSULE_STACK_GAP_PX,
    DECK_COLLAPSE_GAP_PX,
    DECK_EXPANDED_GAP_PX,
    DRAG_THRESHOLD_PX,
    VIEWPORT_EDGE_MARGIN_PX,
    clampToastPosition,
    computeAnchoredRect,
    computeDeckLayout,
    computeParkedCapsulePositions,
    extractCapsuleLabel,
    resolveCapsuleParkingSide,
    resolveToastPolicy,
} from '../public/scripts/luker-toast-layout.js';

describe('luker-toast-layout constants', () => {
    test('exports spec-defined geometry constants', () => {
        expect(DRAG_THRESHOLD_PX).toBe(6);
        expect(VIEWPORT_EDGE_MARGIN_PX).toBe(8);
        expect(DECK_COLLAPSE_GAP_PX).toBe(10);
        expect(DECK_EXPANDED_GAP_PX).toBe(8);
        expect(CAPSULE_STACK_GAP_PX).toBe(8);
    });
});

describe('resolveToastPolicy', () => {
    test('classifies ordinary timed toast as closable and non-minimizable', () => {
        const policy = resolveToastPolicy(
            { timeOut: 4000, extendedTimeOut: 10000, tapToDismiss: true, closeButton: false },
            {},
        );
        expect(policy).toEqual({
            rawTimeOut: 4000,
            effectiveExtendedTimeOut: 10000,
            isPersistent: false,
            isClosable: true,
            isMinimizable: false,
            canTapToDismiss: true,
        });
    });

    test('treats timeOut: 0 with inherited global extendedTimeOut as persistent', () => {
        const policy = resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 10000, tapToDismiss: true, closeButton: false },
            { timeOut: 0 },
        );
        expect(policy).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 0,
            isPersistent: true,
            isClosable: true,
            isMinimizable: true,
            canTapToDismiss: true,
        });
    });

    test('honors explicit positive extendedTimeOut in optionsOverride on timeOut: 0', () => {
        const policy = resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 5000, tapToDismiss: true, closeButton: false },
            { timeOut: 0, extendedTimeOut: 5000 },
        );
        expect(policy).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 5000,
            isPersistent: false,
            isClosable: true,
            isMinimizable: false,
            canTapToDismiss: true,
        });
    });

    test('classifies ongoing task (timeOut: 0, tapToDismiss: false) as non-closable and minimizable', () => {
        const policy = resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: false },
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false },
        );
        expect(policy).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 0,
            isPersistent: true,
            isClosable: false,
            isMinimizable: true,
            canTapToDismiss: false,
        });
    });

    test('classifies sticky notice (timeOut: 0, tapToDismiss: true, closeButton: true) as closable and minimizable', () => {
        const policy = resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: true, closeButton: true },
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: true, closeButton: true },
        );
        expect(policy).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 0,
            isPersistent: true,
            isClosable: true,
            isMinimizable: true,
            canTapToDismiss: true,
        });
    });

    test('classifies PromptManager undo (timeOut: 0, tapToDismiss: false, closeButton: true) as closable without body tap', () => {
        const policy = resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true },
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true },
        );
        expect(policy).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 0,
            isPersistent: true,
            isClosable: true,
            isMinimizable: true,
            canTapToDismiss: false,
        });
    });

    test('honors explicit closable and minimizable boolean overrides', () => {
        expect(resolveToastPolicy(
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: true, closeButton: true, closable: false, minimizable: false },
            { timeOut: 0, closable: false, minimizable: false },
        )).toEqual({
            rawTimeOut: 0,
            effectiveExtendedTimeOut: 0,
            isPersistent: true,
            isClosable: false,
            isMinimizable: false,
            canTapToDismiss: false,
        });

        expect(resolveToastPolicy(
            { timeOut: 4000, extendedTimeOut: 10000, tapToDismiss: true, minimizable: true },
            { minimizable: true },
        )).toEqual({
            rawTimeOut: 4000,
            effectiveExtendedTimeOut: 10000,
            isPersistent: false,
            isClosable: true,
            isMinimizable: true,
            canTapToDismiss: true,
        });
    });
});

describe('clampToastPosition', () => {
    test('clamps coordinates inside viewport and top safe inset', () => {
        expect(clampToastPosition({
            x: -50,
            y: 4,
            width: 320,
            height: 80,
            viewportWidth: 1280,
            viewportHeight: 800,
            topSafeInset: 44,
        })).toEqual({ x: 8, y: 44 });

        expect(clampToastPosition({
            x: 1200,
            y: 780,
            width: 320,
            height: 80,
            viewportWidth: 1280,
            viewportHeight: 800,
            topSafeInset: 44,
        })).toEqual({ x: 952, y: 712 });
    });

    test('handles narrow mobile viewports where element width fills available width', () => {
        expect(clampToastPosition({
            x: 50,
            y: 900,
            width: 390,
            height: 100,
            viewportWidth: 390,
            viewportHeight: 844,
            topSafeInset: 40,
            edgeMargin: 8,
        })).toEqual({ x: 8, y: 736 });
    });
});

describe('resolveCapsuleParkingSide & computeParkedCapsulePositions', () => {
    test('parks on left only when dock is toast-top-right, otherwise right', () => {
        expect(resolveCapsuleParkingSide('toast-top-right')).toBe('left');
        expect(resolveCapsuleParkingSide('toast-top-center')).toBe('right');
        expect(resolveCapsuleParkingSide('toast-top-left')).toBe('right');
        expect(resolveCapsuleParkingSide('toast-top-full-width')).toBe('right');
        expect(resolveCapsuleParkingSide('toast-bottom-left')).toBe('right');
        expect(resolveCapsuleParkingSide('toast-bottom-center')).toBe('right');
        expect(resolveCapsuleParkingSide('toast-bottom-right')).toBe('right');
    });

    test('stacks 3 capsules vertically at right edge with 8px gap', () => {
        const placed = computeParkedCapsulePositions({
            capsules: [
                { id: 1, width: 160, height: 32 },
                { id: 2, width: 180, height: 32 },
                { id: 3, width: 140, height: 32 },
            ],
            positionClass: 'toast-top-center',
            viewportWidth: 1200,
            viewportHeight: 800,
            topSafeInset: 48,
            occupiedRects: [],
        });

        expect(placed).toEqual([
            { id: 1, x: 1028, y: 48 },
            { id: 2, x: 1008, y: 88 },
            { id: 3, x: 1048, y: 128 },
        ]);
    });

    test('parks at left edge for toast-top-right and steps past occupied custom rects', () => {
        const placed = computeParkedCapsulePositions({
            capsules: [
                { id: 1, width: 160, height: 32 },
                { id: 2, width: 160, height: 32 },
            ],
            positionClass: 'toast-top-right',
            viewportWidth: 1200,
            viewportHeight: 800,
            topSafeInset: 48,
            occupiedRects: [
                { left: 12, top: 48, right: 172, bottom: 80 },
            ],
        });

        expect(placed).toEqual([
            { id: 1, x: 12, y: 88 },
            { id: 2, x: 12, y: 128 },
        ]);
    });
});

describe('computeAnchoredRect', () => {
    test('right-aligns when anchor is closer to right edge and clamps within viewport', () => {
        const pos = computeAnchoredRect({
            anchorRect: { left: 860, top: 120, right: 1180, bottom: 190 },
            targetWidth: 160,
            targetHeight: 32,
            viewportWidth: 1200,
            viewportHeight: 800,
            topSafeInset: 44,
        });
        expect(pos).toEqual({ x: 1020, y: 120 });
    });

    test('left-aligns when anchor is closer to left edge and clamps expanded card', () => {
        const pos = computeAnchoredRect({
            anchorRect: { left: 20, top: 750, right: 180, bottom: 782 },
            targetWidth: 340,
            targetHeight: 110,
            viewportWidth: 1200,
            viewportHeight: 800,
            topSafeInset: 44,
        });
        expect(pos).toEqual({ x: 20, y: 682 });
    });
});

describe('computeDeckLayout', () => {
    const fiveItems = [
        { id: 1, height: 64 },
        { id: 2, height: 90 },
        { id: 3, height: 70 },
        { id: 4, height: 60 },
        { id: 5, height: 60 },
    ];

    test('computes collapsed top-anchored deck with front clipping and hiding beyond 3', () => {
        const layout = computeDeckLayout({
            items: fiveItems,
            expanded: false,
            positionClass: 'toast-top-center',
        });

        expect(layout).toEqual([
            { id: 1, index: 0, offsetY: 0, scale: 1, opacity: 1, zIndex: 100, pointerEvents: 'auto', clipHeight: null },
            { id: 2, index: 1, offsetY: 10, scale: 0.95, opacity: 0.92, zIndex: 99, pointerEvents: 'auto', clipHeight: 64 },
            { id: 3, index: 2, offsetY: 20, scale: 0.9, opacity: 0.82, zIndex: 98, pointerEvents: 'auto', clipHeight: 64 },
            { id: 4, index: 3, offsetY: 26, scale: 0.86, opacity: 0, zIndex: 97, pointerEvents: 'none', clipHeight: 64 },
            { id: 5, index: 4, offsetY: 26, scale: 0.86, opacity: 0, zIndex: 96, pointerEvents: 'none', clipHeight: 64 },
        ]);
    });

    test('inverts offset direction for bottom-anchored collapsed deck', () => {
        const layout = computeDeckLayout({
            items: fiveItems.slice(0, 4),
            expanded: false,
            positionClass: 'toast-bottom-right',
        });

        expect(layout.map(x => x.offsetY)).toEqual([0, -10, -20, -26]);
    });

    test('computes cumulative expanded offsets for top and bottom anchors', () => {
        const three = [
            { id: 1, height: 60 },
            { id: 2, height: 80 },
            { id: 3, height: 50 },
        ];

        const topLayout = computeDeckLayout({
            items: three,
            expanded: true,
            positionClass: 'toast-top-center',
        });
        expect(topLayout).toEqual([
            { id: 1, index: 0, offsetY: 0, scale: 1, opacity: 1, zIndex: 100, pointerEvents: 'auto', clipHeight: null },
            { id: 2, index: 1, offsetY: 68, scale: 1, opacity: 1, zIndex: 99, pointerEvents: 'auto', clipHeight: null },
            { id: 3, index: 2, offsetY: 156, scale: 1, opacity: 1, zIndex: 98, pointerEvents: 'auto', clipHeight: null },
        ]);

        const bottomLayout = computeDeckLayout({
            items: three,
            expanded: true,
            positionClass: 'toast-bottom-center',
        });
        expect(bottomLayout.map(x => x.offsetY)).toEqual([0, -68, -156]);
    });
});

describe('extractCapsuleLabel', () => {
    test('prefers message text, strips interactive button text, and collapses whitespace', () => {
        const titleEl = document.createElement('div');
        titleEl.textContent = 'Memory Graph';

        const messageEl = document.createElement('div');
        messageEl.innerHTML = '<div class="luker-rpg-memory-toast-text">  Extracting   batch 2/3  </div><button type="button" class="luker-toast-stop-button">Stop</button>';

        expect(extractCapsuleLabel({ titleEl, messageEl, fallbackLabel: 'Info' })).toBe('Extracting batch 2/3');
    });

    test('strips action-loader-stop icon text and undo button text', () => {
        const messageEl = document.createElement('div');
        messageEl.innerHTML = '<span>Recomputing vectors</span><span class="action-loader-stop">Cancel</span><button class="prompt-manager-toggle-undo-button">Undo</button>';

        expect(extractCapsuleLabel({ titleEl: null, messageEl, fallbackLabel: 'Info' })).toBe('Recomputing vectors');
    });

    test('falls back to title and then fallbackLabel when message has no text', () => {
        const titleEl = document.createElement('div');
        titleEl.textContent = '  Upload is processing  ';
        const emptyMessageEl = document.createElement('div');
        emptyMessageEl.innerHTML = '<button>Stop</button>';

        expect(extractCapsuleLabel({ titleEl, messageEl: emptyMessageEl, fallbackLabel: 'Info' })).toBe('Upload is processing');
        expect(extractCapsuleLabel({ titleEl: null, messageEl: emptyMessageEl, fallbackLabel: 'Notification' })).toBe('Notification');
    });
});
