import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRun } from '../resources/run.js';
import { launchOwnedProcess } from '../resources/process-owner.js';

const [mode, encoded] = process.argv.slice(2);
const input = JSON.parse(encoded);
const runtime = { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') };
const write = (filename, value) => { fs.writeFileSync(filename + '.tmp', JSON.stringify(value)); fs.renameSync(filename + '.tmp', filename); };

if (mode === 'owner') {
    const run = await createRun({ projectRoot: input.projectRoot, profile: 'unit', source: 'held-native-owner', command: [process.execPath, new URL(import.meta.url).pathname, mode] });
    const scope = await run.scope({ kind: 'scenario', label: 'held native controller' });
    await scope.borrowDirectory(input.borrowed);
    const data = await scope.directory('dependent native data');
    fs.writeFileSync(data.path + '/scenario', 'original scenario data');
    const lease = await launchOwnedProcess(scope, { label: 'independently released service', command: [process.execPath, new URL(import.meta.url).pathname, 'held-service', encoded], readyLine: 'resource-ready', dependsOn: [data.resourceId] });
    process.send({ type: 'ready', runtime, registryPath: run.registryPath, data: data.path, pid: lease.pid, worker: JSON.parse(fs.readFileSync(input.report)) });
    await once(process, 'message');
    await run.finish({ status: 'passed' });
    process.disconnect();
} else {
    const server = net.createServer(socket => socket.end('actual boundary service'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const release = async filename => {
        if (fs.existsSync(filename)) return;
        const watcher = fs.watch(path.dirname(filename));
        try {
            if (fs.existsSync(filename)) return;
            for await (const [, changed] of onChanges(watcher)) if (changed === path.basename(filename)) return;
        } finally { watcher.close(); }
    };
    function onChanges(watcher) {
        return { async *[Symbol.asyncIterator]() { while (true) yield await once(watcher, 'change'); } };
    }
    process.once('SIGTERM', () => {
        if (mode === 'held-service') write(input.termination, { runtime, received: 'SIGTERM' });
        else server.close();
    });
    write(input.report, { runtime, pid: process.pid, port: server.address().port, argv: process.argv.slice(2), value: process.env.RESOURCE_CAPTURE_VALUE });
    if (mode === 'held-service') {
        process.stdout.write('resource-ready\n');
        await release(input.release);
        server.close();
    } else if (mode === 'utf8') {
        const bytes = Buffer.from(input.marker + '\r\n');
        await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(0, input.split), error => error ? reject(error) : resolve()));
        write(input.stage, { emitted: bytes.subarray(0, input.split).toString('hex'), runtime });
        await release(input.release);
        await new Promise((resolve, reject) => process.stdout.write(bytes.subarray(input.split), error => error ? reject(error) : resolve()));
        write(input.emitted, { emitted: bytes.toString('hex'), runtime });
    } else {
        process.stdout.write(process.env.RESOURCE_CAPTURE_VALUE + '\n');
        process.stdout.write(input.marker + '\n');
    }
}
