import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let boot;

async function bootIdentity() {
    if (process.platform === 'linux') return (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (process.platform === 'darwin') return (await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])).stdout.trim();
    throw new Error(`Native process identity is not implemented for ${process.platform}; use a supported execution platform`);
}

/** Native identity has OS timestamp precision; only an execution-bound controller may signal. */
export async function readProcessIdentity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('Native process identity requires a positive integer pid');
    boot ??= bootIdentity();
    const bootId = await boot;
    if (!bootId) throw new Error('Native boot identity is empty');
    if (process.platform === 'linux') {
        try {
            const source = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = source.slice(source.lastIndexOf(')') + 2).trim().split(/\s+/);
            const stat = await fs.stat(`/proc/${pid}`);
            if (!/^\d+$/.test(fields[19])) throw new Error(`Native start identity is invalid for process ${pid}`);
            if (fields[0] === 'Z' || fields[0] === 'X') return null;
            return { platform: process.platform, bootId, pid, startTime: fields[19], uid: stat.uid };
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw new Error(`Cannot inspect native process ${pid}: ${error.message}`, { cause: error });
        }
    }
    try {
        const { stdout } = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'uid=', '-o', 'stat='], { env: { ...process.env, LC_ALL: 'C' } });
        const fields = stdout.trim().match(/^(.+?)\s+(\d+)\s+(\S+)$/);
        if (!fields) throw new Error(`Native start identity is invalid for process ${pid}: ${stdout.trim()}`);
        if (fields[3].startsWith('Z')) return null;
        return { platform: process.platform, bootId, pid, startTime: fields[1].replace(/\s+/g, ' '), uid: Number(fields[2]) };
    } catch (error) {
        if (error.code === 1 && error.stdout === '' && error.stderr === '') return null;
        throw new Error(`Cannot inspect native process ${pid}: ${error.message}`, { cause: error });
    }
}

export function sameProcessIdentity(left, right) {
    return left !== null && right !== null && ['platform', 'bootId', 'pid', 'startTime', 'uid'].every(key => left[key] === right[key]);
}

export function validateProcessIdentity(identity) {
    if (!identity || !['darwin', 'linux'].includes(identity.platform) || typeof identity.bootId !== 'string' || !identity.bootId || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.startTime !== 'string' || !identity.startTime || !Number.isSafeInteger(identity.uid) || identity.uid < 0) {
        throw new TypeError('Registered native process identity is invalid');
    }
}

export function validateProcessExit(exit) {
    if (!exit || !(exit.code === null || Number.isInteger(exit.code)) || !(exit.signal === null || typeof exit.signal === 'string' && exit.signal.length > 0) || (exit.code === null) === (exit.signal === null)) {
        throw new TypeError('Registered native process exit is invalid');
    }
}
