import { describe, expect, test } from '@jest/globals';
import { hidesOnClose, usesTray, devtoolsShortcutFor, reloadShortcutFor } from '../desktop-app/window-behaviour.js';

describe('desktop window behaviour per platform', () => {
    test('hides on close everywhere the app has a way back', () => {
        expect(hidesOnClose('darwin')).toBe(true);
        expect(hidesOnClose('win32')).toBe(true);
    });

    test('quits on close where nothing could bring the window back', () => {
        expect(hidesOnClose('linux')).toBe(false);
    });

    test('only windows gets a tray', () => {
        expect(usesTray('win32')).toBe(true);
        expect(usesTray('linux')).toBe(false);
        expect(usesTray('darwin')).toBe(false);
    });

    test('windows and linux toggle devtools on F12 or Ctrl+Shift+I', () => {
        expect(devtoolsShortcutFor('win32', { key: 'F12' })).toBe('toggle');
        expect(devtoolsShortcutFor('linux', { key: 'F12' })).toBe('toggle');
        expect(devtoolsShortcutFor('win32', { key: 'i', control: true, shift: true })).toBe('toggle');
        expect(devtoolsShortcutFor('linux', { key: 'i', control: true, shift: true })).toBe('toggle');
    });

    test('darwin leaves the shortcut to the application menu', () => {
        expect(devtoolsShortcutFor('darwin', { key: 'F12' })).toBe(null);
        expect(devtoolsShortcutFor('darwin', { key: 'i', control: true, shift: true })).toBe(null);
    });

    test('unrelated keys do not toggle', () => {
        expect(devtoolsShortcutFor('win32', { key: 'i' })).toBe(null);
        expect(devtoolsShortcutFor('win32', { key: 'i', control: true })).toBe(null);
        expect(devtoolsShortcutFor('win32', { key: 'j', control: true, shift: true })).toBe(null);
        expect(devtoolsShortcutFor('win32', { type: 'keyUp', key: 'F12' })).toBe(null);
    });

    test('windows and linux reload on F5 or Ctrl+R and force-reload with Shift or Ctrl+F5', () => {
        for (const platform of ['win32', 'linux']) {
            expect(reloadShortcutFor(platform, { type: 'keyDown', key: 'F5' })).toBe('reload');
            expect(reloadShortcutFor(platform, { key: 'r', control: true })).toBe('reload');
            expect(reloadShortcutFor(platform, { key: 'R', control: true, shift: true })).toBe('force-reload');
            expect(reloadShortcutFor(platform, { key: 'F5', control: true })).toBe('force-reload');
            expect(reloadShortcutFor(platform, { key: 'F5', shift: true })).toBe('force-reload');
        }
    });

    test('reload shortcuts ignore keyUp, darwin, and unrelated modifiers', () => {
        expect(reloadShortcutFor('darwin', { key: 'F5' })).toBe(null);
        expect(reloadShortcutFor('darwin', { key: 'r', control: true })).toBe(null);
        expect(reloadShortcutFor('win32', { type: 'keyUp', key: 'F5' })).toBe(null);
        expect(reloadShortcutFor('win32', { type: 'keyUp', key: 'r', control: true })).toBe(null);
        expect(reloadShortcutFor('win32', { key: 'r' })).toBe(null);
        expect(reloadShortcutFor('win32', { key: 'r', control: true, alt: true })).toBe(null);
        expect(reloadShortcutFor('win32', { key: 'F5', alt: true })).toBe(null);
    });
});
