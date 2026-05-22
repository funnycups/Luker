import { defineConfig } from '@playwright/test';

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        // Honor PLAYWRIGHT_BASE_URL when set so e2e suites run from a
        // worktree-spawned dev server on a non-default port (e.g. when
        // the main workspace is already binding 8000). Default unchanged.
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8000',
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 4,
    fullyParallel: true,
});
