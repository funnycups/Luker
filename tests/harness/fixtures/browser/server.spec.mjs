import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect } from '../../playwright.js';
import { startServer } from '../../server.js';
import { openTopDrawer } from '../../../e2e/_lib/page.js';

const input = JSON.parse(process.env.BROWSER_LIFECYCLE_INPUT);
const bytes = Buffer.from([0, 255, 13, 10, 42]);

test('registered application startup', async ({ resources, page }, info) => {
    const options = { scope: resources, batchKey: 'application', scenarioId: input.mode };
    let selected;
    if (input.mode === 'server-owned' || input.mode === 'server-foreign') {
        selected = await resources.directory('selected application data');
        fs.mkdirSync(path.join(selected.path, 'default-user'));
        fs.writeFileSync(path.join(selected.path, 'default-user/settings.json'), JSON.stringify({ firstRun: false, power_user: { auto_connect: false } }));
        fs.writeFileSync(path.join(selected.path, 'selected.bin'), bytes);
        if (input.mode === 'server-foreign') {
            const stat = fs.statSync(input.borrowed);
            selected = { ...selected, path: input.borrowed, dev: stat.dev, ino: stat.ino };
        }
        options.data = selected;
    }
    if (input.mode === 'server-borrowed') options.data = await resources.borrowDirectory(input.borrowed);
    if (input.mode === 'server-invalid-init') options.extraConfig = { protocol: { ipv4: false, ipv6: false } };
    if (input.mode === 'server-ipv6') options.extraConfig = { protocol: { ipv4: false, ipv6: true } };
    const server = await startServer(options);
    if (input.mode === 'server-ipv6') expect(new URL(server.baseURL).hostname).toBe('[::1]');
    let previousPid;
    if (input.mode === 'server-owned') {
        expect(server.dataRoot).toBe(selected.path);
        expect(fs.readFileSync(path.join(server.dataRoot, 'selected.bin'))).toEqual(bytes);
    }
    if (input.mode === 'server-borrowed') {
        expect(server.dataRoot).not.toBe(input.borrowed);
        expect(fs.readFileSync(path.join(server.dataRoot, 'original'))).toEqual(fs.readFileSync(path.join(input.borrowed, 'original')));
        fs.writeFileSync(path.join(server.dataRoot, 'only-owned-copy'), bytes);
        expect(fs.existsSync(path.join(input.borrowed, 'only-owned-copy'))).toBe(false);
    }
    if (input.mode === 'server-start' || input.mode === 'server-restart') {
        await page.goto(server.baseURL);
        await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
        await expect(page.locator('#send_textarea')).toBeVisible();
    }
    if (input.mode === 'server-restart') {
        const url = server.baseURL;
        previousPid = server.pid;
        fs.writeFileSync(path.join(server.dataRoot, 'restart-state.bin'), bytes);
        await server.stop();
        expect(fs.readFileSync(path.join(server.dataRoot, 'restart-state.bin'))).toEqual(bytes);
        await server.restart();
        expect(server.baseURL).toBe(url);
        expect(fs.readFileSync(path.join(server.dataRoot, 'restart-state.bin'))).toEqual(bytes);
        await page.reload();
        await page.waitForFunction(() => performance.getEntriesByName('[init] complete').length > 0);
    }
    if (input.mode === 'server-start') {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').selectOption('openai');
        await openTopDrawer(page, 'ai-config-button');
        for (const value of [778, 779]) {
            const saved = page.waitForResponse(response => {
                const endpoint = new URL(response.url()).pathname;
                if (response.request().method() !== 'POST' || !['/api/settings/save', '/api/settings/patch'].includes(endpoint)) return false;
                const payload = response.request().postDataJSON();
                return endpoint === '/api/settings/save' ? payload.oai_settings.openai_max_tokens === value
                    : payload.operations.some(operation => operation.op === 'replace' && operation.path === '/oai_settings/openai_max_tokens' && operation.value === value);
            });
            await page.locator('#openai_max_tokens').fill(String(value));
            await page.locator('#openai_max_tokens').blur();
            expect((await saved).ok()).toBe(true);
        }
    }
    const version = await page.request.get(server.baseURL + '/version');
    expect(version.ok()).toBe(true);
    expect((await version.json()).updateCheckDisabled).toBe(true);
    const csrf = await page.request.get(server.baseURL + '/csrf-token');
    expect(csrf.ok()).toBe(true);
    const exported = await page.request.post(server.baseURL + '/api/debug/export', { headers: { 'x-csrf-token': (await csrf.json()).token }, data: {} });
    expect(exported.ok()).toBe(true);
    const observed = await exported.json();
    const receipt = { pid: server.pid, previousPid, port: server.port, baseURL: server.baseURL, dataRoot: server.dataRoot, configOwner: server.owner, dataOwner: server.dataOwner, resourceId: server.resourceId, applicationVersion: observed.runtime.node, workerRuntime: { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(import.meta.filename)).digest('hex') } };
    if (input.mode === 'server-start') {
        await server.stop();
        const directory = path.join(server.dataRoot, 'default-user/backups');
        const snapshots = fs.readdirSync(directory).filter(name => name.startsWith('settings_')).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
        expect(snapshots.some(snapshot => snapshot.oai_settings?.openai_max_tokens === 779)).toBe(true);
    }
    const destination = path.join(input.root, `server-ready-${info.workerIndex}.json`);
    fs.writeFileSync(destination + '.tmp', JSON.stringify(receipt), { flag: 'wx' });
    fs.renameSync(destination + '.tmp', destination);
    if (input.mode === 'server-conflict') await startServer({ scope: await resources.child({ kind: 'scenario', label: 'occupied port' }), batchKey: 'application', scenarioId: 'occupied', extraConfig: { port: server.port } });
});
