import fs from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { registerRunCleanup } from './jest-run.js';

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = value => deserialize(serialize(value));
}

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
    registerRunCleanup(cleanupBootstrapRoot);
}
