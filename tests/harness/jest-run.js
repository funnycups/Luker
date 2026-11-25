/* global expect, afterAll */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun } from './resources/run.js';
import { failureGroup } from './resources/errors.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trackedScopes = [];
const cleanups = [];
let runPromise;
let finishPromise;
let failed = false;

export function profile() {
    return process.env.LUKER_TEST_PROFILE || 'unit';
}

function command() {
    const argv = process.argv.slice(1);
    return argv.length ? [process.execPath, ...argv] : [process.execPath];
}

function source() {
    return expect.getState().testPath || 'jest';
}

export function ensureRun() {
    const exportEnvironmentTo = process.env.LUKER_EXPORT_ENVIRONMENT || undefined;
    runPromise ??= createRun({
        projectRoot: globalThis.__lukerJestProjectRoot ?? repository,
        profile: profile(),
        command: command(),
        source: source(),
        ...(exportEnvironmentTo ? { exportEnvironmentTo } : {}),
    });
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
                const summary = await run.finish({ status: failed || (Array.isArray(observed) && observed.length) ? 'failed' : 'passed' });
                if (summary.status !== 'passed') errors.push(new AggregateError(summary.errors, `Managed Jest run ${run.runId} ${summary.status}: ${run.registryPath}`));
            }
            catch (error) { errors.push(error); }
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

// Jest invokes the environment finalizer at run_finish, including for files
// whose tests are all skipped. Suites that select another environment keep
// this hook as their terminal owner.
afterAll(async () => {
    if (globalThis.__lukerJestManagedEnvironment !== true) await finishRun();
});
