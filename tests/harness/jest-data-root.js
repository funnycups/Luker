/* global afterAll */
import fs from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { ensureRun, registerRunCleanup, trackScope } from './jest-run.js';

// jsdom-based suites do not expose the Node structuredClone global. Harness
// ownership records require it before the first run is created.
if (typeof globalThis.structuredClone !== 'function') globalThis.structuredClone = value => deserialize(serialize(value));

const bootstrapRoot = globalThis.DATA_ROOT;
const nativeProcess = typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule('node:process')
    : process;

let cleanedBootstrapRoot = false;
const cleanupBootstrapRoot = () => {
    if (cleanedBootstrapRoot || typeof bootstrapRoot !== 'string') return;
    cleanedBootstrapRoot = true;
    nativeProcess.off('exit', cleanupBootstrapRoot);
    fs.rmSync(bootstrapRoot, { recursive: true, force: true });
    if (globalThis.DATA_ROOT === bootstrapRoot) delete globalThis.DATA_ROOT;
};

if (typeof bootstrapRoot === 'string') {
    nativeProcess.once('exit', cleanupBootstrapRoot);
}

if (process.env.LUKER_EXPORT_ENVIRONMENT) {
    try {
        const run = await ensureRun();
        const scope = trackScope(await run.scope({ kind: 'file', label: 'jest data root' }));
        const directory = await scope.directory('jest data root');
        globalThis.DATA_ROOT = directory.path;
        if (typeof bootstrapRoot === 'string' && bootstrapRoot !== directory.path) {
            cleanupBootstrapRoot();
        }
        afterAll(async () => {
            await scope.dispose();
        });
    } catch (error) {
        cleanupBootstrapRoot();
        throw error;
    }
} else if (typeof bootstrapRoot === 'string') {
    registerRunCleanup(cleanupBootstrapRoot);
}
