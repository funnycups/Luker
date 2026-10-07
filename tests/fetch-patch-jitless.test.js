import { test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_URL = new URL('../src/fetch-patch.js', import.meta.url).href;

// The patched global fetch must reach a real HTTP server under --jitless,
// where undici's WASM llhttp is unavailable. Under a normal Node the same
// call returns undici's WHATWG stream; under --jitless it must return a
// node-fetch Node Readable. Reverting the base-fetch selection makes this
// child throw before it can respond, so the test genuinely covers the change.
function fetchUnder(args = [], env = {}) {
    const code = `
        const http = await import('node:http');
        const srv = http.createServer((req, res) => { res.writeHead(200, {'Content-Type':'text/plain'}); res.end('ok'); });
        await new Promise(r => srv.listen(0, '127.0.0.1', r));
        const port = srv.address().port;
        await import(${JSON.stringify(MODULE_URL)});
        try {
            const res = await globalThis.fetch('http://127.0.0.1:' + port + '/');
            const text = await res.text();
            console.log(JSON.stringify({ ok: true, status: res.status, text, webStream: typeof res.body?.getReader === 'function' }));
        } catch (error) {
            console.log(JSON.stringify({ ok: false, error: String(error.message), cause: String(error.cause?.message || '') }));
        }
        srv.close();
        srv.closeAllConnections?.();
        srv.unref();
    `;
    const out = execFileSync(process.execPath, [...args, '--input-type=module', '-e', code], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.trim().split('\n').pop());
}

test('under --jitless the patched global fetch reaches the network via node-fetch', () => {
    const r = fetchUnder(['--jitless']);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.text).toBe('ok');
    expect(r.webStream).toBe(false);
});
