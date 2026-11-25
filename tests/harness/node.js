import { after as nativeAfter, test as nativeTest } from 'node:test';
import { createRun } from './resources/run.js';
import { failureEvents, failureFrom, failureGroup } from './resources/errors.js';
import { recoverBeforeRun } from './startup.js';

const finalizations = [];
const contexts = new WeakMap();
const declarations = new Set();

nativeAfter(async () => {
    // Selection and inherited hooks can omit an owner, or permit a later entrance.
    for (const declaration of declarations) {
        declaration.state.open = false;
        close(declaration.registered);
        declaration.completion.resolve(undefined);
    }
    declarations.clear();
    const results = (await Promise.all(finalizations)).flat();
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw failureGroup(errors, 'Managed native resource finalization failed');
});

function requireCallback(callback, arguments_) {
    if (typeof callback !== 'function' || callback.length > arguments_) throw new TypeError('Managed native registration requires a synchronous or Promise callback');
}

function registration(state, name) {
    return { state, name, context: undefined, open: true, failures: [] };
}

function admitted(context) {
    const registered = contexts.get(context);
    if (!registered) throw new TypeError('Managed registration requires an admitted native test context');
    return registered;
}

function capture(registered, value, message) {
    const error = failureFrom(value, message);
    registered.failures.push(value);
    registered.state.run.recordError(error);
    registered.state.reported.add(error);
    for (const event of failureEvents(error)) registered.state.reported.add(event);
}

function invoke(registered, callback, receiver, args, message) {
    const executing = (async () => {
        try { return await Reflect.apply(callback, receiver, args); }
        catch (value) {
            capture(registered, value, message);
            throw value;
        }
    })();
    registered.state.callbacks.push(Promise.allSettled([executing]));
    return executing;
}

function completed(registered, actual = registered.context.error) {
    if (actual === null) return;
    let propagated = actual;
    for (;;) {
        if (registered.failures.some(value => Object.is(value, propagated))) return;
        if (!(propagated instanceof Error) || propagated.code !== 'ERR_TEST_FAILURE' || !Object.hasOwn(propagated, 'cause')) break;
        propagated = propagated.cause;
    }
    // Raw native failures retain the actual completed Error, including aggregate counts.
    capture(registered, actual, `Native test ${registered.name} failed`);
}

function close(registered) {
    registered.open = false;
}

function closeRun(state, registered) {
    state.open = false;
    close(registered);
    for (const child of state.children) close(child);
}

/**
 * Capture a fallible hook at its real native synchronous/Promise callback boundary.
 * @param {import('node:test').TestContext} context
 * @param {(context: import('node:test').TestContext) => void|Promise<void>} callback
 */
export function after(context, callback) {
    requireCallback(callback, 1);
    const registered = admitted(context);
    context.after(async function (...args) {
        if (!registered.state.open || !registered.open) return;
        return invoke(registered, callback, this, args, `Native hook for ${context.name} rejected`);
    });
}

/**
 * Register one native child and retain failures from its actual callback context.
 * @param {import('node:test').TestContext} context
 * @param {string} name
 * @param {import('node:test').TestOptions|((context: import('node:test').TestContext) => void|Promise<void>)} options
 * @param {(context: import('node:test').TestContext) => void|Promise<void>} [callback]
 * @returns {Promise<void>|void} The native registration's unmodified return value.
 */
export function subtest(context, name, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    requireCallback(callback, 1);
    const parent = admitted(context);
    const registered = registration(parent.state, name);
    const execution = context.test(name, options, function (child) {
        registered.context = child;
        if (!parent.state.open || !registered.open || child.signal.aborted) return;
        child.signal.addEventListener('abort', () => close(registered), { once: true });
        contexts.set(child, registered);
        return invoke(registered, callback, this, [child], `Native subtest ${name} rejected`);
    });
    parent.state.children.push(registered);
    return execution;
}

/**
 * Observe a root result; an omitted root settles at module finalization.
 * Use subtest for native child registration inside an executing managed case.
 * @param {string} name
 * @param {import('./resources/run.js').RunOptions} options
 * @param {(context: import('node:test').TestContext, scope: import('./resources/scope.js').ResourceScope, run: import('./resources/run.js').TestRun) => void|Promise<void>} body
 * @returns {Promise<import('./resources/run.js').RunSummary|undefined>} Result observation, not a selection-independent ancestor join.
 */
export function test(name, options, body) {
    requireCallback(body, 3);
    if (typeof name !== 'string' || !name) throw new TypeError('A managed test requires a nonempty name');
    const state = { run: undefined, open: true, reported: new Set(), callbacks: [], children: [] };
    const registered = registration(state, name);
    const completion = Promise.withResolvers();
    const declaration = { state, registered, completion };
    declarations.add(declaration);
    finalizations.push(Promise.allSettled([completion.promise]));
    nativeTest(name, function (parent) {
        if (!state.open || parent.signal.aborted) return;
        declarations.delete(declaration);
        let closing;
        const terminal = Promise.withResolvers();
        const finalize = () => {
            closeRun(state, registered);
            if (closing) return closing;
            closing = (async () => {
                await Promise.all(state.callbacks);
                if (state.run !== undefined) await state.run.dispose();
            })();
            // Normal terminal dispatch follows all owner hooks. Its asynchronous
            // continuation also follows synchronous native child aggregation.
            // Early cancellation already has a sticky failure before dispatch.
            const publishing = (async () => {
                await terminal.promise;
                const [closure] = await Promise.allSettled([closing]);
                const receipts = (await Promise.all(state.callbacks)).flat();
                if (state.run === undefined) {
                    const errors = receipts.filter(receipt => receipt.status === 'rejected').map(receipt => failureFrom(receipt.reason));
                    const actual = parent.error;
                    let propagated = actual;
                    while (propagated instanceof Error && propagated.code === 'ERR_TEST_FAILURE' && Object.hasOwn(propagated, 'cause')) propagated = propagated.cause;
                    if (actual !== null && !errors.some(error => Object.is(error, propagated))) errors.push(actual);
                    if (errors.length) throw errors.length === 1 ? errors[0] : failureGroup(errors, `Managed test admission failed: ${name}`);
                    return undefined;
                }
                for (const child of state.children) {
                    if (child.context !== undefined) completed(child);
                }
                if (registered.context !== undefined) completed(registered);
                // A cleanup rejection is already recorded by resource disposal.
                // Do not duplicate its native propagation, or a child aggregate
                // already represented by the body's concrete failure.
                if (closure.status === 'rejected') registered.failures.push(closure.reason);
                if (registered.context === undefined || registered.context.error === null || parent.error?.failureType === 'hookFailed') completed(registered, parent.error);
                const summary = await state.run.finish({ status: parent.passed ? 'passed' : 'failed' });
                if (closure.status === 'rejected') throw failureGroup(summary.errors, `Managed test cleanup failed: ${name}`);
                const additional = summary.errors.filter(error => !state.reported.has(error));
                if (additional.length) throw failureGroup(additional, `Managed test cleanup failed: ${name}`);
                if (parent.passed && summary.status !== 'passed') throw failureGroup(summary.errors, `Managed test failed: ${name}`);
                return summary;
            })();
            publishing.then(completion.resolve, completion.reject);
            return closing;
        };
        parent.after(finalize);
        // Earlier native hooks can fail before our own after is dispatched.
        // The native terminal signal enters the same idempotent resource cleanup.
        parent.signal.addEventListener('abort', () => {
            finalize();
            terminal.resolve();
        }, { once: true });
        parent.test(name, function (context) {
            registered.context = context;
            if (!state.open || context.signal.aborted) return;
            const starting = (async () => {
                await recoverBeforeRun({ projectRoot: options.projectRoot, profiles: [options.profile] });
                const exportEnvironmentTo = options.exportEnvironmentTo ?? (process.env.LUKER_EXPORT_ENVIRONMENT || undefined);
                state.run = await createRun({ ...options, ...(exportEnvironmentTo ? { exportEnvironmentTo } : {}), signal: parent.signal });
                contexts.set(context, registered);
                return invoke(registered, async () => {
                    const scope = await state.run.scope({ kind: 'case', label: name });
                    return Reflect.apply(body, this, [context, scope, state.run]);
                }, this, [], `Native test ${name} rejected`);
            })();
            state.callbacks.push(Promise.allSettled([starting]));
            return starting;
        });
    });
    return completion.promise;
}
