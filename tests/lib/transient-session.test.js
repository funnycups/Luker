// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from '@jest/globals';

describe('temporary media client contracts', () => {
    test('ordinary requests carry no temporary ownership header', async () => {
        const { transientSessionHeaders } = await import('../../public/scripts/lib/transient-session.js');
        expect(transientSessionHeaders()).toEqual({});
    });

    test('an explicit owner is forwarded without changing its identity', async () => {
        const { transientSessionHeaders } = await import('../../public/scripts/lib/transient-session.js');
        expect(transientSessionHeaders('owned-session')).toEqual({
            'X-Luker-Transient-Session': 'owned-session',
        });
    });

    test.each([null, '', ' ', ' owned-session', 0, {}, []])('invalid explicit ownership %p cannot become an ordinary request', async (value) => {
        const { transientSessionHeaders } = await import('../../public/scripts/lib/transient-session.js');
        expect(() => transientSessionHeaders(value)).toThrow('session id');
    });

    test('the authenticated owner connection is an exported client capability', async () => {
        const { openTransientSession } = await import('../../public/scripts/lib/transient-session.js');
        expect(typeof openTransientSession).toBe('function');
    });

    test('the image adapter is exported without starting a request at import time', async () => {
        const { createTempMediaTracker } = await import('../../public/scripts/extensions/stable-diffusion/lens/temp-media-tracker.js');
        expect(typeof createTempMediaTracker).toBe('function');
    });

    test('cancellation before opening preserves the asynchronous ready contract', async () => {
        const { createTempMediaTracker } = await import('../../public/scripts/extensions/stable-diffusion/lens/temp-media-tracker.js');
        // Cancellation is local: it needs no substitute context or transport.
        const tracker = createTempMediaTracker();
        await tracker.cleanup();
        expect(tracker.sessionId).toBeUndefined();
        const attempt = tracker.ready();
        expect(attempt).toBeInstanceOf(Promise);
        await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
        await expect(tracker.cleanup()).resolves.toBeUndefined();
    });
});
