// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, test, expect } from '@jest/globals';
import {
    createBrowserModuleContext,
    createExtensionRegistry,
    installBrowserModuleContext,
    installDomReadyJQuery,
} from './util/browser-module-context.js';

describe('explicit browser module context (no global recursive Proxy)', () => {
    test('jest setup does not install a global Luker/st/SillyTavern or jQuery recursive Proxy', () => {
        expect(typeof globalThis.Luker).toBe('undefined');
        expect(typeof globalThis.st).toBe('undefined');
        expect(typeof globalThis.SillyTavern).toBe('undefined');
        expect(typeof globalThis.jQuery).toBe('undefined');
        expect(typeof globalThis.$).toBe('undefined');
    });

    test('createBrowserModuleContext exposes only declared capabilities without synthesizing unknown properties', () => {
        const translate = (s) => `t:${s}`;
        const context = createBrowserModuleContext({ translate });

        expect(context.translate).toBe(translate);
        expect(context.translate('hello')).toBe('t:hello');
        expect(Object.hasOwn(context, 'undeclaredCapability')).toBe(false);
        expect(typeof context.undeclaredCapability).toBe('undefined');
        expect(() => context.undeclaredCapability()).toThrow(TypeError);
        expect(() => context.nested.missing()).toThrow(TypeError);
    });

    test('createBrowserModuleContext rejects non-object dependencies', () => {
        expect(() => createBrowserModuleContext(null)).toThrow(TypeError);
        expect(() => createBrowserModuleContext([])).toThrow(TypeError);
        expect(() => createBrowserModuleContext('invalid')).toThrow(TypeError);
    });

    test('createExtensionRegistry registers and resolves explicit APIs and returns null for unknown names', () => {
        const registry = createExtensionRegistry();
        const api = { ping: () => 'pong' };
        expect(registry.getExtensionApi('unknown')).toBeNull();
        registry.registerExtensionApi('sample', api);
        expect(registry.getExtensionApi('sample')).toBe(api);
        expect(registry.getExtensionApi('other')).toBeNull();
    });

    test('installBrowserModuleContext binds explicit aliases and cleanly restores globals', () => {
        const translate = (s) => String(s);
        const installed = installBrowserModuleContext({ translate });
        try {
            expect(globalThis.Luker.getContext()).toBe(installed.context);
            expect(globalThis.st.getContext()).toBe(installed.context);
            expect(globalThis.SillyTavern.getContext()).toBe(installed.context);
            expect(globalThis.Luker.getContext().translate('ok')).toBe('ok');
            expect(Object.hasOwn(globalThis.Luker.getContext(), 'missingApi')).toBe(false);
            expect(typeof globalThis.Luker.getContext().missingApi).toBe('undefined');
        } finally {
            installed.restore();
        }
        expect(typeof globalThis.Luker).toBe('undefined');
        expect(typeof globalThis.st).toBe('undefined');
        expect(typeof globalThis.SillyTavern).toBe('undefined');
    });

    test('pure browser helper modules import cleanly without any global Luker or jQuery stub', async () => {
        const codec = await import('../public/scripts/lib/preset-ref-codec.js');
        expect(typeof codec.encodeCardBoundOptionValue).toBe('function');
        expect(typeof codec.decodeCardBoundOptionValue).toBe('function');
        const stateErrors = await import('../public/scripts/lib/state-errors.js');
        expect(typeof stateErrors.makeStateError).toBe('function');
        expect(typeof stateErrors.makeStateOk).toBe('function');
    });

    test('installBrowserModuleContext exposes declared hostProperties and restores cleanly', () => {
        const searchTools = { invoke: () => {} };
        const installed = installBrowserModuleContext({}, { hostProperties: { searchTools } });
        try {
            expect(globalThis.Luker.searchTools).toBe(searchTools);
            expect(Object.hasOwn(globalThis.Luker, 'undeclaredHostField')).toBe(false);
            expect(typeof globalThis.Luker.undeclaredHostField).toBe('undefined');
        } finally {
            installed.restore();
        }
        expect(typeof globalThis.Luker).toBe('undefined');
    });

    test('installDomReadyJQuery records DOM-ready callbacks without synthesizing arbitrary jQuery methods', () => {
        const installed = installDomReadyJQuery({ staticProperties: { ajaxPrefilter: () => {} } });
        try {
            let ran = false;
            globalThis.jQuery(() => { ran = true; });
            expect(ran).toBe(false);
            expect(installed.readyCallbacks).toHaveLength(1);
            const docSel = globalThis.jQuery('document');
            expect(docSel.off('click').on('click', () => {})).toBe(docSel);
            expect(typeof docSel.undeclaredMethod).toBe('undefined');
            expect(() => docSel.undeclaredMethod()).toThrow(TypeError);
            expect(typeof globalThis.$.ajaxPrefilter).toBe('function');
            expect(typeof globalThis.$.undeclaredStatic).toBe('undefined');
        } finally {
            installed.restore();
        }
        expect(typeof globalThis.jQuery).toBe('undefined');
        expect(typeof globalThis.$).toBe('undefined');
    });
});
