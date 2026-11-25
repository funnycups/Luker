import { expect } from '@jest/globals';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, resolveWarmupBundlesDir } from '../harness/server.js';
import { testWithResources } from '../harness/jest.js';
import '../../src/fetch-patch.js';

testWithResources('controlled restarts retain port and user data and expose actual process exit and jitless argv', async scope => {
    const address = Object.values(os.networkInterfaces()).flat().find(x => x.family === 'IPv4' && !x.internal)?.address;
    expect(address).toBeTruthy();
    const config = { listen: false, securityOverride: true, whitelistMode: false };
    const env = { LUKER_LIFECYCLE_FIXTURE: 'initial' };
    const server = await startServer({ scope, batchKey: 'sync', scenarioId: 'lifecycle', extraConfig: config, extraEnv: env });
    const port = server.port;
    const root = server.dataRoot;
    const settingsPath = path.join(root, 'default-user', 'settings.json');
    const settings = fs.readFileSync(settingsPath, 'utf8');
    const health = () => fetch(`${server.baseURL}/api/sync/v1/health`).then(r => r.json());
    expect(await health()).toMatchObject({ protocol: 2 });
    await expect(fetch(`http://${address}:${port}/api/sync/v1/health`)).rejects.toThrow();
    config.listen = true;
    env.LUKER_LIFECYCLE_FIXTURE = 'mutated';
    const firstOutput = server.output;
    expect(firstOutput.length).toBeGreaterThan(0);
    await server.restart();
    expect(server.outputEpochs).toHaveLength(2);
    expect(server.outputEpochs[0].includes(firstOutput)).toBe(true);
    await expect(fetch(`http://${address}:${port}/api/sync/v1/health`)).rejects.toThrow();
    const bundles = resolveWarmupBundlesDir(root);
    expect(bundles).toBeTruthy();
    await server.restart({ extraConfig: { listen: true }, extraEnv: { LUKER_PREBUILT_BUNDLES_DIR: bundles }, jitless: true });
    expect(server.port).toBe(port);
    expect(server.dataRoot).toBe(root);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settings);
    expect(server.execArgv[0]).toBe('--jitless');
    await server.waitForStderr('Security has been overridden');
    expect(await (await fetch(`http://${address}:${port}/api/sync/v1/health`)).json()).toMatchObject({ protocol: 2 });
    expect(await server.kill()).toEqual({ signal: 'SIGKILL', code: null });
    await expect(health()).rejects.toThrow();
    await server.restart();
    expect(await health()).toMatchObject({ protocol: 2 });
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settings);
    expect(server.outputEpochs).toHaveLength(4);
}, 180_000);

testWithResources('the sync acceptance runtime switch returns only an actual jitless server backed by the real warmup bundles', async scope => {
    const previous = process.env.LUKER_SYNC_ACCEPTANCE_JITLESS;
    process.env.LUKER_SYNC_ACCEPTANCE_JITLESS = '1';
    let server;
    try {
        server = await startServer({ scope, batchKey: 'sync', scenarioId: 'acceptance-runtime' });
        expect(server.execArgv).toContain('--jitless');
        expect(server.outputEpochs).toHaveLength(2);
        expect((await (await fetch(`${server.baseURL}/api/sync/v1/health`)).json()).protocol).toBe(2);
    } finally {
        if (previous === undefined) delete process.env.LUKER_SYNC_ACCEPTANCE_JITLESS;
        else process.env.LUKER_SYNC_ACCEPTANCE_JITLESS = previous;
    }
}, 180_000);
