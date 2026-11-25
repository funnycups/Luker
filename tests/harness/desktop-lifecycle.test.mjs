import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { test as managedTest } from './node.js';
import { createRun } from './resources/run.js';
import { readDiagnostic } from './resources/diagnostics.js';
import {
    launchLukerDesktop,
    resolvePackagedDesktopArtifact,
    resolveSourceDesktopRuntime,
    spawnLukerDesktop,
} from '../e2e/_lib/desktop.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const runOptions = {
    projectRoot: repository,
    profile: 'desktop',
    command: [process.execPath, '--test', 'harness/desktop-lifecycle.test.mjs'],
    source: 'desktop-lifecycle-contract',
};

const leakedPids = new Set();

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

async function assertProcessDead(pid, label = 'desktop process') {
    if (!Number.isInteger(pid) || pid <= 0) return;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(isProcessAlive(pid), false, `${label} (pid ${pid}) is still running`);
}

async function assertNoListener(port) {
    if (!Number.isInteger(port) || port <= 0) return;
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            reject(new Error(`Desktop backend port ${port} is still listening`));
        });
        socket.once('error', error => {
            if (error.code === 'ECONNREFUSED') resolve();
            else reject(error);
        });
    });
}

after(() => {
    for (const pid of leakedPids) {
        if (isProcessAlive(pid)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
});

test('source app relaunch retains userData and close immediately reclaims auto-created userData', async () => {
    let originalUserData;
    let firstPid;
    let secondPid;
    let secondPort;

    const summary = await managedTest('desktop-source-relaunch-close', runOptions, async (_t, scope) => {
        const desktop = await launchLukerDesktop({ scope, scenarioId: 'lifecycle-relaunch' });
        firstPid = desktop.electronApp.process().pid;
        leakedPids.add(firstPid);
        originalUserData = desktop.userData;

        assert.equal(desktop.packaged, false);
        assert.equal(desktop.platform, process.platform);
        assert.equal(desktop.arch, process.arch);
        assert.ok(desktop.artifact && desktop.artifact.kind === 'source');
        assert.ok(desktop.baseURL && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(desktop.baseURL));

        const markerPath = path.join(originalUserData, 'relaunch-marker.txt');
        const originalMarker = 'desktop-relaunch-persistence-check';
        fs.writeFileSync(markerPath, originalMarker);

        await desktop.relaunch();
        secondPid = desktop.electronApp.process().pid;
        leakedPids.add(secondPid);
        secondPort = desktop.port;

        assert.equal(desktop.userData, originalUserData);
        assert.equal(fs.readFileSync(markerPath, 'utf8'), originalMarker);
        assert.notEqual(secondPid, firstPid);
        await assertProcessDead(firstPid, 'pre-relaunch Electron');

        await desktop.close();
        await assertProcessDead(secondPid, 'closed Electron');
        await assertNoListener(secondPort);
        await assert.rejects(fs.promises.access(originalUserData), { code: 'ENOENT' });

        // Repeated close is idempotent.
        await desktop.close();
    });

    assert.equal(summary.status, 'passed');
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('missing packaged artifact fails preflight cleanly without falling back to source Electron', async () => {
    const summary = await managedTest('desktop-packaged-preflight-missing', runOptions, async (_t, scope, run) => {
        const emptyDist = await scope.directory('empty-packaged-dist');
        assert.throws(
            () => resolvePackagedDesktopArtifact({ artifactDir: emptyDist.path }),
            error => error?.code === 'PACKAGED_DESKTOP_ARTIFACT_MISSING'
                && /packaged desktop artifact/i.test(error.message)
                && error.message.includes(process.platform),
        );

        const beforeCount = run.registry.resources.length;
        await assert.rejects(
            () => launchLukerDesktop({
                scope,
                scenarioId: 'missing-packaged-artifact',
                packaged: true,
                artifactDir: emptyDist.path,
            }),
            error => error?.code === 'PACKAGED_DESKTOP_ARTIFACT_MISSING',
        );
        // Preflight fails before allocating any desktop data directory or process.
        assert.equal(run.registry.resources.length, beforeCount);
    });

    assert.equal(summary.status, 'passed');
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('packaged app resolves explicit artifact metadata, runs real bundle, records platform identity, and reclaims userData on close', async () => {
    const artifact = resolvePackagedDesktopArtifact();
    assert.equal(artifact.kind, 'packaged');
    assert.equal(artifact.platform, process.platform);
    assert.equal(artifact.arch, process.arch);
    assert.ok(fs.existsSync(artifact.executablePath));
    assert.ok(fs.existsSync(path.join(artifact.resourcesDir, 'luker', 'package.json')));
    assert.match(artifact.executableSHA256, /^[a-f0-9]{64}$/);

    let pid;
    let port;
    let userDataPath;
    const summary = await managedTest('desktop-packaged-real-launch', runOptions, async (_t, scope) => {
        const desktop = await launchLukerDesktop({
            scope,
            scenarioId: 'lifecycle-packaged',
            packaged: true,
        });
        pid = desktop.electronApp.process().pid;
        leakedPids.add(pid);
        port = desktop.port;
        userDataPath = desktop.userData;

        assert.equal(desktop.packaged, true);
        assert.equal(desktop.artifact.executablePath, artifact.executablePath);
        assert.equal(desktop.artifact.resourcesDir, artifact.resourcesDir);
        assert.equal(desktop.artifact.platform, process.platform);
        assert.equal(desktop.artifact.arch, process.arch);

        const response = await fetch(`${desktop.baseURL}/`);
        assert.equal(response.ok, true);

        await desktop.close();
        await assertProcessDead(pid, 'packaged Electron');
        await assertNoListener(port);
        await assert.rejects(fs.promises.access(userDataPath), { code: 'ENOENT' });
    });

    assert.equal(summary.status, 'passed');
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));

    // Verify failure retention publishes the recorded platform and artifact identity diagnostic.
    const failedRun = await createRun({ ...runOptions, profile: 'desktop-packaged' });
    const failedScope = await failedRun.scope({ kind: 'case', label: 'packaged-diagnostic-check' });
    const failedDesktop = await launchLukerDesktop({
        scope: failedScope,
        scenarioId: 'lifecycle-packaged-diag',
        packaged: true,
    });
    leakedPids.add(failedDesktop.electronApp.process().pid);
    await failedDesktop.close();
    failedRun.recordError(new Error('intentional diagnostic retention check'));
    const failedSummary = await failedRun.finish({ status: 'failed' });
    assert.ok(failedSummary.diagnosticIndex, 'Failed packaged run must publish diagnostic index');
    const identityRef = failedSummary.diagnosticIndex.artifacts.find(ref => ref.name.includes('desktop-runtime-lifecycle-packaged-diag'));
    assert.ok(identityRef, 'Failed packaged run must retain desktop runtime identity diagnostic');
    const recorded = JSON.parse((await readDiagnostic(failedSummary.diagnosticIndex, identityRef)).toString('utf8'));
    assert.equal(recorded.kind, 'packaged');
    assert.equal(recorded.platform, process.platform);
    assert.equal(recorded.arch, process.arch);
    assert.equal(recorded.executablePath, artifact.executablePath);
    assert.equal(recorded.resourcesDir, artifact.resourcesDir);
    assert.equal(recorded.executableSHA256, artifact.executableSHA256);
});

test('Electron started before launch returns cleans up spawned process and auto-created userData on mid-launch failure', async () => {
    const runtime = resolveSourceDesktopRuntime();
    let crashedPid = null;
    let abortedPid = null;
    let leakedUserData = null;

    const summary = await managedTest('desktop-mid-launch-failure', runOptions, async (_t, scope, run) => {
        const fixtureDir = await scope.directory('mid-launch-wrapper');

        // Subcase A: real Electron starts main.js and exits with error before launchLukerDesktop returns.
        const crashAppDir = await scope.directory('mid-launch-crash-app');
        const crashPidFile = path.join(crashAppDir.path, 'crashed.pid');
        fs.writeFileSync(path.join(crashAppDir.path, 'package.json'), JSON.stringify({
            name: 'mid-launch-crash-fixture',
            version: '1.0.0',
            main: 'main.js',
        }));
        fs.writeFileSync(path.join(crashAppDir.path, 'main.js'), [
            'const fs = require("node:fs");',
            `fs.writeFileSync(${JSON.stringify(crashPidFile)}, String(process.pid));`,
            'process.exit(2);',
        ].join('\n'));

        const resourcesBeforeCrash = new Set(run.registry.resources.map(r => r.resourceId));
        await assert.rejects(
            () => launchLukerDesktop({
                scope,
                scenarioId: 'mid-launch-crash',
                appDir: crashAppDir.path,
                seed: false,
            }),
            /failed|closed|exit|launch|window/i,
        );

        assert.equal(fs.existsSync(crashPidFile), true, 'Mid-launch child process must have actually started');
        crashedPid = Number(fs.readFileSync(crashPidFile, 'utf8').trim());
        leakedPids.add(crashedPid);
        assert.ok(Number.isInteger(crashedPid) && crashedPid > 0);
        await assertProcessDead(crashedPid, 'mid-launch crashed process');

        const crashDirs = run.registry.resources.filter(
            r => !resourcesBeforeCrash.has(r.resourceId) && r.kind === 'directory',
        );
        assert.ok(crashDirs.length >= 1, 'Auto-created userData must have been registered in scope');
        for (const rec of crashDirs) {
            leakedUserData = rec.locator.path;
            assert.equal(fs.existsSync(rec.locator.path), false, `Auto-created directory ${rec.locator.path} must be reclaimed after mid-launch crash`);
        }

        // Subcase B: real Electron starts and is aborted via signal before launchLukerDesktop returns.
        const abortPidFile = path.join(fixtureDir.path, 'aborted.pid');
        const abortWrapper = path.join(fixtureDir.path, 'exec-electron.sh');
        fs.writeFileSync(abortWrapper, [
            '#!/bin/sh',
            `echo "$$" > ${JSON.stringify(abortPidFile)}`,
            `exec ${JSON.stringify(runtime.executablePath)} "$@"`,
        ].join('\n') + '\n', { mode: 0o755 });

        const resourcesBeforeAbort = new Set(run.registry.resources.map(r => r.resourceId));
        const controller = new AbortController();
        const launching = launchLukerDesktop({
            scope,
            scenarioId: 'mid-launch-abort',
            electronPath: abortWrapper,
            signal: controller.signal,
            seed: false,
        });

        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(abortPidFile) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(fs.existsSync(abortPidFile), true, 'Real Electron process must have started before abort');
        abortedPid = Number(fs.readFileSync(abortPidFile, 'utf8').trim());
        leakedPids.add(abortedPid);
        controller.abort(new Error('intentional mid-launch cancellation'));

        await assert.rejects(launching, /intentional mid-launch cancellation/);
        await assertProcessDead(abortedPid, 'mid-launch aborted Electron');

        const abortDirs = run.registry.resources.filter(
            r => !resourcesBeforeAbort.has(r.resourceId) && r.kind === 'directory',
        );
        assert.ok(abortDirs.length >= 1, 'Auto-created userData must have been registered before abort');
        for (const rec of abortDirs) {
            assert.equal(fs.existsSync(rec.locator.path), false, `Auto-created directory ${rec.locator.path} must be reclaimed after mid-launch abort`);
        }
    });

    assert.equal(summary.status, 'passed');
    assert.ok(crashedPid > 0 && abortedPid > 0);
    if (leakedUserData) assert.equal(fs.existsSync(leakedUserData), false);
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('firstWindow failure closes already-started Electron process and reclaims auto-created userData', async () => {
    let startedPid = null;
    let autoDirPath = null;

    const summary = await managedTest('desktop-first-window-failure', runOptions, async (_t, scope, run) => {
        const noWindowApp = await scope.directory('no-window-electron-app');
        const pidFile = path.join(noWindowApp.path, 'electron.pid');
        fs.writeFileSync(path.join(noWindowApp.path, 'package.json'), JSON.stringify({
            name: 'no-window-fixture',
            version: '1.0.0',
            main: 'main.js',
        }));
        fs.writeFileSync(path.join(noWindowApp.path, 'main.js'), [
            'const fs = require("node:fs");',
            'const { app } = require("electron");',
            `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
            'app.whenReady().then(() => {',
            '    // Keep app running without opening any BrowserWindow so firstWindow() times out.',
            '    setInterval(() => {}, 10_000);',
            '});',
        ].join('\n'));

        const beforeIds = new Set(run.registry.resources.map(r => r.resourceId));
        await assert.rejects(
            () => launchLukerDesktop({
                scope,
                scenarioId: 'first-window-timeout',
                appDir: noWindowApp.path,
                firstWindowTimeout: 1_000,
                seed: false,
            }),
            /timeout|exceeded|window/i,
        );

        assert.equal(fs.existsSync(pidFile), true, 'Real Electron main process must have started');
        startedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        leakedPids.add(startedPid);
        await assertProcessDead(startedPid, 'firstWindow-failed Electron');

        const created = run.registry.resources.filter(r => !beforeIds.has(r.resourceId) && r.kind === 'directory');
        assert.ok(created.length >= 1);
        for (const rec of created) {
            autoDirPath = rec.locator.path;
            assert.equal(fs.existsSync(rec.locator.path), false);
        }
    });

    assert.equal(summary.status, 'passed');
    assert.ok(startedPid > 0);
    if (autoDirPath) assert.equal(fs.existsSync(autoDirPath), false);
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('close throwing surfaces the error while still terminating Electron and reclaiming auto-created userData', async () => {
    let pid = null;
    let port = null;
    let userDataPath = null;

    const summary = await managedTest('desktop-close-throws', runOptions, async (_t, scope) => {
        const desktop = await launchLukerDesktop({ scope, scenarioId: 'close-throws' });
        pid = desktop.electronApp.process().pid;
        leakedPids.add(pid);
        port = desktop.port;
        userDataPath = desktop.userData;

        // Simulate a broken Electron close channel while the OS process is still alive.
        desktop.electronApp.close = async () => {
            throw new Error('simulated electronApp.close failure');
        };

        await assert.rejects(
            () => desktop.close(),
            /simulated electronApp\.close failure/,
        );

        await assertProcessDead(pid, 'Electron after throwing close');
        await assertNoListener(port);
        await assert.rejects(fs.promises.access(userDataPath), { code: 'ENOENT' });
    });

    assert.equal(summary.status, 'passed');
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('explicit borrowed directory is preserved across close and scope disposal', async () => {
    let pid = null;
    let port = null;

    const outerSummary = await managedTest('desktop-borrowed-holder', runOptions, async (_t, outerScope) => {
        const externalHolder = await outerScope.directory('external-borrowed-desktop-dir');
        const externalDir = externalHolder.path;
        const sentinelPath = path.join(externalDir, 'sentinel.txt');
        fs.writeFileSync(sentinelPath, 'keep-borrowed-intact');

        const innerRun = await createRun({ ...runOptions, profile: 'desktop-borrowed-check' });
        let summary;
        try {
            const scope = await innerRun.scope({ kind: 'case', label: 'desktop-borrowed-directory' });
            const borrowed = await scope.borrowDirectory(externalDir);
            const desktop = await launchLukerDesktop({
                scope,
                scenarioId: 'borrowed-userdata',
                userData: borrowed,
                seed: false,
            });
            pid = desktop.electronApp.process().pid;
            leakedPids.add(pid);
            port = desktop.port;

            assert.equal(desktop.userData, externalDir);
            await desktop.close();
            await assertProcessDead(pid, 'borrowed-dir Electron');
            await assertNoListener(port);
            assert.equal(fs.existsSync(externalDir), true);
            assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep-borrowed-intact');
        } finally {
            summary = await innerRun.finish({ status: 'passed' });
        }

        assert.equal(summary.status, 'passed');
        assert.equal(fs.existsSync(externalDir), true);
        assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'keep-borrowed-intact');
        assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
    });

    assert.equal(outerSummary.status, 'passed');
    assert.ok(outerSummary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('missing test cleanup hook still closes Electron and reclaims userData on scope disposal', async () => {
    let pid = null;
    let port = null;
    let userDataPath = null;

    const summary = await managedTest('desktop-no-cleanup-hook', runOptions, async (_t, scope) => {
        const desktop = await launchLukerDesktop({ scope, scenarioId: 'no-cleanup-hook' });
        pid = desktop.electronApp.process().pid;
        leakedPids.add(pid);
        port = desktop.port;
        userDataPath = desktop.userData;
        // Deliberately return without calling desktop.close().
    });

    assert.equal(summary.status, 'passed');
    await assertProcessDead(pid, 'unclosed Electron');
    await assertNoListener(port);
    await assert.rejects(fs.promises.access(userDataPath), { code: 'ENOENT' });
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});

test('spawnLukerDesktop requires a managed scope and cleans up an unclosed process on scope disposal', async () => {
    await assert.rejects(
        () => spawnLukerDesktop({ defaultUserData: null }),
        /managed resource scope/i,
    );

    let spawnedPid = null;
    const summary = await managedTest('desktop-spawn-managed', runOptions, async (_t, scope) => {
        const defaultDir = await scope.directory('spawn-missing-default');
        fs.writeFileSync(
            path.join(defaultDir.path, 'data-location.json'),
            JSON.stringify({ version: 1, userData: path.join(defaultDir.path, 'missing-target') }),
        );
        const proc = await spawnLukerDesktop({
            scope,
            defaultUserData: defaultDir,
            extraEnv: { LUKER_DESKTOP_TEST_LOCATION_DIALOG: 'quit' },
        });
        spawnedPid = proc.pid;
        leakedPids.add(spawnedPid);
        const exit = await proc.waitForExit();
        assert.equal(exit.code, 0);
    });

    assert.equal(summary.status, 'passed');
    await assertProcessDead(spawnedPid, 'spawned desktop Electron');
    assert.ok(summary.resources.every(r => ['disposed', 'released'].includes(r.state)));
});
