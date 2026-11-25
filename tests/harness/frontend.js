import { test as managedTest, expect } from './playwright.js';

export { expect };
export const test = managedTest.extend({
    frontendApplication: [async ({ workerResources }, use) => {
        await use(await workerResources.frontendApplication());
    }, { scope: 'worker' }],
    baseURL: async ({ frontendApplication }, use) => {
        await use(frontendApplication.baseURL);
    },
});
