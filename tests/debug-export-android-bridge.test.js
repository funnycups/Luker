import { describe, test, expect, beforeEach, jest } from '@jest/globals';

describe('debug-export Android bridge routing', () => {
    beforeEach(() => {
        jest.resetModules();
        delete globalThis.window;
        delete globalThis.fetch;
        delete globalThis.toastr;
        delete globalThis.document;
        delete globalThis.URL;
        delete globalThis.navigator;
    });

    test('downloadDebugBundle calls native exportDiagnosticsBundle when bridge present', async () => {
        const exportDiagnosticsBundle = jest.fn();
        globalThis.window = {
            LukerAndroid: { exportDiagnosticsBundle },
        };
        globalThis.toastr = { success: jest.fn(), error: jest.fn() };
        globalThis.fetch = jest.fn(() => { throw new Error('should not call fetch'); });

        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: () => ({}),
        }));
        jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
            t: (strings) => strings[0],
        }));
        jest.unstable_mockModule('../public/scripts/frontend-log-manager.js', () => ({
            getFrontendLogsSnapshot: () => ({ entries: [], latestId: 0 }),
        }));

        const mod = await import('../public/scripts/debug-export.js');
        await mod.downloadDebugBundle();

        expect(exportDiagnosticsBundle).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.success).toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    test('downloadDebugBundle falls through to fetch when bridge missing', async () => {
        globalThis.window = {};
        globalThis.toastr = { success: jest.fn(), error: jest.fn() };
        globalThis.navigator = { userAgent: 'ua', platform: 'p', language: 'en', onLine: true };
        globalThis.performance = { getEntriesByType: () => [] };
        const blob = { type: 'application/octet-stream' };
        const response = {
            ok: true,
            blob: jest.fn(() => Promise.resolve(blob)),
        };
        globalThis.fetch = jest.fn(() => Promise.resolve(response));
        const click = jest.fn();
        const removeChild = jest.fn();
        const anchor = { href: '', download: '', click };
        globalThis.document = {
            createElement: jest.fn(() => anchor),
            body: { appendChild: jest.fn(), removeChild },
        };
        globalThis.URL = { createObjectURL: jest.fn(() => 'blob:fake'), revokeObjectURL: jest.fn() };

        jest.unstable_mockModule('../public/script.js', () => ({
            getRequestHeaders: () => ({}),
        }));
        jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
            t: (strings) => strings[0],
        }));
        jest.unstable_mockModule('../public/scripts/frontend-log-manager.js', () => ({
            getFrontendLogsSnapshot: () => ({ entries: [], latestId: 0 }),
        }));

        const mod = await import('../public/scripts/debug-export.js');
        await mod.downloadDebugBundle();

        expect(globalThis.fetch).toHaveBeenCalledWith('/api/debug/export', expect.objectContaining({ method: 'POST' }));
        expect(click).toHaveBeenCalledTimes(1);
    });
});
