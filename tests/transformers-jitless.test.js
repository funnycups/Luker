import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = pathToFileURL(resolve(REPO_ROOT, 'src/transformers.js')).href;

function pipelineError(args = [], env = {}) {
    const code = `
        const m = await import(${JSON.stringify(MODULE_URL)});
        try {
            await m.getPipeline('feature-extraction');
            console.log(JSON.stringify({ rejected: false }));
        } catch (error) {
            console.log(JSON.stringify({ rejected: true, message: String(error.message) }));
        }
    `;
    const out = execFileSync(process.execPath, [...args, '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').pop());
}

test('getPipeline rejects with a clear message under --jitless', () => {
    const r = pipelineError(['--jitless']);
    expect(r.rejected).toBe(true);
    expect(r.message).toMatch(/WebAssembly|JITless|unavailable/i);
});

test('getPipeline rejects with a clear message when LUKER_FORCE_JITLESS=1', () => {
    const r = pipelineError([], { LUKER_FORCE_JITLESS: '1' });
    expect(r.rejected).toBe(true);
    expect(r.message).toMatch(/WebAssembly|JITless|unavailable/i);
});
