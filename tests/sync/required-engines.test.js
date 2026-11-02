import { expect, test } from '@jest/globals';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.each([
    ['LUKER_DISABLE_MYSQL_TESTS'], ['LUKER_DISABLE_POSTGRES_TESTS'], ['LUKER_DISABLE_MYSQL_TESTS', 'LUKER_DISABLE_POSTGRES_TESTS'],
])('required sync matrices fail as blocked when disabled through %j', async (...flags) => {
    const disabled = flags.filter(flag => typeof flag === 'string');
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    const args = [...(process.execArgv.includes('--jitless') ? ['--jitless'] : []), '--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--config', 'jest.config.json', '--runInBand', '--testPathPattern', '/tests/sync/(materialize-cross-engine|integration/cycle-cross-engine)\\.test\\.js$'];
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...Object.fromEntries(disabled.map(flag => [flag, '1'])) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const terminal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    expect(terminal).toEqual({ code: 1, signal: null });
    expect(output.includes('BLOCKED: sync acceptance requires')).toBe(true);
    for (const flag of disabled) expect(output.includes(flag)).toBe(true);
}, 120_000);
