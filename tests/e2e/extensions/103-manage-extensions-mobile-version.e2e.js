import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { test, expect } from '../../harness/playwright.js';
import { startServer } from '../../harness/server.js';
import { markOnboarded } from '../_lib/fixtures.js';
import { awaitMainUI, openExtensionsDrawer } from '../_lib/page.js';

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];

function startGitHttpServer(projectRoot, emptyGitConfig) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const child = spawn('git', ['http-backend'], {
            env: {
                ...process.env,
                GIT_CONFIG_GLOBAL: emptyGitConfig,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_PROJECT_ROOT: projectRoot,
                GIT_HTTP_EXPORT_ALL: '1',
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.slice(1),
                REQUEST_METHOD: req.method,
                CONTENT_TYPE: req.headers['content-type'] || '',
                REMOTE_ADDR: '127.0.0.1',
            },
        });
        req.pipe(child.stdin);
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.on('close', () => {
            const output = Buffer.concat(chunks);
            const separator = output.indexOf('\r\n\r\n');
            let status = 200;
            for (const line of output.subarray(0, separator).toString().split('\r\n')) {
                const colon = line.indexOf(':');
                const name = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === 'status') status = parseInt(value, 10);
                else res.setHeader(name, value);
            }
            res.statusCode = status;
            res.end(output.subarray(separator + 4));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let gitHttpServer;
let scratch;
let repoUrl;
let headSha;

test.beforeAll(async ({ workerResources }, testInfo) => {
    const scope = await workerResources.scenario(testInfo.file);
    scratch = (await scope.directory('luker-e2e-ext-ver')).path;
    const emptyGitConfig = path.join(scratch, 'empty-gitconfig');
    fs.writeFileSync(emptyGitConfig, '');
    const gitRun = (cwd, ...args) => execFileSync('git', [...IDENTITY, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();

    const srcRepo = path.join(scratch, 'src');
    fs.mkdirSync(srcRepo, { recursive: true });
    gitRun(srcRepo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(srcRepo, 'manifest.json'), JSON.stringify({
        display_name: '酒馆扩展助手工具箱',
        version: '4.12.1',
        author: 'TestAuthor',
        js: 'index.js',
    }));
    fs.writeFileSync(path.join(srcRepo, 'index.js'), '');
    gitRun(srcRepo, 'add', '.');
    gitRun(srcRepo, 'commit', '-q', '-m', 'init');
    headSha = gitRun(srcRepo, 'rev-parse', 'HEAD');

    const httpRoot = path.join(scratch, 'http-root');
    const bareRepo = path.join(httpRoot, 'helper-toolbox.git');
    gitRun(scratch, 'clone', '-q', '--bare', srcRepo, bareRepo);
    gitHttpServer = await startGitHttpServer(httpRoot, emptyGitConfig);
    repoUrl = `http://127.0.0.1:${gitHttpServer.address().port}/helper-toolbox.git`;

    server = await startServer({ scope, batchKey: 'extensions', scenarioId: '103-mobile-ext-version' });
    markOnboarded({ dataRoot: server.dataRoot });

    // Seed a synced/non-git extension directory (no .git) to verify it does not render '(-)'
    const syncedExtDir = path.join(server.dataRoot, 'default-user', 'extensions', 'synced-no-git-ext');
    fs.mkdirSync(syncedExtDir, { recursive: true });
    fs.writeFileSync(path.join(syncedExtDir, 'manifest.json'), JSON.stringify({
        display_name: '同步无仓库扩展',
        version: '2.3.4',
        js: 'index.js',
    }));
    fs.writeFileSync(path.join(syncedExtDir, 'index.js'), '');
});

test.afterAll(async () => {
    if (gitHttpServer?.listening) {
        await new Promise((resolve) => gitHttpServer.close(resolve));
    }
});

test('mobile Manage Extensions shows full git branch-commit without clipping and omits empty (-) on non-git extensions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await awaitMainUI(page, server.baseURL);

    // Open Extensions panel via real top-bar click and install the git-backed extension via UI
    await openExtensionsDrawer(page);
    await page.locator('#third_party_extension_button').click();
    const installDialog = page.locator('dialog.popup[open]').last();
    await installDialog.locator('.popup-input').fill(repoUrl);
    await installDialog.locator('.popup-button-ok').click();

    // Confirm third-party extension installation warning
    const warningDialog = page.locator('dialog.popup[open]', { has: page.locator('#dontAskAgain') });
    await warningDialog.locator('.popup-button-ok').click();
    await warningDialog.waitFor({ state: 'detached', timeout: 10_000 });

    await expect(page.locator('#toast-container .toast-success')).toBeVisible({ timeout: 15_000 });

    // Open Manage Extensions via real click and wait for both /api/extensions/version responses
    const versionCalls = [];
    page.on('response', (res) => {
        if (res.url().endsWith('/api/extensions/version')) {
            versionCalls.push(res.status());
        }
    });

    await page.locator('#extensions_details').click();
    await expect(page.locator('.extensions_info')).toBeVisible();
    await expect.poll(() => versionCalls.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    const gitRow = page.locator('.extensions_info .extension_block[data-name="/helper-toolbox"]');
    const expectedVersionText = `4.12.1 (main-${headSha.slice(0, 7)})`;
    await expect(gitRow.locator('.extension_version')).toHaveText(expectedVersionText);

    // Scroll row into view and verify the version text is not horizontally clipped on a 390px screen
    await gitRow.scrollIntoViewIfNeeded();
    const layout = await gitRow.evaluate((el) => {
        const tb = el.querySelector('.extension_text_block');
        const ver = el.querySelector('.extension_version');
        const tbRect = tb.getBoundingClientRect();
        const verRect = ver.getBoundingClientRect();
        return {
            tbLeft: tbRect.left,
            tbRight: tbRect.right,
            verLeft: verRect.left,
            verRight: verRect.right,
            verWidth: verRect.width,
            verHeight: verRect.height,
        };
    });
    expect(layout.verWidth).toBeGreaterThan(60);
    expect(layout.verHeight).toBeGreaterThan(10);
    expect(layout.verLeft).toBeGreaterThanOrEqual(layout.tbLeft - 1);
    expect(layout.verRight).toBeLessThanOrEqual(layout.tbRight + 1);

    // Non-git synced extension keeps its manifest version without appending '(-)'
    const syncedRow = page.locator('.extensions_info .extension_block[data-name="/synced-no-git-ext"]');
    await expect(syncedRow.locator('.extension_version')).toHaveText('2.3.4');
});
