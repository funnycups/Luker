import { test as nativeTest, expect } from '@playwright/test';
import { workerClient } from './playwright-client.js';
import { setCurrentResourceScope, clearCurrentResourceScope } from './storage-scope.js';

export { expect };
export const test = nativeTest.extend({
    // eslint-disable-next-line no-empty-pattern -- Native fixtures require literal dependency destructuring.
    workerResources: [async ({}, use, workerInfo) => {
        const resources = await workerClient(workerInfo);
        try { await use(resources); }
        finally { await resources.closeWorker(); }
    }, { scope: 'worker', auto: true }],
    resources: [async ({ workerResources }, use, testInfo) => {
        const scope = await workerResources.case(testInfo);
        // Storage engine harnesses allocate databases and directories through
        // the case scope, mirroring the Jest resource fixture.
        setCurrentResourceScope(scope);
        try { await use(scope); }
        finally {
            try { await scope.closeScope(); }
            finally { clearCurrentResourceScope(scope); }
        }
    }, { auto: true }],
});
