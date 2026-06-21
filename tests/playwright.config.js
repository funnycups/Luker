import { defineConfig } from '@playwright/test';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
//      REQUIRE a running dev server on 127.0.0.1:8000 with the project's
//      seed data, plus (in many cases) a live LLM endpoint configured by
//      the developer running them. They are NOT part of the e2e regression
//      suite — they are manual smokes a dev runs against their own dev
//      env. Run them via `npm run test:integration` after starting your
//      own dev server.
//
// To keep the default `npx playwright test` focused on the black-box e2e
// suite, the frontend + skills-ui projects are gated behind the
// PW_INCLUDE_INTEGRATION env var. CI / npm run test:e2e leave it unset.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const FRONTEND_SCRATCH = resolve(REPO_ROOT, 'tests/.frontend-scratch');
const FRONTEND_DATA = resolve(FRONTEND_SCRATCH, 'data');
const FRONTEND_CONFIG = resolve(FRONTEND_SCRATCH, 'config.yaml');
const INCLUDE_INTEGRATION = !!process.env.PW_INCLUDE_INTEGRATION;

function prepareFrontendDataRoot() {
    mkdirSync(FRONTEND_SCRATCH, { recursive: true });
    if (existsSync(FRONTEND_DATA)) rmSync(FRONTEND_DATA, { recursive: true, force: true });
    const SEED_DATA = resolve(REPO_ROOT, 'data');
    try {
        execSync(`cp -c -R "${SEED_DATA}" "${FRONTEND_DATA}"`, { stdio: 'ignore' });
    } catch {
        execSync(`cp -R "${SEED_DATA}" "${FRONTEND_DATA}"`, { stdio: 'ignore' });
    }
    const raw = readFileSync(resolve(REPO_ROOT, 'config.yaml'), 'utf8');
    const patched = raw.replace(/^(\s+mode\s*):\s*[^\n]*$/m, '$1: fs');
    writeFileSync(FRONTEND_CONFIG, patched, 'utf8');
}

if (INCLUDE_INTEGRATION) prepareFrontendDataRoot();

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

export default defineConfig({
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
    fullyParallel: true,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    timeout: 120_000,
    // The integration suites need a long-lived dev server on 8000. Spawn
    // one only when the developer asked for the integration projects;
    // omit otherwise to avoid binding port 8000 during the e2e black-box
    // run (the e2e project assigns its own per-spec OS ports).
    ...(INCLUDE_INTEGRATION ? {
        webServer: {
            command: `node server.js --port=8000 --dataRoot="${FRONTEND_DATA}" --configPath="${FRONTEND_CONFIG}" --browserLaunchEnabled=false --listen=false --whitelist=127.0.0.1 --disableCsrf=false`,
            cwd: REPO_ROOT,
            url: 'http://127.0.0.1:8000/',
            reuseExistingServer: true,
            timeout: 180_000,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    } : {}),
    projects,
});


