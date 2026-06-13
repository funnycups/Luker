import { defineConfig } from '@playwright/test';

export default defineConfig({
    // Match three families:
    //   1. `**/*.e2e.js`                                  legacy Luker e2e suites under tests/frontend/
    //   2. `**/skills-ui/playwright/**/*.spec.js`         skills-UI smoke specs (Plan 2 Unit 8)
    //   3. `tests/e2e/**/*.e2e.js`                        expanded e2e suite (this task)
    // Excludes the per-batch scratch dir + the shared _lib + _fixtures.
    testMatch: ['**/*.e2e.js', '**/skills-ui/playwright/**/*.spec.js', 'e2e/**/*.e2e.js'],
    testIgnore: [
        '**/_lib/**',
        '**/_fixtures/**',
        '**/.e2e-scratch/**',
        '**/node_modules/**',
    ],
    use: {
        // Honor PLAYWRIGHT_BASE_URL when set so e2e suites run from a
        // worktree-spawned dev server on a non-default port (e.g. when
        // the main workspace is already binding 8000). Default unchanged.
        // The expanded e2e suite under tests/e2e/** ignores this and
        // spawns its own server via _lib/server.js — each spec owns its
        // own port + dataRoot, so the baseURL fixture is per-spec.
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
    fullyParallel: true,
    reporter: process.env.CI ? [['github'], ['list']] : 'list',
    timeout: 120_000,
});
