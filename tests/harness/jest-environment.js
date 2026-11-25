import nodeEnvironment from 'jest-environment-node';

const { TestEnvironment } = nodeEnvironment;
const actualError = value => Array.isArray(value) ? value[0] : value;

export default class ManagedTestEnvironment extends TestEnvironment {
    constructor(config, context) {
        super(config, context);
        this.global.__lukerJestManagedEnvironment = true;
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
            for (const value of state?.unhandledErrors ?? []) failures.push(actualError(value));
            const finish = this.global.__lukerJestFinishRun;
            if (typeof finish === 'function') {
                try { await finish(); }
                catch (error) {
                    state.unhandledErrors.push(error);
                }
            }
        }
        const parent = super.handleTestEvent;
        if (parent) await parent.call(this, event);
    }
}
