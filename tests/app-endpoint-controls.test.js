/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { detectAppBridge, initAppEndpointControls } from '../public/scripts/app-endpoint-controls.js';

function setupDom(doc = document) {
    doc.body.innerHTML = `
        <div id="app_reload_button" style="display: none;"></div>
        <div id="app_endpoint_button" style="display: none;"></div>
    `;
    return doc;
}

function createDoc() {
    return setupDom(document.implementation.createHTMLDocument('app-endpoint-controls'));
}

function makeWin(name, bridge) {
    return { [name]: bridge, location: { reload: jest.fn() } };
}

function reloadButton(doc) {
    return doc.getElementById('app_reload_button');
}

function endpointButton(doc) {
    return doc.getElementById('app_endpoint_button');
}

describe('detectAppBridge', () => {
    it('returns null when no bridge exists', () => {
        expect(detectAppBridge({})).toBeNull();
    });

    it('returns the first bridge in android, harmony, ios, desktop order', () => {
        const android = { reloadWebView: jest.fn() };
        const harmony = { reloadWebView: jest.fn() };
        const ios = { reloadWebView: jest.fn() };
        const desktop = { reloadWebView: jest.fn() };
        const win = {
            LukerAndroid: android,
            LukerHarmony: harmony,
            LukerIOS: ios,
            LukerDesktop: desktop,
        };

        expect(detectAppBridge(win)).toEqual({ kind: 'android', bridge: android });
        expect(detectAppBridge({ ...win, LukerAndroid: undefined })).toEqual({ kind: 'harmony', bridge: harmony });
        expect(detectAppBridge({ LukerIOS: ios, LukerDesktop: desktop })).toEqual({ kind: 'ios', bridge: ios });
        expect(detectAppBridge({ LukerDesktop: desktop })).toEqual({ kind: 'desktop', bridge: desktop });
    });
});

describe('initAppEndpointControls', () => {
    beforeEach(() => {
        setupDom();
    });

    for (const [name, kind] of [
        ['LukerAndroid', 'android'],
        ['LukerHarmony', 'harmony'],
        ['LukerIOS', 'ios'],
    ]) {
        it(`shows both buttons for ${kind} and wires the bridge methods`, () => {
            const doc = createDoc();
            const bridge = { reloadWebView: jest.fn(), openEndpointSettings: jest.fn() };
            const win = makeWin(name, bridge);

            const result = initAppEndpointControls({ win, doc });

            expect(result).toEqual({ kind, bridge });
            expect(reloadButton(doc).style.display).toBe('');
            expect(endpointButton(doc).style.display).toBe('');

            reloadButton(doc).click();
            endpointButton(doc).click();

            expect(bridge.reloadWebView).toHaveBeenCalledTimes(1);
            expect(bridge.openEndpointSettings).toHaveBeenCalledTimes(1);
            expect(win.location.reload).not.toHaveBeenCalled();
        });
    }

    it('shows only the reload button on desktop and reloads the location', () => {
        const doc = createDoc();
        const bridge = { openEndpointSettings: jest.fn() };
        const win = makeWin('LukerDesktop', bridge);

        const result = initAppEndpointControls({ win, doc });

        expect(result).toEqual({ kind: 'desktop', bridge });
        expect(reloadButton(doc).style.display).toBe('');
        expect(endpointButton(doc).style.display).toBe('none');

        reloadButton(doc).click();

        expect(win.location.reload).toHaveBeenCalledTimes(1);
        expect(bridge.openEndpointSettings).not.toHaveBeenCalled();
    });

    it('leaves both buttons hidden when no bridge exists', () => {
        const doc = createDoc();
        const win = { location: { reload: jest.fn() } };

        const result = initAppEndpointControls({ win, doc });

        expect(result).toBeNull();
        expect(reloadButton(doc).style.display).toBe('none');
        expect(endpointButton(doc).style.display).toBe('none');
    });

    it('defaults to the global window and document', () => {
        const bridge = { reloadWebView: jest.fn(), openEndpointSettings: jest.fn() };
        window.LukerAndroid = bridge;

        try {
            const result = initAppEndpointControls();

            expect(result).toEqual({ kind: 'android', bridge });
            expect(reloadButton(document).style.display).toBe('');
            expect(endpointButton(document).style.display).toBe('');
        } finally {
            delete window.LukerAndroid;
        }
    });

    it('falls back to location.reload when the bridge has no reloadWebView', () => {
        const doc = createDoc();
        const bridge = { openEndpointSettings: jest.fn() };
        const win = makeWin('LukerAndroid', bridge);

        initAppEndpointControls({ win, doc });

        expect(reloadButton(doc).style.display).toBe('');
        reloadButton(doc).click();

        expect(win.location.reload).toHaveBeenCalledTimes(1);
    });

    it('keeps the endpoint button hidden when the bridge has no openEndpointSettings', () => {
        const doc = createDoc();
        const bridge = { reloadWebView: jest.fn() };
        const win = makeWin('LukerAndroid', bridge);

        initAppEndpointControls({ win, doc });

        expect(reloadButton(doc).style.display).toBe('');
        expect(endpointButton(doc).style.display).toBe('none');
    });

    it('does not throw when the drawer buttons are missing', () => {
        const doc = document.implementation.createHTMLDocument('empty');
        const bridge = { reloadWebView: jest.fn(), openEndpointSettings: jest.fn() };
        const win = makeWin('LukerAndroid', bridge);

        expect(() => initAppEndpointControls({ win, doc })).not.toThrow();
    });
});
