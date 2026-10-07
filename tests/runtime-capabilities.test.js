import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = pathToFileURL(resolve(REPO_ROOT, 'src/runtime-capabilities.js')).href;

function hasWasm(args = [], env = {}) {
    const code = `const m = await import(${JSON.stringify(MODULE_URL)}); console.log(String(m.HAS_WASM));`;
    const childEnv = { ...process.env };
    delete childEnv.LUKER_FORCE_JITLESS;
    Object.assign(childEnv, env);
    const out = execFileSync(process.execPath, [...args, '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        env: childEnv,
        encoding: 'utf8',
    });
    return out.trim().split('\n').pop();
}

test('HAS_WASM is true on a normal node', () => {
    expect(hasWasm()).toBe('true');
});

test('HAS_WASM is false under --jitless', () => {
    expect(hasWasm(['--jitless'])).toBe('false');
});

test('HAS_WASM is false when LUKER_FORCE_JITLESS=1', () => {
    expect(hasWasm([], { LUKER_FORCE_JITLESS: '1' })).toBe('false');
});
