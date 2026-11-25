import nodeEnvironment from 'jest-environment-node';

const { TestEnvironment } = nodeEnvironment;
const actualError = value => Array.isArray(value) ? value[0] : value;

// Jest only exposes assertion failures to its reporter, not to setup hooks.
// Retain the actual errors on the sandbox global so the managed run can finish
// with the outcome Jest observed.
export default class ManagedTestEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        this.global.__lukerJestManagedEnvironment = true;
        this.global.__lukerJestProjectRoot = config.projectConfig.testEnvironmentOptions.resourceProjectRoot;
    }

    async handleTestEvent(event, state) {
        const failures = this.global.__lukerJestFailures ??= [];
        if (event.name === 'test_done') {
            for (const value of event.test.errors) failures.push(actualError(value));
        } else if (event.name === 'hook_failure') {
            failures.push(event.error);
        } else if (event.name === 'test_retry') {
            const retried = new Set(event.test.errors.map(actualError));
            for (let index = failures.length - 1; index >= 0; index--) {
                if (retried.has(failures[index])) failures.splice(index, 1);
            }
        } else if (event.name === 'run_finish') {
            for (const value of state?.unhandledErrors ?? []) failures.push(Array.isArray(value) ? value[0] : value);
            const finish = this.global.__lukerJestFinishRun;
            if (typeof finish === 'function') {
                try { await finish(); }
                catch (error) {
                    // Report run-level failure without discarding native case results.
                    state.unhandledErrors.push(error);
                }
            }
        }
        const parent = super.handleTestEvent;
        if (parent) await parent.call(this, event);
    }
}
