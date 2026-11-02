import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setConfigFilePath } from '../../../src/util.js';

setConfigFilePath(fileURLToPath(new URL('../../../default/config.yaml', import.meta.url)));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-registry-child-'));
globalThis.DATA_ROOT = scratch;
const { startLanDevice } = await import('./lan-devices.js');
const { upsertLanBackend } = await import('../../../src/sync/state.js');

const marker = 'rCred9X!';
const device = await startLanDevice();
const other = await startLanDevice({ handle: 'other-owner' });
const state = path.join(device.userRoot, '.sync/state.json');
await upsertLanBackend({ userRoot: device.userRoot, backendId: 'lan-owned', categories: ['worlds'], peerAuth: { username: 'fixture', password: marker } });
const original = fs.readFileSync(state);
const results = [];
let responseLeak = false;
try {
    for (const kind of ['json', 'shape', 'permission']) {
        const body = kind === 'json' ? marker : kind === 'shape' ? '{"version":99,"backends":{}}' : original;
        fs.writeFileSync(state, body);
        if (kind === 'permission') fs.chmodSync(state, 0o000);
        try {
            const responses = [];
            for (const [method, route, payload] of [
                ['GET', '/backends'], ['GET', '/status'],
                ['POST', '/schedule', { idleSeconds: 20, pollSeconds: 30 }],
                ['POST', '/device', { label: 'Changed device' }],
                ['POST', '/pair/start', { label: 'Add device', categories: ['worlds'] }],
            ]) responses.push(await device.call(method, route, { body: payload }));
            responseLeak ||= JSON.stringify(responses).includes(marker);
            const isolated = await other.call('GET', '/backends');
            results.push({ kind, statuses: responses.map(response => response.status), codes: responses.map(response => response.body?.code), isolated: isolated.status, names: fs.readdirSync(path.dirname(state)) });
        } finally { fs.chmodSync(state, 0o600); }
        results.at(-1).preserved = fs.readFileSync(state).equals(Buffer.from(body));
    }
} finally {
    fs.writeFileSync(state, original);
    await device.close();
    await other.close();
    fs.rmSync(scratch, { recursive: true });
}
console.log(JSON.stringify({ registryFailureEvidence: results, responseLeak }));
