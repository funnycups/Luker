import fs from 'node:fs';
import { createHash } from 'node:crypto';

if (process.env.RESOURCE_ACK_CHANNEL) {
    let configuration;
    const observe = message => {
        if (message.type === 'configure') configuration = message;
        if (message.type !== 'acknowledgement-channel-probe') return;
        const filename = process.env.RESOURCE_ACK_CHANNEL;
        const receipt = { pid: process.pid, connected: process.connected, descriptor: process.channel.fd, configuration, runtime: { version: process.version, execPath: process.execPath, sourceSHA256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') } };
        fs.writeFileSync(filename + '.tmp', JSON.stringify(receipt), { flag: 'wx' });
        fs.renameSync(filename + '.tmp', filename);
        process.kill(process.pid, 'SIGSTOP');
    };
    const install = event => {
        if (event !== 'message' || !new Error('actual controller IPC admission').stack.includes('/resources/process-controller.js:')) return;
        process.removeListener('newListener', install);
        process.prependListener('message', observe);
    };
    process.on('newListener', install);
}
