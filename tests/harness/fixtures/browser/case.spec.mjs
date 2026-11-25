import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { test, expect } from '../../playwright.js';

const input = JSON.parse(process.env.BROWSER_LIFECYCLE_INPUT);
const runtime = { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
const modes = input.mode === 'parallel' ? ['left', 'right'] : input.mode === 'scenario' ? ['scenario-write', 'scenario-observe'] : [input.mode];
let shared;

if (['scenario', 'before-hook', 'after-all'].includes(input.mode)) test.beforeAll(async ({ workerResources }, info) => {
    const scenario = await workerResources.scenario(fileURLToPath(import.meta.url));
    const resources = await scenario.child({ kind: 'scenario', label: 'declared application sharing' });
    await resources.borrowDirectory(input.borrowed);
    const owned = await resources.directory('explicit file scenario data');
    const command = [process.execPath, new URL('./application.mjs', import.meta.url).pathname, JSON.stringify({ dataRoot: owned.path })];
    const lease = await resources.process({ label: 'shared browser application', command, readyLine: 'browser-resource-ready', dependsOn: [owned.resourceId] });
    const address = JSON.parse(fs.readFileSync(path.join(owned.path, 'bound.json'), 'utf8'));
    shared = { owned, command, lease, address };
    if (input.mode === 'before-hook') {
        fs.writeFileSync(path.join(input.root, `before-hook-${info.workerIndex}.json`), JSON.stringify({ owned, workerIndex: info.workerIndex, pid: lease.pid, port: address.port, runtime, applicationRuntime: address.runtime }));
        throw new Error('actual browser beforeAll acquisition failure');
    }
});

if (input.mode === 'after-hook') test.afterEach(() => { throw new Error('actual browser after-hook failure'); });
if (input.mode === 'after-all') test.afterAll(() => { throw new Error('actual browser afterAll failure'); });

for (const mode of modes) test(`native browser lifecycle ${mode}`, async ({ resources, workerResources, page }, testInfo) => {
    const owned = shared ? shared.owned : await resources.directory('browser application data');
    const receipt = path.join(input.root, `${mode}-${testInfo.workerIndex}.json`);
    fs.writeFileSync(receipt, JSON.stringify({ mode, owned, workerIndex: testInfo.workerIndex, project: testInfo.project.name, runtime }));
    if (mode === 'before-start') throw new Error('actual failure before application acquisition');
    const command = mode === 'startup' ? ['/unavailable-browser-resource-executable'] : [process.execPath, new URL('./application.mjs', import.meta.url).pathname, JSON.stringify({ dataRoot: owned.path, announce: !['startup-cancel', 'startup-worker-exit'].includes(mode) })];
    if (['startup-cancel', 'startup-worker-exit'].includes(mode)) console.log('BROWSER_STARTUP_SCOPE ' + JSON.stringify({ path: owned.path, workerPid: process.pid }));
    let lease = shared ? shared.lease : await resources.process({ label: 'actual browser application', command, readyLine: 'browser-resource-ready', dependsOn: [owned.resourceId] });
    const address = JSON.parse(fs.readFileSync(path.join(owned.path, 'bound.json'), 'utf8'));
    fs.writeFileSync(receipt, JSON.stringify({ mode, owned, workerIndex: testInfo.workerIndex, project: testInfo.project.name, pid: lease.pid, port: address.port, runtime, applicationRuntime: address.runtime, browserVersion: page.context().browser().version() }));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('output')).toHaveText(mode === 'scenario-observe' ? '8' : '4');
    expect(fs.readFileSync(path.join(owned.path, 'state.bin'))).toEqual(Buffer.from(mode === 'scenario-observe' ? [0, 255, 13, 10, 0, 255, 13, 10] : [0, 255, 13, 10]));
    if (mode === 'restart') {
        await lease.stop();
        expect(fs.readFileSync(path.join(owned.path, 'state.bin'))).toEqual(Buffer.from([0, 255, 13, 10]));
        lease = await resources.process({ label: 'restarted browser application', command, readyLine: 'browser-resource-ready', dependsOn: [owned.resourceId] });
        const restarted = JSON.parse(fs.readFileSync(path.join(owned.path, 'bound.json'), 'utf8'));
        expect(lease.pid).not.toBe(address.pid);
        fs.writeFileSync(receipt, JSON.stringify({ mode, owned, workerIndex: testInfo.workerIndex, project: testInfo.project.name, pid: lease.pid, port: restarted.port, previousPid: address.pid, previousPort: address.port, runtime, applicationRuntime: restarted.runtime }));
        await page.goto(`http://127.0.0.1:${restarted.port}`);
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('output')).toHaveText('8');
    }
    await testInfo.attach('actual-state.bin', { body: fs.readFileSync(path.join(owned.path, 'state.bin')), contentType: 'application/octet-stream' });
    await resources.captureDiagnostic({ name: 'case-state.bin', bytes: fs.readFileSync(path.join(owned.path, 'state.bin')), contentType: 'application/octet-stream' });
    if (mode === 'large-artifact') {
        await testInfo.attach('large-source.js', { body: fs.readFileSync(new URL('../../../../public/script.js', import.meta.url)), contentType: 'text/javascript' });
        throw new Error('actual failure retaining a complete source artifact');
    }
    if (mode === 'capture-input') await resources.captureDiagnostic({ name: 'invalid.bin', bytes: 'not a byte array', contentType: 'application/octet-stream' });
    if (mode === 'scope-kinds') {
        const child = await resources.child({ kind: 'scenario', label: 'case-owned scenario child' });
        const file = await workerResources.scenario(testInfo.file);
        expect(file.scopeId).not.toBe(child.scopeId);
        expect((await workerResources.scenario(testInfo.file)).scopeId).toBe(file.scopeId);
    }
    if (mode === 'diagnostic') {
        await testInfo.attach('unreadable-state.bin', { path: path.join(owned.path, 'state.bin'), contentType: 'application/octet-stream' });
        fs.chmodSync(testInfo.attachments.find(attachment => attachment.name === 'unreadable-state.bin').path, 0o000);
    }
    if (mode === 'cleanup') fs.chmodSync(owned.path, 0o500);
    if (mode === 'cancel') {
        console.log('BROWSER_LIFECYCLE_READY');
        await page.waitForEvent('close');
    }
    if (mode === 'assertion' || mode === 'profile-isolation') expect('actual browser assertion').toBe('different expected value');
    if (mode === 'retry' && testInfo.retry === 0) throw new Error('actual failed attempt before native retry');
});
