import { getRuntime, finishRuntime } from './playwright-runtime.js';

export default class ManagedReporter {
    errors = [];

    record(error) {
        const runtime = getRuntime();
        if (runtime) runtime.errors.push(error);
        else this.errors.push(error);
    }

    onBegin(config, suite) {
        const runtime = getRuntime();
        if (!runtime) return;
        try { for (const project of suite.suites) runtime.projects.get(project.project().name).plan(project.allTests()); }
        catch (error) { this.record(error); }
    }

    onTestBegin(test, result) {
        try { getRuntime().projects.get(test.parent.project().name).begin(test, result); }
        catch (error) { this.record(error); }
    }

    onTestEnd(test, result) {
        try { getRuntime().projects.get(test.parent.project().name).end(test, result); }
        catch (error) { this.record(error); }
    }

    onError(value) {
        this.record(Object.assign(new Error(value.message ?? value.value), { nativeResult: value }));
    }

    async onEnd(result) {
        if (!getRuntime()) {
            if (this.errors.length) { console.error(new AggregateError(this.errors, 'Native browser reporter failed before resource setup')); return { status: 'failed' }; }
            return;
        }
        try { return await finishRuntime(result.status); }
        catch (error) { console.error(error); return { status: 'failed' }; }
    }
}
