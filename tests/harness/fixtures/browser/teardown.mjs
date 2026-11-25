import finishNativeTeardown from '../../playwright-teardown.js';
import { getRuntime } from '../../playwright-runtime.js';

export default async function () {
    const input = JSON.parse(process.env.BROWSER_LIFECYCLE_INPUT);
    if (input.mode === 'teardown-error') throw new Error('actual browser global-teardown failure');
    await finishNativeTeardown();
    if (input.mode === 'startup-worker-exit') console.log('BROWSER_NATIVE_DISPATCHERS ' + JSON.stringify({ admissionClosed: [...getRuntime().projects.values()].every(project => [...project.workers.values()].every(worker => worker.closing)) }));
}
