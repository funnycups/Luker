/* global afterAll */
import { createRun } from './resources/run.js';
import { failureGroup } from './resources/errors.js';

const trackedScopes = [];
const cleanups = [];
let runPromise;
let finishPromise;
let failed = false;

export function profile() {
    return process.env.LUKER_TEST_PROFILE || 'unit';
}

export function ensureRun() {
    runPromise ??= createRun({ profile: profile() });
    return runPromise;
}

export function trackScope(scope) {
    trackedScopes.push(scope);
    return scope;
}

export function recordFailure(error) {
    failed = true;
    return error;
}

export function registerRunCleanup(callback) {
    cleanups.push(callback);
}

function finishRun() {
    finishPromise ??= (async () => {
        const errors = [];
        let run;
        try { run = await runPromise; }
        catch (error) { errors.push(error); }
        if (run !== undefined) {
            for (const scope of [...trackedScopes].reverse()) {
                try { await scope.dispose(); }
                catch (error) { errors.push(error); }
            }
            const observed = globalThis.__lukerJestFailures;
            if (Array.isArray(observed)) for (const error of observed) run.recordError(error);
            try {
                await run.finish({ status: failed || (Array.isArray(observed) && observed.length) ? 'failed' : 'passed' });
            } catch (error) {
                errors.push(error);
            }
        }
        for (const cleanup of [...cleanups].reverse()) {
            try { await cleanup(); }
            catch (error) { errors.push(error); }
        }
        if (errors.length) throw failureGroup(errors, 'Managed Jest run cleanup failed');
    })();
    return finishPromise;
}

globalThis.__lukerJestFinishRun = finishRun;

afterAll(async () => {
    if (globalThis.__lukerJestManagedEnvironment !== true) await finishRun();
});
