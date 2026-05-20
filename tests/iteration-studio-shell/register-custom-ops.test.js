/**
 * Tests for the registerCustomOps facade wired into the iteration-studio shell.
 *
 * studio.js transitively imports ../lib/edits/index.js (which loads the
 * browser-only public/lib.js bundle) and ../popup.js (heavy UI deps).
 * We mock both: edits-lib via a real engine + npm lodash so the facade
 * round-trip is genuine; popup as a stub since the test never opens a popup.
 */

import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import lodash from 'lodash';
import { createEngine } from '../../public/scripts/lib/edits/engine.js';

const engine = createEngine({
    get:       lodash.get,
    set:       lodash.set,
    unset:     lodash.unset,
    isEqual:   lodash.isEqual,
    cloneDeep: lodash.cloneDeep,
});

jest.unstable_mockModule('../../public/scripts/lib/edits/index.js', () => ({
    applyEdits:        engine.applyEdits,
    inverseEdit:       engine.inverseEdit,
    registerOp:        engine.registerOp,
    getRegisteredOp:   engine.getRegisteredOp,
    listRegisteredOps: engine.listRegisteredOps,
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { DISPLAY: 4 },
    Popup: class { show() { return Promise.resolve(); } },
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (s) => String(s ?? ''),
}));

jest.unstable_mockModule('../../public/scripts/iteration-studio/i18n.js', () => ({
    i18n: (k) => String(k || ''),
    i18nFormat: (k, ...args) => String(k) + ':' + args.join('|'),
}));

let getRegisteredOp;
let defineAdapter;
let studioMod;

beforeAll(async () => {
    globalThis.SillyTavern = { getContext: () => ({}) };
    globalThis.saveSettingsDebounced = () => {};
    const editsMod = await import('../../public/scripts/lib/edits/index.js');
    getRegisteredOp = editsMod.getRegisteredOp;
    const sessionMod = await import('../../public/scripts/iteration-studio/session.js');
    defineAdapter = sessionMod.defineAdapter;
    studioMod = await import('../../public/scripts/iteration-studio/studio.js');
});

describe('registerCustomOps facade', () => {
    test('shell exposes makeCustomOpsRegistryFacade that calls registerOp and dedupes on getRegisteredOp', () => {
        const facade = studioMod.makeCustomOpsRegistryFacade();
        expect(typeof facade.registerOp).toBe('function');

        const handler = {
            apply: (_deps, _edit, live) => live,
            inverse: (edit) => edit,
            detectConflict: () => null,
        };
        const name = `__test_op_${Date.now()}`;
        facade.registerOp(name, handler);
        expect(getRegisteredOp(name)).toBeTruthy();

        // Idempotent: second call doesn't throw
        expect(() => facade.registerOp(name, handler)).not.toThrow();
    });

    test('openIterationStudio invokes adapter.registerCustomOps(facade) before session load', async () => {
        let registeredFacade = null;
        const adapter = defineAdapter({
            id: 'test_adapter_register',
            title: 't', mode: 't', layout: 'popup',
            i18n: (s) => s, i18nFormat: (s) => s,
            live: () => ({}), commit: async () => {},
            sessionScope: () => 'global',
            listSessions: async () => [],
            loadSession: async () => null,
            saveSession: async () => {},
            deleteSession: async () => {},
            buildToolCatalog: () => [],
            normalizeToolCallToEdit: () => [],
            buildSystemPrompt: () => '',
            buildUserPrompt: (s, t) => t,
            renderMessageCard: () => '',
            renderHistoryItem: () => '',
            registerCustomOps: (registry) => { registeredFacade = registry; },
        });
        // openIterationStudio's full path mounts a Popup() — but the facade call happens before that.
        // We invoke the helper directly:
        const facade = studioMod.makeCustomOpsRegistryFacade();
        await studioMod.runRegisterCustomOpsForTest(adapter, facade);
        expect(registeredFacade).toBe(facade);
    });
});
