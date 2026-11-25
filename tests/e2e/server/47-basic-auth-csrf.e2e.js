// #47 — basicAuth + CSRF full flow.
//
// Mirrors and extends the unit-level coverage in tests/basicAuth.test.js to
// a real-server e2e:
//   - boot a server with --listen=true + basicAuthMode=true (basicAuth
//     middleware is only mounted when both are true, per src/server-main.js
//     line 246)
//   - unauthenticated request → 401 + WWW-Authenticate header
//   - request with correct Basic credentials → 200
//   - CSRF: after authenticating + loading the page, a real POST to a
//     protected endpoint without an x-csrf-token header → 403, and with
//     the minted token → 2xx

import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

let server;

// config.yaml has basicAuthUser.username=user, basicAuthUser.password=password.
const BASIC_USER = 'user';
const BASIC_PASS = 'password';

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    server = await startServer({ scope,
        batchKey: 'server',
        scenarioId: 'basic-auth',
        extraConfig: {
            listen: true,
            basicAuthMode: true,
            basicAuthUser: { username: BASIC_USER, password: BASIC_PASS },
            whitelist: ['127.0.0.1'],
        },
    });
    markOnboarded({ dataRoot: server.dataRoot });
});



test.describe('#47 — basicAuth + CSRF full flow', () => {
    test('basicAuth: unauthenticated → 401; correct credentials → 200', async () => {
        // Unauthenticated.
        const noCreds = await fetch(`${server.baseURL}/`, { redirect: 'manual' });
        expect(noCreds.status, `expected 401 with no Authorization header, got ${noCreds.status}`).toBe(401);
        const wwwAuth = noCreds.headers.get('www-authenticate');
        expect(wwwAuth || '', 'WWW-Authenticate header missing on 401').toMatch(/Basic/);

        // Correct credentials.
        const okCreds = await fetch(`${server.baseURL}/`, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString('base64'),
            },
            redirect: 'manual',
        });
        expect([200, 302]).toContain(okCreds.status);
    });

    test('basicAuth: wrong credentials → 401', async () => {
        const wrong = await fetch(`${server.baseURL}/`, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from('user:nope').toString('base64'),
            },
            redirect: 'manual',
        });
        expect(wrong.status, `wrong creds got ${wrong.status}`).toBe(401);
    });

    test('CSRF: protected POST without token → 403; with minted token → not 403', async ({ browser }) => {
        // We need a browser context that carries the basic-auth Authorization
        // header automatically. Use http_credentials to set it for every
        // request made by the page.
        const ctx = await browser.newContext({
            httpCredentials: { username: BASIC_USER, password: BASIC_PASS },
        });
        const page = await ctx.newPage();

        // Load root to acquire session cookie.
        const rootResp = await page.goto(`${server.baseURL}/`);
        expect(rootResp.ok() || rootResp.status() === 302, 'root should be reachable with creds').toBe(true);

        // Mint a CSRF token.
        const csrfResp = await page.evaluate(async () => {
            const r = await fetch('/csrf-token', { credentials: 'same-origin' });
            return { status: r.status, body: await r.text() };
        });
        expect(csrfResp.status).toBe(200);
        const { token } = JSON.parse(csrfResp.body);
        expect(typeof token).toBe('string');
        expect(token.length).toBeGreaterThan(8);

        // POST without CSRF token → should be rejected by csrfSync (403).
        const noToken = await page.evaluate(async () => {
            const r = await fetch('/api/settings/save', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            return { status: r.status };
        });
        expect(noToken.status, `missing CSRF token should be rejected; got ${noToken.status}`).toBe(403);

        // POST with valid CSRF token → not a CSRF rejection.
        const withToken = await page.evaluate(async (tok) => {
            const r = await fetch('/api/settings/save', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok },
                body: JSON.stringify({}),
            });
            return { status: r.status };
        }, token);
        expect(withToken.status, `valid CSRF token should not be rejected; got ${withToken.status}`).not.toBe(403);

        await ctx.close();
    });

    test('CSRF (UI): real settings save via Luker.getContext().saveSettings succeeds (no 403 toast)', async ({ browser }) => {
        // The SPA's settings save path runs through getRequestHeaders()
        // which auto-attaches X-CSRF-Token. This test confirms the full
        // round-trip via the same path a user gesture triggers — e.g.
        // every checkbox-toggled drawer ultimately calls ctx.saveSettings.
        // We do NOT inject the token by hand; the SPA does.
        const ctx = await browser.newContext({
            httpCredentials: { username: BASIC_USER, password: BASIC_PASS },
        });
        const page = await ctx.newPage();
        await page.goto(`${server.baseURL}/`);
        await page.waitForFunction(() => document.getElementById('preloader') === null, { timeout: 60_000 });
        await page.waitForFunction(() => !!window.Luker?.getContext, { timeout: 30_000 });

        // Watch for a toastr error (CSRF rejection would surface as a
        // 403-derived "Forbidden" or similar toast).
        const toastErrors = [];
        await page.exposeFunction('__recordToastError', (msg) => { toastErrors.push(msg); });
        await page.evaluate(() => {
            const obs = new MutationObserver(() => {
                const errs = document.querySelectorAll('#toast-container .toast-error');
                errs.forEach(e => {
                    const t = e.textContent || '';
                    if (/forbidden|csrf|403/i.test(t)) {
                        // @ts-ignore
                        window.__recordToastError?.(t);
                    }
                });
            });
            obs.observe(document.body, { childList: true, subtree: true });
        });

        // Drive a real save via the production saveSettings API. The same
        // call is fired by every checkbox-flip in User Settings.
        const result = await page.evaluate(async () => {
            const ctx = window.Luker.getContext();
            try {
                await ctx.saveSettings();
                return { ok: true };
            } catch (e) {
                return { ok: false, error: String(e?.message || e) };
            }
        });
        expect(result.ok, `saveSettings should succeed (no CSRF reject); got error: ${result.error || ''}`).toBe(true);

        await page.waitForTimeout(500);
        expect(toastErrors, `expected no CSRF toast errors; saw ${toastErrors.join(' | ')}`).toHaveLength(0);

        await ctx.close();
    });
});
