import { defineConfig } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// Two test families live in this repo:
//
//   1. tests/e2e/**/*.e2e.js — real black-box e2e specs. Each spec spawns
//      its own server via _lib/server.js (worker-scoped fixture, OS-assigned
//      free port). No shared dev server, no PLAYWRIGHT_BASE_URL needed.
//      This is the default `npm run test:e2e` target.
//
//   2. tests/frontend/**/*.{e2e,test}.js + tests/skills-ui/playwright/*.spec.js
//      — legacy browser-hosted integration smokes that boot the app via
//      `page.goto('/')` and call ST modules through page.evaluate. They
//      REQUIRE a running server with the project's seed data, plus (in many
//      cases) a live LLM endpoint configured by the developer running them.
//      The config boots that server itself on an OS-assigned free port.
//      They are NOT part of the e2e regression suite — they are manual smokes
//      a dev runs against their own dev env. Run them via
//      `npm run test:integration`.
//
// To keep the default `npx playwright test` focused on the black-box e2e
// suite, the frontend + skills-ui projects are gated behind the
// PW_INCLUDE_INTEGRATION env var. CI / npm run test:e2e leave it unset.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FRONTEND_SCRATCH = resolve(REPO_ROOT, 'tests/.frontend-scratch');
const FRONTEND_DATA = resolve(FRONTEND_SCRATCH, 'data');
const FRONTEND_CONFIG = resolve(FRONTEND_SCRATCH, 'config.yaml');
const INCLUDE_INTEGRATION = !!process.env.PW_INCLUDE_INTEGRATION;

/**
 * Reserve an OS-assigned free port for the integration webServer. The
 * integration family boots its own server instead of expecting a dev server,
 * so binding a hardcoded port collides with any unrelated process already
 * listening there. Port 0 lets the OS pick; the chosen port is written back
 * into ST_BASE_URL / PLAYWRIGHT_BASE_URL so the webServer command and the
 * specs (frontent-test-utils.js reads the same env vars) agree on it.
 * Config evaluation is synchronous, so the port is obtained by running a
 * short node one-liner that binds port 0 and prints what the OS assigned.
 * @returns {number}
 */
function reserveIntegrationPort() {
    const out = execSync(
        'node -e "const n=require(\'net\');const s=n.createServer();s.listen({host:\'127.0.0.1\',port:0},()=>{console.log(s.address().port);s.close();});"',
        { encoding: 'utf8' },
    );
    const port = Number(String(out).trim());
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Could not reserve an integration port (got "${out}")`);
    }
    return port;
}

const projects = [
    {
        name: 'e2e',
        testMatch: ['e2e/**/*.e2e.js'],
        testIgnore: ['**/_lib/**', '**/_fixtures/**', '**/.e2e-scratch/**', '**/node_modules/**'],
    },
];

if (INCLUDE_INTEGRATION) {
    projects.push(
        {
            name: 'frontend',
            testMatch: ['frontend/**/*.e2e.js', 'frontend/**/*.test.js'],
            testIgnore: ['**/node_modules/**'],
        },
        {
            name: 'skills-ui',
            testMatch: ['skills-ui/playwright/**/*.spec.js'],
            testIgnore: ['**/node_modules/**'],
        },
    );
}

let baseURL = process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000';
let integrationPort = 0;

if (INCLUDE_INTEGRATION && !process.env.ST_BASE_URL && !process.env.PLAYWRIGHT_BASE_URL) {
    integrationPort = reserveIntegrationPort();
    baseURL = `http://127.0.0.1:${integrationPort}`;
    // Specs (frontent-test-utils.js) read these env vars directly; publish
    // the resolved origin so the webServer and the browsers agree on it.
    process.env.ST_BASE_URL = baseURL;
    process.env.PLAYWRIGHT_BASE_URL = baseURL;
}

export default defineConfig({
    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
    fullyParallel: true,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    timeout: 120_000,
    // The integration suites boot their own server. It binds an OS-assigned
    // free port (see reserveIntegrationPort) so the run never collides with
    // an unrelated process already listening on a fixed port. The command
    // first rebuilds the scratch data root (see prepare-scratch-data.mjs) so
    // the wipe happens exactly once, immediately before this boot — running
    // it at config-evaluation time would wipe the data root from the second
    // config evaluation (Playwright loads the config in two processes) after
    // the webpack bundles had already been compiled into it.
    // Omitted entirely for the e2e black-box project, which spawns a per-spec
    // server on its own port.
    ...(INCLUDE_INTEGRATION && integrationPort ? {
        webServer: {
            command: `node tests/frontend/prepare-scratch-data.mjs && node server.js --port=${integrationPort} --dataRoot="${FRONTEND_DATA}" --configPath="${FRONTEND_CONFIG}" --browserLaunchEnabled=false --listen=false --whitelist=127.0.0.1 --disableCsrf=false`,
            cwd: REPO_ROOT,
            url: `http://127.0.0.1:${integrationPort}/`,
            reuseExistingServer: false,
            timeout: 180_000,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    } : {}),
    projects,
});


