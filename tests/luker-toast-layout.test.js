/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from '@jest/globals';

import {
    CAPSULE_STACK_GAP_PX,
    DECK_COLLAPSE_GAP_PX,
    DECK_EXPANDED_GAP_PX,
    DECK_FAN_STEP_X_PX,
    DRAG_THRESHOLD_PX,
    VIEWPORT_EDGE_MARGIN_PX,
    clampToastPosition,
    computeAnchoredRect,
    computeDeckLayout,
    computeParkedCapsulePositions,
    extractCapsuleLabel,
    resolveCapsuleParkingSide,
    resolveDeckFanDirection,
    resolveToastPolicy,
    summarizeBehindSeverities,
} from '../public/scripts/luker-toast-layout.js';

describe('luker-toast-layout constants', () => {
    test('exports spec-defined geometry constants', () => {
        expect(DRAG_THRESHOLD_PX).toBe(6);
        expect(VIEWPORT_EDGE_MARGIN_PX).toBe(8);
        expect(DECK_COLLAPSE_GAP_PX).toBe(8);
        expect(DECK_FAN_STEP_X_PX).toBe(8);
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

describe('resolveDeckFanDirection & summarizeBehindSeverities', () => {
    test('fans rightward for left-anchored docks and leftward otherwise', () => {
        expect(resolveDeckFanDirection('toast-top-left')).toBe('right');
        expect(resolveDeckFanDirection('toast-bottom-left')).toBe('right');
        expect(resolveDeckFanDirection('toast-top-center')).toBe('left');
        expect(resolveDeckFanDirection('toast-top-right')).toBe('left');
        expect(resolveDeckFanDirection('toast-top-full-width')).toBe('left');
        expect(resolveDeckFanDirection('toast-bottom-center')).toBe('left');
        expect(resolveDeckFanDirection('toast-bottom-right')).toBe('left');
    });

    test('summarizes behind-card severities in priority order with unique dot types', () => {
        expect(summarizeBehindSeverities(['info', 'success'])).toEqual({
            highestSeverity: 'normal',
            dotTypes: ['success', 'info'],
        });
        expect(summarizeBehindSeverities(['info', 'warning', 'info'])).toEqual({
            highestSeverity: 'warning',
            dotTypes: ['warning', 'info'],
        });
        expect(summarizeBehindSeverities(['info', 'warning', 'error', 'success', 'error'])).toEqual({
            highestSeverity: 'error',
            dotTypes: ['error', 'warning', 'success', 'info'],
        });
        expect(summarizeBehindSeverities([])).toEqual({
            highestSeverity: 'normal',
            dotTypes: [],
        });
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

    test('fans 5 collapsed top-center cards leftward with full stepped visibility and front height matching', () => {
        const layout = computeDeckLayout({
            items: fiveItems,
            expanded: false,
            positionClass: 'toast-top-center',
            availableHorizontalSpace: 400,
            availableVerticalSpace: 600,
        });

        expect(layout).toEqual([
            { id: 1, index: 0, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, zIndex: 100, pointerEvents: 'auto', clipHeight: null, fanDirection: 'left' },
            { id: 2, index: 1, offsetX: -8, offsetY: 8, scale: 0.985, opacity: 0.94, zIndex: 99, pointerEvents: 'auto', clipHeight: 64, fanDirection: 'left' },
            { id: 3, index: 2, offsetX: -16, offsetY: 16, scale: 0.97, opacity: 0.88, zIndex: 98, pointerEvents: 'auto', clipHeight: 64, fanDirection: 'left' },
            { id: 4, index: 3, offsetX: -22, offsetY: 22, scale: 0.955, opacity: 0.82, zIndex: 97, pointerEvents: 'auto', clipHeight: 64, fanDirection: 'left' },
            { id: 5, index: 4, offsetX: -28, offsetY: 28, scale: 0.94, opacity: 0.76, zIndex: 96, pointerEvents: 'auto', clipHeight: 64, fanDirection: 'left' },
        ]);
    });

    test('compresses horizontal fan to fit narrow mobile viewport gutters and falls back to vertical-only when gutter < 4px', () => {
        const narrow = computeDeckLayout({
            items: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, height: 64 })),
            expanded: false,
            positionClass: 'toast-top-center',
            availableHorizontalSpace: 20,
            availableVerticalSpace: 600,
        });

        const visible = narrow.filter(x => x.opacity > 0);
        expect(visible.length).toBe(6);
        for (const spec of visible) {
            expect(Math.abs(spec.offsetX)).toBeLessThanOrEqual(20);
        }
        expect(narrow[5].offsetX).toBeLessThan(0);

        const zeroGutter = computeDeckLayout({
            items: fiveItems,
            expanded: false,
            positionClass: 'toast-top-full-width',
            availableHorizontalSpace: 2,
            availableVerticalSpace: 600,
        });
        expect(zeroGutter.map(x => x.offsetX)).toEqual([0, 0, 0, 0, 0]);
        expect(zeroGutter[1].offsetY).toBe(8);
    });

    test('hides cards beyond the vertical compactness budget or contrast opacity floor', () => {
        const twelveItems = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, height: 64 }));
        const layout = computeDeckLayout({
            items: twelveItems,
            expanded: false,
            positionClass: 'toast-top-center',
            availableHorizontalSpace: 400,
            availableVerticalSpace: 600,
        });

        // Indices 0..8 stay >= 0.50 opacity and within 54px vertical compactness budget; 9+ hide cleanly.
        expect(layout[8].opacity).toBeGreaterThanOrEqual(0.5);
        expect(layout[8].pointerEvents).toBe('auto');
        expect(layout[9].opacity).toBe(0);
        expect(layout[9].pointerEvents).toBe('none');
        expect(layout[11].opacity).toBe(0);
    });

    test('fans rightward for toast-top-left and inverts Y direction for bottom-anchored decks', () => {
        const leftAnchor = computeDeckLayout({
            items: fiveItems.slice(0, 3),
            expanded: false,
            positionClass: 'toast-top-left',
            availableHorizontalSpace: 400,
            availableVerticalSpace: 600,
        });
        expect(leftAnchor.map(x => x.offsetX)).toEqual([0, 8, 16]);
        expect(leftAnchor.map(x => x.fanDirection)).toEqual(['right', 'right', 'right']);

        const bottomRight = computeDeckLayout({
            items: fiveItems.slice(0, 4),
            expanded: false,
            positionClass: 'toast-bottom-right',
            availableHorizontalSpace: 400,
            availableVerticalSpace: 600,
        });
        expect(bottomRight.map(x => x.offsetY)).toEqual([0, -8, -16, -22]);
        expect(bottomRight.map(x => x.offsetX)).toEqual([0, -8, -16, -22]);
    });

    test('computes cumulative expanded offsets with zero horizontal fan for top and bottom anchors', () => {
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
            { id: 1, index: 0, offsetX: 0, offsetY: 0, scale: 1, opacity: 1, zIndex: 100, pointerEvents: 'auto', clipHeight: null, fanDirection: 'left' },
            { id: 2, index: 1, offsetX: 0, offsetY: 68, scale: 1, opacity: 1, zIndex: 99, pointerEvents: 'auto', clipHeight: null, fanDirection: 'left' },
            { id: 3, index: 2, offsetX: 0, offsetY: 156, scale: 1, opacity: 1, zIndex: 98, pointerEvents: 'auto', clipHeight: null, fanDirection: 'left' },
        ]);

        const bottomLayout = computeDeckLayout({
            items: three,
            expanded: true,
            positionClass: 'toast-bottom-center',
        });
        expect(bottomLayout.map(x => x.offsetY)).toEqual([0, -68, -156]);
        expect(bottomLayout.map(x => x.offsetX)).toEqual([0, 0, 0]);
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
