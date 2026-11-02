import { test, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('registry read failures reject authenticated reads and mutations without disclosing private JSON to responses or process output', async () => {
    const child = spawn(process.execPath, [...(process.execArgv.includes('--jitless') ? ['--jitless'] : []), fileURLToPath(new URL('../_lib/registry-failure-child.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const terminal = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    expect(terminal).toEqual({ code: 0, signal: null });
    expect(output.includes('rCred9X!')).toBe(false);
    const line = output.split('\n').find(line => line.startsWith('{"registryFailureEvidence"'));
    expect(typeof line).toBe('string');
    const evidence = JSON.parse(line);
    expect(evidence.responseLeak).toBe(false);
    expect(evidence.registryFailureEvidence).toEqual(['json', 'shape', 'permission'].map(kind => ({
        kind, statuses: [500, 500, 500, 500, 500], codes: expect.any(Array), isolated: 200, names: ['state.json'], preserved: true,
    })));
}, 60_000);
