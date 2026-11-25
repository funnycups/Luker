/* global beforeEach, afterEach, test, beforeAll, expect */
import { ensureRun, trackScope, recordFailure } from './jest-run.js';
import { failureGroup } from './resources/errors.js';
import { setCurrentResourceScope, clearCurrentResourceScope, currentScopeForResources } from './storage-scope.js';

let currentScope;
let hooksInstalled = false;

function createLazyCaseScope(label) {
    let materialized;
    let createdScope;
    let disposed = false;
    const resolveScope = () => {
        if (materialized) return materialized;
        if (disposed) return Promise.reject(new Error(`Scope for case ${label} is disposed`));
        materialized = (async () => {
            const run = await ensureRun();
            const scope = await run.scope({ kind: 'case', label });
            createdScope = scope;
            return scope;
        })();
        return materialized;
    };
    const forward = method => (...args) => resolveScope().then(scope => scope[method](...args));
    return Object.freeze({
        get transport() { return 'local'; },
        resolveScope,
        child: forward('child'),
        acquire: forward('acquire'),
        acquireShared: forward('acquireShared'),
        releaseShared: forward('releaseShared'),
        directory: forward('directory'),
        verifyDirectory: forward('verifyDirectory'),
        borrowDirectory: forward('borrowDirectory'),
        process: forward('process'),
        captureDiagnostic: forward('captureDiagnostic'),
        onFinalize: forward('onFinalize'),
        diagnostic: forward('diagnostic'),
        continuation: forward('continuation'),
        release: forward('release'),
        async dispose() {
            disposed = true;
            if (!materialized) return;
            await Promise.allSettled([materialized]);
            if (createdScope) await createdScope.dispose();
        },
    });
}

/**
 * Install one managed scope per Jest case for the storage projects. Allocating
 * harnesses receive that scope explicitly through `currentScopeForResources`.
 * The underlying run and case scope materialize lazily on first allocation so
 * pure in-memory suites avoid creating run directories and fsyncs.
 */
export function installStorageScopeHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    beforeEach(() => {
        currentScope = createLazyCaseScope(expect.getState().currentTestName || 'storage case');
        setCurrentResourceScope(currentScope);
    });
    afterEach(async () => {
        const scope = currentScope;
        currentScope = undefined;
        clearCurrentResourceScope(scope);
        if (!scope) return;
        try { await scope.dispose(); }
        catch (error) { recordFailure(error); throw error; }
    });
}

export { currentScopeForResources };

/**
 * Wrap a Jest case with an explicit managed scope. The scope is released after
 * the body, including when the body fails.
 * @param {string} name
 * @param {(scope: import('./resources/scope.js').ResourceScope) => void|Promise<void>} body
 * @param {number} [timeout]
 */
export function testWithResources(name, body, timeout) {
    if (typeof name !== 'string' || !name || typeof body !== 'function') throw new TypeError('A managed Jest test requires a name and callback');
    return test(name, async () => {
        let run;
        let scope;
        let owned = false;
        try {
            run = await ensureRun();
            if (currentScope) scope = typeof currentScope.resolveScope === 'function' ? await currentScope.resolveScope() : currentScope;
            else { scope = await run.scope({ kind: 'case', label: name }); owned = true; setCurrentResourceScope(scope); trackScope(scope); }
        } catch (error) {
            recordFailure(error);
            throw error;
        }
        let bodyError;
        let bodyFailed = false;
        try {
            await body(scope);
        } catch (error) {
            bodyFailed = true;
            bodyError = error;
            recordFailure(error);
            run.recordError(error);
        }
        let cleanupError;
        let cleanupFailed = false;
        if (owned) {
            clearCurrentResourceScope(scope);
            try {
                await scope.dispose();
            } catch (error) {
                cleanupFailed = true;
                cleanupError = error;
                recordFailure(error);
                run.recordError(error);
            }
        }
        if (bodyFailed && cleanupFailed) throw failureGroup([bodyError, cleanupError], `Managed Jest test and cleanup failed: ${name}`);
        if (bodyFailed) throw bodyError;
        if (cleanupFailed) throw cleanupError;
    }, timeout);
}

/**
 * Acquire a file-scoped scenario once for all cases. The returned getter is
 * available after Jest runs the file's beforeAll hooks.
 * @param {(scope: import('./resources/scope.js').ResourceScope) => unknown|Promise<unknown>} factory
 */
export function suiteResources(factory) {
    if (typeof factory !== 'function') throw new TypeError('Suite resources require a factory');
    let value;
    let acquired = false;
    let acquisitionError;
    beforeAll(async () => {
        let run;
        try {
            run = await ensureRun();
            const scope = trackScope(await run.scope({ kind: 'scenario', label: 'suite' }));
            value = await factory(scope);
            acquired = true;
        } catch (error) {
            acquisitionError = error;
            recordFailure(error);
            run?.recordError(error);
            throw error;
        }
    });
    return Object.freeze({
        get() {
            if (acquisitionError !== undefined) throw acquisitionError;
            if (!acquired) throw new Error('Suite resources are not available before the file beforeAll hook');
            return value;
        },
    });
}
