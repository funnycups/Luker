import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_LAUNCH_URL = pathToFileURL(path.join(REPO_ROOT, 'src/browser-launch.js')).href;

describe('maybeLaunchBrowser', () => {
    let scratch;

    beforeAll(() => {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-browser-launch-'));
    });

    afterAll(() => {
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    function runChild(script) {
        const resultFile = path.join(fs.mkdtempSync(path.join(scratch, 'case-')), 'result.json');
        return new Promise((resolve) => {
            const proc = spawn(process.execPath, ['--input-type=module', '-e', script(resultFile)], {
                cwd: REPO_ROOT,
            });
            let stderr = '';
            proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            proc.on('close', (status) => {
                resolve({
                    status,
                    stderr,
                    result: fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null,
                });
            });
        });
    }

    test.each(['ios', 'openharmony', 'android'])(
        'skips automatic browser launch on mobile runtime (%s) without spawning subprocesses',
        async (platform) => {
            const child = await runChild((resultFile) => `
                import childProcess from 'node:child_process';
                import fs from 'node:fs';
                import { syncBuiltinESMExports } from 'node:module';

                const spawnCalls = [];
                const deny = (cmd) => {
                    spawnCalls.push(String(cmd));
                    throw Object.assign(new Error(\`spawn \${cmd} EPERM\`), { code: 'EPERM', syscall: \`spawn \${cmd}\` });
                };
                Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
                childProcess.spawn = deny;
                childProcess.spawnSync = deny;
                childProcess.exec = deny;
                childProcess.execSync = deny;
                childProcess.execFile = deny;
                childProcess.execFileSync = deny;
                syncBuiltinESMExports();

                const { maybeLaunchBrowser } = await import(${JSON.stringify(BROWSER_LAUNCH_URL)});
                const outcome = await maybeLaunchBrowser({
                    enabled: true,
                    url: 'http://127.0.0.1:8000',
                    browser: 'default',
                });
                fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ spawnCalls, outcome }));
            `);

            expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
            expect(child.result).toEqual({
                spawnCalls: [],
                outcome: { launched: false, skippedMobile: true },
            });
        },
    );

    test.each(['linux', 'darwin'])(
        'handles real ChildProcess spawn failure on %s without uncaughtException',
        async (platform) => {
            const child = await runChild((resultFile) => `
                import childProcess from 'node:child_process';
                import fs from 'node:fs';
                import { syncBuiltinESMExports } from 'node:module';

                let uncaught = null;
                process.on('uncaughtException', (err) => {
                    uncaught = String(err?.message || err);
                });

                Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
                const origSpawn = childProcess.spawn;
                childProcess.spawn = function failingRealSpawn(_cmd, args, opts) {
                    return origSpawn.call(this, '/nonexistent-luker-browser-launcher-bin', args, opts);
                };
                syncBuiltinESMExports();

                const { maybeLaunchBrowser } = await import(${JSON.stringify(BROWSER_LAUNCH_URL)});
                await maybeLaunchBrowser({
                    enabled: true,
                    url: 'http://127.0.0.1:8000',
                    browser: 'default',
                });
                await new Promise((r) => setTimeout(r, 30));
                fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ uncaught }));
            `);

            expect(child.status).toBe(0);
            expect(child.result).toEqual({ uncaught: null });
            expect(child.stderr).toContain('Failed to launch the browser. Open the URL manually.');
        },
    );
});
