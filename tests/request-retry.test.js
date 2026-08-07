import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

const { withRetry } = await import('../public/scripts/request-retry.js');

describe('withRetry', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('returns fetcher result on first success without calling onAttempt', async () => {
        const okResponse = new Response('ok', { status: 200 });
        const fetcher = jest.fn().mockResolvedValue(okResponse);
        const onAttempt = jest.fn();

        const result = await withRetry(fetcher, { maxRetries: 3, onAttempt });

        expect(result).toBe(okResponse);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onAttempt).not.toHaveBeenCalled();
    });

    // ── Task 3: Response status-based retry ─────────────────────────────────

    test('retries when Response has retriable status (429), succeeds after one retry', async () => {
        const okResponse = new Response('ok', { status: 200 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
            .mockResolvedValueOnce(okResponse);
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 3, onAttempt });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe(okResponse);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(onAttempt).toHaveBeenCalledTimes(1);
        expect(onAttempt.mock.calls[0][0]).toBe(1);
    });

    test('retries on Response 500, then 503, then 200', async () => {
        const okResponse = new Response('ok', { status: 200 });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('boom', { status: 500 }))
            .mockResolvedValueOnce(new Response('boom', { status: 503 }))
            .mockResolvedValueOnce(okResponse);

        const promise = withRetry(fetcher, { maxRetries: 3 });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe(okResponse);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    test('returns non-retriable !ok Response without retrying (400)', async () => {
        const badResponse = new Response('bad request', { status: 400 });
        const fetcher = jest.fn().mockResolvedValue(badResponse);
        const onAttempt = jest.fn();

        const result = await withRetry(fetcher, { maxRetries: 3, onAttempt });

        expect(result).toBe(badResponse);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onAttempt).not.toHaveBeenCalled();
    });

    test('returns last retriable !ok Response when retries exhausted', async () => {
        const tooMany = new Response('still rate limited', { status: 429 });
        const fetcher = jest.fn().mockResolvedValue(tooMany);

        const promise = withRetry(fetcher, { maxRetries: 2 });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe(tooMany);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    // ── Task 4: thrown Error retry path ─────────────────────────────────────

    test('retries when fetcher throws error with retriable status (503)', async () => {
        const err503 = Object.assign(new Error('boom'), { status: 503 });
        const fetcher = jest.fn()
            .mockRejectedValueOnce(err503)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 3 });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('retries when fetcher throws error without status (network error)', async () => {
        const netErr = new TypeError('Failed to fetch');
        const fetcher = jest.fn()
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 3 });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('does NOT retry on thrown error with non-retriable status (401)', async () => {
        const err401 = Object.assign(new Error('unauthorized'), { status: 401 });
        const fetcher = jest.fn().mockRejectedValue(err401);

        await expect(withRetry(fetcher, { maxRetries: 3 })).rejects.toBe(err401);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry on thrown error with status=400', async () => {
        const err400 = Object.assign(new Error('bad request'), { status: 400 });
        const fetcher = jest.fn().mockRejectedValue(err400);

        await expect(withRetry(fetcher, { maxRetries: 3 })).rejects.toBe(err400);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // ── Task 5: short circuits ──────────────────────────────────────────────

    test('does NOT retry on AbortError', async () => {
        const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
        const fetcher = jest.fn().mockRejectedValue(abortErr);

        await expect(withRetry(fetcher, { maxRetries: 3 })).rejects.toBe(abortErr);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('does NOT retry when err.skipRetry is true even for retriable status', async () => {
        const err = Object.assign(new Error('quota'), { status: 429, skipRetry: true });
        const fetcher = jest.fn().mockRejectedValue(err);

        await expect(withRetry(fetcher, { maxRetries: 3 })).rejects.toBe(err);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('maxRetries=0 disables retry; first thrown failure re-throws', async () => {
        const err503 = Object.assign(new Error('boom'), { status: 503 });
        const fetcher = jest.fn().mockRejectedValue(err503);

        await expect(withRetry(fetcher, { maxRetries: 0 })).rejects.toBe(err503);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('maxRetries=0 with retriable Response returns it as-is', async () => {
        const resp429 = new Response('rl', { status: 429 });
        const fetcher = jest.fn().mockResolvedValue(resp429);

        const result = await withRetry(fetcher, { maxRetries: 0 });

        expect(result).toBe(resp429);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('throws AbortError immediately if signal already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const fetcher = jest.fn().mockResolvedValue(new Response('ok'));

        await expect(withRetry(fetcher, { maxRetries: 3, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    // ── Task 6: backoff ─────────────────────────────────────────────────────

    test('uses exponential backoff: attempt 0 → 1s, attempt 1 → 2s, attempt 2 → 4s', async () => {
        const restoreRandom = Math.random;
        Math.random = () => 0.5; // jitterMul = 1.0

        try {
            const fetcher = jest.fn()
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(new Response('ok', { status: 200 }));

            const onAttempt = jest.fn();
            const promise = withRetry(fetcher, { maxRetries: 3, onAttempt });
            await jest.runAllTimersAsync();
            await promise;

            expect(onAttempt.mock.calls[0][2]).toBe(1000);
            expect(onAttempt.mock.calls[1][2]).toBe(2000);
            expect(onAttempt.mock.calls[2][2]).toBe(4000);
        } finally {
            Math.random = restoreRandom;
        }
    });

    test('backoff jitter stays within ±25% (statistical check, 50 samples)', async () => {
        const samples = [];
        for (let i = 0; i < 50; i++) {
            const fetcher = jest.fn()
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(new Response('ok', { status: 200 }));
            const onAttempt = jest.fn();
            const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
            await jest.runAllTimersAsync();
            await promise;
            samples.push(onAttempt.mock.calls[0][2]);
        }
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        expect(min).toBeGreaterThanOrEqual(750);
        expect(max).toBeLessThanOrEqual(1250);
    });

    test('backoff caps at 8s for attempt 3+', async () => {
        const restoreRandom = Math.random;
        Math.random = () => 0.5;

        try {
            const fetcher = jest.fn();
            for (let i = 0; i < 5; i++) {
                fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
            }
            fetcher.mockResolvedValueOnce(new Response('ok', { status: 200 }));

            const onAttempt = jest.fn();
            const promise = withRetry(fetcher, { maxRetries: 5, onAttempt });
            await jest.runAllTimersAsync();
            await promise;

            expect(onAttempt.mock.calls[3][2]).toBe(8000);
            expect(onAttempt.mock.calls[4][2]).toBe(8000);
        } finally {
            Math.random = restoreRandom;
        }
    });

    // ── Task 7: Retry-After header ──────────────────────────────────────────

    test('Retry-After header (seconds) overrides exponential backoff', async () => {
        const resp = new Response('', { status: 429, headers: { 'Retry-After': '5' } });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(resp)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
        await jest.runAllTimersAsync();
        await promise;

        expect(onAttempt.mock.calls[0][2]).toBe(5000);
    });

    test('Retry-After header is capped at 60 seconds', async () => {
        const resp = new Response('', { status: 429, headers: { 'Retry-After': '300' } });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(resp)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
        await jest.runAllTimersAsync();
        await promise;

        expect(onAttempt.mock.calls[0][2]).toBe(60000);
    });

    test('Retry-After header (HTTP-date) is honored', async () => {
        const futureDate = new Date(Date.now() + 3000).toUTCString();
        const resp = new Response('', { status: 429, headers: { 'Retry-After': futureDate } });
        const fetcher = jest.fn()
            .mockResolvedValueOnce(resp)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
        await jest.runAllTimersAsync();
        await promise;

        const delay = onAttempt.mock.calls[0][2];
        expect(delay).toBeGreaterThanOrEqual(2000);
        expect(delay).toBeLessThanOrEqual(3500);
    });

    test('thrown error with retryAfter property is honored', async () => {
        const err = Object.assign(new Error('rl'), { status: 429, retryAfter: '2' });
        const fetcher = jest.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
        await jest.runAllTimersAsync();
        await promise;

        expect(onAttempt.mock.calls[0][2]).toBe(2000);
    });

    // ── Task 8: AbortSignal during sleep ────────────────────────────────────

    test('AbortSignal during sleep cancels retry loop', async () => {
        const ac = new AbortController();
        const fetcher = jest.fn().mockResolvedValue(new Response('', { status: 503 }));

        const promise = withRetry(fetcher, { maxRetries: 5, signal: ac.signal });
        const captured = promise.catch((e) => e); // capture synchronously so jest doesn't flag unhandled

        await jest.advanceTimersByTimeAsync(100);
        ac.abort();
        await jest.runAllTimersAsync();

        const caught = await captured;
        expect(caught).toMatchObject({ name: 'AbortError' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // ── Task 9: onAttempt callback + suffix ─────────────────────────────────

    test('onAttempt receives (attemptNumber, error, nextDelayMs)', async () => {
        const err = Object.assign(new Error('boom'), { status: 503 });
        const fetcher = jest.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));
        const onAttempt = jest.fn();

        const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
        await jest.runAllTimersAsync();
        await promise;

        expect(onAttempt).toHaveBeenCalledTimes(1);
        const [attemptNum, errArg, delayArg] = onAttempt.mock.calls[0];
        expect(attemptNum).toBe(1);
        expect(errArg).toBe(err);
        expect(typeof delayArg).toBe('number');
    });

    test('exhausted thrown error gets "(after N retries)" suffix', async () => {
        const err = Object.assign(new Error('boom'), { status: 503 });
        const fetcher = jest.fn().mockRejectedValue(err);

        const promise = withRetry(fetcher, { maxRetries: 2 });
        const captured = promise.catch((e) => e);
        await jest.runAllTimersAsync();

        const caught = await captured;
        expect(caught.message).toMatch(/boom \(after 2 retries\)/);
    });

    test('no suffix appended when maxRetries=0 (never retried)', async () => {
        const err = Object.assign(new Error('boom'), { status: 503 });
        const fetcher = jest.fn().mockRejectedValue(err);

        await expect(withRetry(fetcher, { maxRetries: 0 })).rejects.toThrow(/^boom$/);
    });

    test('onAttempt callback throws are caught and logged, retry continues', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const fetcher = jest.fn()
                .mockResolvedValueOnce(new Response('', { status: 503 }))
                .mockResolvedValueOnce(new Response('ok', { status: 200 }));
            const onAttempt = jest.fn(() => { throw new Error('cb broke'); });

            const promise = withRetry(fetcher, { maxRetries: 1, onAttempt });
            await jest.runAllTimersAsync();
            const result = await promise;

            expect(result.status).toBe(200);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('onAttempt callback threw'), expect.any(Error));
        } finally {
            warnSpy.mockRestore();
        }
    });

    // ── Task 10: retryWhitelist option ──────────────────────────────────────
    // When empty / missing, the built-in default set (429 + 5xx) applies.
    // When non-empty, ONLY listed codes are retried — the default set is
    // fully overridden. Ranges (`{start, end}`) are supported alongside
    // plain-number entries.

    test('empty retryWhitelist falls back to default set (429 retried)', async () => {
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 429 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2, retryWhitelist: [] });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('undefined retryWhitelist falls back to default set', async () => {
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 429 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2 });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('retryWhitelist non-array (invalid input) falls back to default set', async () => {
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 429 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2, retryWhitelist: /** @type {any} */ ('429') });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('non-empty whitelist retries only listed Response status', async () => {
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2, retryWhitelist: [403] });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('non-empty whitelist skips default-set codes not in the list', async () => {
        // 429 is in the built-in default, but the user's list is [403] only —
        // 429 must NOT be retried.
        const resp429 = new Response('rl', { status: 429 });
        const fetcher = jest.fn().mockResolvedValue(resp429);
        const onAttempt = jest.fn();

        const result = await withRetry(fetcher, { maxRetries: 3, retryWhitelist: [403], onAttempt });

        expect(result).toBe(resp429);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onAttempt).not.toHaveBeenCalled();
    });

    test('non-empty whitelist skips default-set 503 when not listed', async () => {
        const resp503 = new Response('down', { status: 503 });
        const fetcher = jest.fn().mockResolvedValue(resp503);

        const result = await withRetry(fetcher, { maxRetries: 3, retryWhitelist: [403] });

        expect(result).toBe(resp503);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('whitelist honors range entries (inclusive endpoints)', async () => {
        const fetcher = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 500 }))
            .mockResolvedValueOnce(new Response('', { status: 599 }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, {
            maxRetries: 3,
            retryWhitelist: [{ start: 500, end: 599 }],
        });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    test('whitelist range excludes status just outside endpoints', async () => {
        // Range 500-504 must NOT catch 505.
        const resp505 = new Response('', { status: 505 });
        const fetcher = jest.fn().mockResolvedValue(resp505);

        const result = await withRetry(fetcher, {
            maxRetries: 3,
            retryWhitelist: [{ start: 500, end: 504 }],
        });

        expect(result).toBe(resp505);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('whitelist retries thrown error whose status is listed', async () => {
        const err403 = Object.assign(new Error('forbidden'), { status: 403 });
        const fetcher = jest.fn()
            .mockRejectedValueOnce(err403)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2, retryWhitelist: [403] });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('whitelist rejects thrown error whose status is unlisted', async () => {
        const err429 = Object.assign(new Error('quota'), { status: 429 });
        const fetcher = jest.fn().mockRejectedValue(err429);

        await expect(withRetry(fetcher, { maxRetries: 3, retryWhitelist: [403] })).rejects.toBe(err429);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('whitelist still retries network errors (no status)', async () => {
        // Errors without a `.status` are network-layer failures and always
        // retriable regardless of the whitelist.
        const netErr = new TypeError('Failed to fetch');
        const fetcher = jest.fn()
            .mockRejectedValueOnce(netErr)
            .mockResolvedValueOnce(new Response('ok', { status: 200 }));

        const promise = withRetry(fetcher, { maxRetries: 2, retryWhitelist: [403] });
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe(200);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
