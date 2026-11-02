import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FAILPOINTS, failpointMarker, PAUSEPOINTS, pausepoint, THROWPOINTS, throwpoint } from '../../../src/sync/pipeline/failpoints.js';

const MODULE_URL = new URL('../../../src/sync/pipeline/failpoints.js', import.meta.url).href;

function runWith(envName, hit, extraEnv = {}) {
    const script = [
        `import { failpoint } from ${JSON.stringify(MODULE_URL)};`,
        'process.on(\'exit\', () => process.stdout.write(\'exit-handler\'));',
        `failpoint(${JSON.stringify(hit)});`,
        'process.stdout.write(\'survived\');',
    ].join(' ');
    const result = spawnSync(process.execPath, [...(process.execArgv.includes('--jitless') ? ['--jitless'] : []), '--input-type=module', '-e', script], {
        env: { ...process.env, LUKER_SYNC_FAILPOINT_ARM: '', LUKER_SYNC_FAILPOINT: envName, ...extraEnv },
        encoding: 'utf8',
    });
    // V8 emits this startup diagnostic before module execution in --jitless.
    // Preserve it in the parent output while comparing the failpoint marker.
    const warning = 'Warning: disabling flag --expose_wasm due to conflicting flags\n';
    if (result.stderr.startsWith(warning)) {
        process.stderr.write(warning);
        result.stderr = result.stderr.slice(warning.length);
    }
    return result;
}

test('failpoint names are distinct', () => {
    const names = Object.values(FAILPOINTS);
    expect(new Set(names).size).toBe(names.length);
});

test('the selected failpoint names itself on stderr and dies by SIGKILL without running exit handlers', () => {
    const result = runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.PUSH_BEFORE_CAS);
    expect(result.signal).toBe('SIGKILL');
    expect(result.status).toBeNull();
    expect(result.stderr).toBe(failpointMarker(FAILPOINTS.PUSH_BEFORE_CAS));
    expect(result.stdout).toBe('');
});

test('other failpoints are no-ops', () => {
    const result = runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.SNAPSHOT_BEFORE_COMMIT);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('survivedexit-handler');
});

test('an optional arm file permits setup and is consumed before the selected kill exactly once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-crash-arm-'));
    const arm = path.join(dir, 'crash.arm');
    const env = { LUKER_SYNC_FAILPOINT_ARM: arm };
    try {
        expect(runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.PUSH_BEFORE_CAS, env).status).toBe(0);
        fs.writeFileSync(arm, '');
        expect(runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.SNAPSHOT_BEFORE_COMMIT, env).status).toBe(0);
        expect(fs.existsSync(arm)).toBe(true);
        const death = runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.PUSH_BEFORE_CAS, env);
        expect(death.signal).toBe('SIGKILL');
        expect(death.stderr).toBe(failpointMarker(FAILPOINTS.PUSH_BEFORE_CAS));
        expect(fs.existsSync(arm)).toBe(false);
        expect(runWith(FAILPOINTS.PUSH_BEFORE_CAS, FAILPOINTS.PUSH_BEFORE_CAS, env).status).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

async function waitUntil(check) {
    while (!check()) await new Promise(resolve => setImmediate(resolve));
}

describe('pausepoints and throwpoints', () => {
    let dir;
    const saved = { ...process.env };
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-pause-')); });
    afterEach(() => {
        for (const key of ['LUKER_SYNC_PAUSEPOINT', 'LUKER_SYNC_PAUSE_DIR', 'LUKER_SYNC_THROWPOINT', 'LUKER_SYNC_THROWPOINT_MATCH']) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a pausepoint waits for its release file', async () => {
        process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.AFTER_SNAPSHOT;
        process.env.LUKER_SYNC_PAUSE_DIR = dir;
        fs.writeFileSync(path.join(dir, 'after-snapshot.arm'), '');
        let done = false;
        const paused = pausepoint(PAUSEPOINTS.AFTER_SNAPSHOT).then(() => { done = true; });
        await waitUntil(() => fs.existsSync(path.join(dir, 'after-snapshot.reached')));
        expect(done).toBe(false);
        fs.writeFileSync(path.join(dir, 'after-snapshot.release'), '');
        await paused;
        expect(done).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([]);
        await pausepoint(PAUSEPOINTS.AFTER_SNAPSHOT);
    });

    test('an unarmed pausepoint returns at once', async () => {
        process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.AFTER_SNAPSHOT;
        process.env.LUKER_SYNC_PAUSE_DIR = dir;
        await pausepoint(PAUSEPOINTS.AFTER_SNAPSHOT);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('another pausepoint returns at once', async () => {
        process.env.LUKER_SYNC_PAUSEPOINT = PAUSEPOINTS.AFTER_SNAPSHOT;
        process.env.LUKER_SYNC_PAUSE_DIR = dir;
        await pausepoint(PAUSEPOINTS.INSIDE_SNAPSHOT_LOCK);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('a throwpoint throws only for a matching detail', () => {
        process.env.LUKER_SYNC_THROWPOINT = THROWPOINTS.RECONCILE_WRITE;
        process.env.LUKER_SYNC_THROWPOINT_MATCH = 'worlds/Ember';
        expect(() => throwpoint(THROWPOINTS.RECONCILE_WRITE, 'characters/a.png')).not.toThrow();
        expect(() => throwpoint(THROWPOINTS.RECONCILE_WRITE, 'worlds/Ember Ward.json')).toThrow(/luker-sync-throwpoint: reconcile-write/);
    });
});
