import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = pathToFileURL(resolve(REPO_ROOT, 'src/tiktoken-adapter.js')).href;

function encodeDecode(args = [], env = {}) {
    const code = `
        const m = await import(${JSON.stringify(MODULE_URL)});
        const tok = m.createTiktokenTokenizer('gpt-4o');
        const ids = tok.encode('hello world');
        const bytes = tok.decode(new Uint32Array(ids));
        console.log(JSON.stringify({
            count: Object.values(ids).length,
            text: new TextDecoder().decode(bytes),
            isBytes: bytes instanceof Uint8Array,
        }));
    `;
    const out = execFileSync(process.execPath, [...args, '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').pop());
}

test('native tiktoken path decodes to bytes', () => {
    const r = encodeDecode();
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).toBe('hello world');
    expect(r.isBytes).toBe(true);
});

test('jitless branch (--jitless) uses js-tiktoken and decodes to bytes', () => {
    const r = encodeDecode(['--jitless']);
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).toBe('hello world');
    expect(r.isBytes).toBe(true);
});

test('jitless branch (LUKER_FORCE_JITLESS=1) matches', () => {
    const r = encodeDecode([], { LUKER_FORCE_JITLESS: '1' });
    expect(r.count).toBeGreaterThan(0);
    expect(r.text).toBe('hello world');
    expect(r.isBytes).toBe(true);
});
