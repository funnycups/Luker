import fs from 'node:fs';
import path from 'node:path';
import { test as nativeTest, expect } from '@playwright/test';
import { createRun } from './resources/run.js';
import { startServer } from './server.js';
import { setCurrentResourceScope, clearCurrentResourceScope } from './storage-scope.js';

export { expect };

function createWorkerResources(run, workerScope, projectName) {
    let activeScenario = null;
    let frontendPromise = null;

    async function disposeScenarioIfDifferent(file) {
        if (activeScenario && activeScenario.file !== file) {
            const prev = activeScenario;
            activeScenario = null;
            await prev.scope.dispose();
        }
    }

    async function scenario(file) {
        if (typeof file !== 'string' || !file) {
            throw new TypeError('workerResources.scenario requires a test file path');
        }
        if (activeScenario?.file === file) return activeScenario.scope;
        await disposeScenarioIfDifferent(file);
        const scope = await workerScope.child({ kind: 'scenario', label: file });
        activeScenario = { file, scope };
        return scope;
    }

    async function frontendApplication() {
        if (projectName !== 'frontend') {
            throw new Error(`Shared frontend application requires the frontend project (got ${projectName})`);
        }
        frontendPromise ??= (async () => {
            const scope = await workerScope.child({ kind: 'scenario', label: 'shared frontend application' });
            const server = await startServer({ scope, batchKey: 'frontend', scenarioId: 'shared' });
            const settingsFile = path.join(server.dataRoot, 'default-user/settings.json');
            const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            settings.power_user.frontend_debug_logging = true;
            fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4));
            return Object.freeze({
                baseURL: server.baseURL,
                dataRoot: server.dataRoot,
                port: server.port,
                pid: server.pid,
                resourceId: server.resourceId,
                owner: server.owner,
                dataOwner: server.dataOwner,
            });
        })();
        return frontendPromise;
    }

    return Object.freeze({
        runId: run.runId,
        scopeId: workerScope.scopeId,
        transport: 'local',
        scenario,
        frontendApplication,
        disposeScenarioIfDifferent,
        child: descriptor => workerScope.child(descriptor),
        directory: label => workerScope.directory(label),
        verifyDirectory: dir => workerScope.verifyDirectory(dir),
        borrowDirectory: dir => workerScope.borrowDirectory(dir),
        process: options => workerScope.process(options),
        acquire: provider => workerScope.acquire(provider),
        acquireShared: provider => workerScope.acquireShared(provider),
        releaseShared: resource => workerScope.releaseShared(resource),
        release: resource => workerScope.release(resource),
        onFinalize: descriptor => workerScope.onFinalize(descriptor),
        captureDiagnostic: descriptor => workerScope.captureDiagnostic(descriptor),
        diagnostic: descriptor => workerScope.diagnostic(descriptor),
        continuation: descriptor => workerScope.continuation(descriptor),
        async openCase(testInfo) {
            await disposeScenarioIfDifferent(testInfo.file);
            return workerScope.child({ kind: 'case', label: testInfo.titlePath.join(' > ') });
        },
        async closeWorker() {
            activeScenario = null;
            await run.finish({ status: 'passed' });
        },
    });
}

export const test = nativeTest.extend({
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require destructuring.
    workerResources: [async ({}, use, workerInfo) => {
        const run = await createRun({ profile: workerInfo.project.name });
        const workerScope = await run.scope({ kind: 'worker', label: `worker-${workerInfo.workerIndex}` });
        const resources = createWorkerResources(run, workerScope, workerInfo.project.name);
        try {
            await use(resources);
        } finally {
            await resources.closeWorker();
        }
    }, { scope: 'worker', auto: true }],

    resources: [async ({ workerResources }, use, testInfo) => {
        const scope = await workerResources.openCase(testInfo);
        setCurrentResourceScope(scope);
        try {
            await use(scope);
        } finally {
            try {
                await scope.dispose();
            } finally {
                clearCurrentResourceScope(scope);
            }
        }
    }, { auto: true }],
});
