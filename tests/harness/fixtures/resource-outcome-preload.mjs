import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createHook } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.env.RESOURCE_OUTCOME_START || process.env.RESOURCE_OUTCOME_FAULT) {
    let config;
    const fault = process.env.RESOURCE_OUTCOME_FAULT && JSON.parse(process.env.RESOURCE_OUTCOME_FAULT);
    let injected;
    let fileFsync;
    let directoryFsync;
    const emit = native => {
        const receipt = { stage: fault.stage, pid: process.pid, resourceId: config.resourceId, executionId: config.executionId, runtime: { version: process.version, execPath: process.execPath }, native, stagedBytes: fs.readFileSync(config.terminal.path).toString('base64'), completionExists: fs.existsSync(config.terminal.completion), descriptors: execFileSync('lsof', ['-nP', '-a', '-p', String(process.pid), '-Ffn'], { encoding: 'utf8' }) };
        fs.writeFileSync(fault.root + '/publication-fault.json.tmp', JSON.stringify(receipt), { flag: 'wx' });
        fs.renameSync(fault.root + '/publication-fault.json.tmp', fault.root + '/publication-fault.json');
    };
    const closeOwned = () => {
        const stat = fs.fstatSync(4);
        assert.equal(stat.dev, config.terminal.dev); assert.equal(stat.ino, config.terminal.ino);
        fs.closeSync(4);
        return { descriptor: 4, dev: stat.dev, ino: stat.ino };
    };
    if (fault) createHook({
        init(id, type) {
            if (injected || !type.startsWith('FSREQ')) return;
            const stack = new Error('actual terminal native fsync boundary').stack;
            if (!stack.includes('fsync') || !stack.includes('/resources/process-terminal.js:')) return;
            if (fault.stage === 'close') {
                if (!fileFsync) fileFsync = { id, type, stack };
                else directoryFsync ??= { id, type, stack };
                return;
            }
            injected = { id, type, stack };
            if (fault.stage === 'durability') injected.closed = closeOwned();
            else if (fault.stage === 'completion') fs.chmodSync(config.terminal.directory.path, 0o500);
            else if (fault.stage !== 'hold') throw new Error(`Unsupported native terminal interval ${fault.stage}`);
            emit(injected);
            if (fault.stage === 'hold') process.kill(process.pid, 'SIGSTOP');
        },
        before(id) {
            if (injected || fault.stage !== 'close' || directoryFsync?.id !== id) return;
            injected = { fileFsync, directoryFsync, closed: closeOwned(), atNativeCompletion: true };
            emit(injected);
        },
    }).enable();
    const observe = message => {
        if (message.type === 'configure') config = message;
        if (message.type !== 'start' || !process.env.RESOURCE_OUTCOME_START) return;
        const filename = process.env.RESOURCE_OUTCOME_START;
        fs.writeFileSync(filename + '.tmp', JSON.stringify({ event: 'start-admitted', pid: process.pid, executionId: config.executionId, resourceId: config.resourceId, runId: config.runId, runtime: { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') } }), { flag: 'wx' });
        fs.renameSync(filename + '.tmp', filename);
        process.kill(process.pid, 'SIGSTOP');
    };
    const install = event => {
        if (event !== 'message' || !new Error('actual controller message admission').stack.includes('/resources/process-controller.js:')) return;
        process.removeListener('newListener', install);
        process.prependListener('message', observe);
        if (fault?.stage === 'prepare') process.prependOnceListener('disconnect', () => {
            injected = { closed: closeOwned(), stack: new Error('actual terminal transport preparation boundary').stack };
            emit(injected);
        });
    };
    process.on('newListener', install);
}
