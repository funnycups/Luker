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

import { test, expect } from '@playwright/test';
import { startServer, tearDownServer } from '../_lib/server.js';
import { markOnboarded } from '../_lib/fixtures.js';

let server;

// config.yaml has basicAuthUser.username=user, basicAuthUser.password=password.
const BASIC_USER = 'user';
const BASIC_PASS = 'password';

test.beforeAll(async () => {
    server = await startServer({
        batchKey: 'server',
        scenarioId: 'basic-auth',
        extraEnv: {
            // No env override needed for the basic auth credentials — the
            // bundled config.yaml ships the defaults this test uses.
        },
    });
    markOnboarded({ dataRoot: server.dataRoot });
    // Re-spawn with --listen + --basicAuthMode. The default startServer call
    // passes --listen=false, which skips the basicAuth middleware mount.
    // Tear it down and re-spawn here in beforeAll.
    await server.stop();

    // Stash the helpful fields, then manually spawn a node child with the
    // overrides. We replicate the spawn pattern from _lib/server.js but only
    // need a subset of behavior.
    const { spawn } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const REPO_ROOT = resolve(import.meta.dirname, '../../..');
    let child = null;
    const port = server.port;
    const dataRoot = server.dataRoot;

    async function probe(p) {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                // `redirect: 'manual'` keeps Node fetch from following the
                // login/root redirect chain past its limit before our 401/302/200
                // ready signal lands. (Without this, basicAuth + multi-redirect
                // configurations hit "redirect count exceeded" forever.)
                const res = await fetch(`http://127.0.0.1:${p}/`, { method: 'GET', redirect: 'manual' });
                if (res.status === 401 || res.status === 302 || res.status === 200) return;
            } catch {}
            await new Promise(r => setTimeout(r, 250));
        }
        throw new Error(`server on port ${p} did not become ready`);
    }

    async function spawnOnce() {
        child = spawn('node', [
            'server.js',
            `--port=${port}`,
            `--dataRoot=${dataRoot}`,
            '--browserLaunchEnabled=false',
            '--listen=true',
            '--basicAuthMode=true',
            '--whitelist=127.0.0.1',
            '--disableCsrf=false',
        ], {
            cwd: REPO_ROOT,
            env: { ...process.env, NODE_ENV: 'production' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', () => {});
        child.stderr.on('data', d => process.stderr.write(`[srv:${port}] ${d}`));
        await probe(port);
    }
    await spawnOnce();

    server.stop = async () => {
        if (!child) return;
        try {
            child.kill('SIGTERM');
            await new Promise((resolve) => {
                const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} ; resolve(); }, 3000);
                child.once('exit', () => { clearTimeout(t); resolve(); });
            });
        } catch {}
        child = null;
    };
});

test.afterAll(async () => {
    await tearDownServer(server);
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
        expect(toastErrors.length, `expected no CSRF toast errors; saw ${toastErrors.join(' | ')}`).toBe(0);

        await ctx.close();
    });
});
