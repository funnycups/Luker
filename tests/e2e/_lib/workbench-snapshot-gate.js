import { expect } from '../../harness/playwright.js';

/** Hold a real provider response while native scope selection continues. */
export async function holdWorkbenchSnapshots(page) {
    await page.evaluate(() => {
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const gate = { entered: false, release };
        gate.unregister = window.Luker.getContext().workbench.registerAskProvider({
            id: 'scope-presentation-gate',
            label: 'Scope presentation gate',
            async getSnapshot() {
                gate.entered = true;
                await held;
                return null;
            },
        });
        window.__workbenchSnapshotGate = gate;
    });
    return {
        async requested() {
            await expect.poll(() => page.evaluate(() => window.__workbenchSnapshotGate.entered)).toBe(true);
        },
        async release() {
            await page.evaluate(() => {
                const gate = window.__workbenchSnapshotGate;
                gate.release();
                gate.unregister();
                delete window.__workbenchSnapshotGate;
            });
        },
    };
}
