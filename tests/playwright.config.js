import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const INCLUDE_DESKTOP = !!process.env.PW_INCLUDE_DESKTOP;
const INCLUDE_DESKTOP_PACKAGED = !!process.env.PW_INCLUDE_DESKTOP_PACKAGED;

const projects = [
    {
        name: 'e2e',
        testMatch: ['e2e/**/*.e2e.js'],
        testIgnore: ['**/_lib/**', '**/_fixtures/**', '**/.e2e-scratch/**', '**/node_modules/**', '**/e2e/desktop/**', '**/cross-mode-recovery/99-real-data-*.e2e.js'],
    },
    {
        name: 'frontend',
        workers: 1,
        fullyParallel: false,
        testMatch: ['frontend/**/*.e2e.js', 'frontend/**/*.test.js'],
        testIgnore: ['**/node_modules/**'],
    },
    {
        name: 'compatibility',
        testMatch: ['e2e/storage/cross-mode-recovery/99-real-data-*.e2e.js'],
    },
];

if (INCLUDE_DESKTOP) {
    projects.push({
        name: 'desktop',
        testMatch: ['e2e/desktop/**/*.e2e.js'],
        testIgnore: ['**/_lib/**', '**/.e2e-scratch/**', '**/node_modules/**', 'e2e/desktop/04-packaged.e2e.js'],
    });
}

if (INCLUDE_DESKTOP_PACKAGED) {
    projects.push({
        name: 'desktop-packaged',
        testMatch: ['e2e/desktop/04-packaged.e2e.js'],
        testIgnore: ['**/_lib/**', '**/.e2e-scratch/**', '**/node_modules/**'],
    });
}

export default defineConfig({
    testDir: import.meta.dirname,
    outputDir: resolve(REPO_ROOT, 'test-results/playwright'),
    use: {
        video: 'retain-on-failure',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 4,
    fullyParallel: true,
    reporter: process.env.CI ? [['github'], ['list']] : [['list']],
    timeout: 120_000,
    projects,
});
