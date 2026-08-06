import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// `withProfileRetry` reads per-profile retry settings from
// `extension_settings.connectionManager` via the max-retries.js readers.
// Stub the module so tests can drive profile state directly.
const cmSettings = { profiles: [], selectedProfile: null };
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: { connectionManager: cmSettings },
}));

const { withProfileRetry } = await import(
    '../public/scripts/extensions/connection-manager/profile-retry.js'
);

function setActiveProfile({ maxRetries = 0, blacklist = '' } = {}) {
    cmSettings.profiles = [{
        id: 'active',
        name: 'active-profile',
        'max-request-retries': maxRetries,
        'retry-status-blacklist': blacklist,
    }];
    cmSettings.selectedProfile = 'active';
}

function setNamedProfile(name, { maxRetries = 0, blacklist = '' } = {}) {
    cmSettings.profiles.push({
        id: `id-${name}`,
        name,
        'max-request-retries': maxRetries,
        'retry-status-blacklist': blacklist,
    });
}

function resetProfiles() {
    cmSettings.profiles = [];
    cmSettings.selectedProfile = null;
}

describe('withProfileRetry', () => {
    beforeEach(() => {
        resetProfiles();
        jest.useFakeTimers();
    });

    test('no profile → maxRetries=0, no retry on retriable status', async () => {
        // No active profile → getMaxRequestRetries returns 0 → no retry.
        const resp = new Response('rl', { status: 429 });
        const fetcher = jest.fn().mockResolvedValue(resp);

        const result = await withProfileRetry(fetcher, { label: 'unit' });

        expect(result).toBe(resp);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('active profile maxRetries=2 → retries on 500 up to twice', async () => {
        setActiveProfile({ maxRetries: 2 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 500 }))
            .mockResolvedValueOnce(new Response('', { status: 500 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const p = withProfileRetry(fetcher, { label: 'unit' });
        await jest.runAllTimersAsync();
        const result = await p;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    test('active profile blacklist skips 429 even when retries are enabled', async () => {
        setActiveProfile({ maxRetries: 3, blacklist: '429' });
        const resp = new Response('rl', { status: 429 });
        const fetcher = jest.fn().mockResolvedValue(resp);

        const result = await withProfileRetry(fetcher, { label: 'unit' });

        expect(result).toBe(resp);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('named profile takes precedence over active for retry count', async () => {
        setActiveProfile({ maxRetries: 0 });                       // active disables retry
        setNamedProfile('worker', { maxRetries: 3 });               // named enables it

        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const p = withProfileRetry(fetcher, { profileName: 'worker', label: 'unit' });
        await jest.runAllTimersAsync();
        const result = await p;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('named profile blacklist applies (not active profile blacklist)', async () => {
        setActiveProfile({ maxRetries: 3, blacklist: '' });         // active: no blacklist
        setNamedProfile('worker', { maxRetries: 3, blacklist: '503' });

        const resp = new Response('', { status: 503 });
        const fetcher = jest.fn().mockResolvedValue(resp);

        const result = await withProfileRetry(fetcher, { profileName: 'worker', label: 'unit' });

        expect(result).toBe(resp);
        expect(fetcher).toHaveBeenCalledTimes(1);   // worker's blacklist won
    });

    test('onAttempt receives maxRetries as 4th positional arg', async () => {
        setActiveProfile({ maxRetries: 3 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const onAttempt = jest.fn();
        const p = withProfileRetry(fetcher, { onAttempt, label: 'unit' });
        await jest.runAllTimersAsync();
        await p;

        expect(onAttempt).toHaveBeenCalledTimes(1);
        const [attempt, error, delay, maxRetries] = onAttempt.mock.calls[0];
        expect(attempt).toBe(1);
        expect(error).toBeInstanceOf(Error);
        expect(typeof delay).toBe('number');
        expect(maxRetries).toBe(3);
    });

    test('missing onAttempt does not throw', async () => {
        setActiveProfile({ maxRetries: 2 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const p = withProfileRetry(fetcher, { label: 'unit' });          // no onAttempt
        await jest.runAllTimersAsync();
        const result = await p;

        expect(result.status).toBe(200);
    });

    test('AbortSignal passed through and honored', async () => {
        setActiveProfile({ maxRetries: 5 });
        const ac = new AbortController();
        ac.abort();
        const fetcher = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));

        await expect(withProfileRetry(fetcher, { signal: ac.signal, label: 'unit' }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    test('propagates fetcher return value on first-attempt success', async () => {
        setActiveProfile({ maxRetries: 3 });
        const ok = new Response('ok', { status: 200 });
        const fetcher = jest.fn().mockResolvedValue(ok);

        const result = await withProfileRetry(fetcher, { label: 'unit' });

        expect(result).toBe(ok);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('empty profileName falls back to active profile', async () => {
        setActiveProfile({ maxRetries: 2 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 503 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const p = withProfileRetry(fetcher, { profileName: '', label: 'unit' });
        await jest.runAllTimersAsync();
        const result = await p;

        expect(result.status).toBe(200);
    });
});
