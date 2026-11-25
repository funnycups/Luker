import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { worldFilenameState } from './world-filenames.js';

// Opening the native FIFO for writing completes only when the production
// settings read opens its reader, after conditional identity capture.
const { fifo, directory, action, settings, canonicalBytes } = workerData;
parentPort.postMessage({ event: 'opening', fifo });
const writer = fs.openSync(fifo, 'w');
try {
    const stat = fs.fstatSync(writer);
    const before = worldFilenameState(directory);
    if (action === 'remove-canonical') fs.unlinkSync(path.join(directory, 'Archive Ledger.json'));
    if (action === 'create-canonical' || action === 'replace-legacy') fs.writeFileSync(path.join(directory, 'Archive Ledger.json'), canonicalBytes, { flag: 'wx' });
    if (action === 'replace-legacy') fs.unlinkSync(path.join(directory, 'Archive Ledger.JSON'));
    let retainedDirectory = directory;
    if (action === 'obstruct-inspection') {
        retainedDirectory = directory + '-retained';
        fs.renameSync(directory, retainedDirectory);
        fs.writeFileSync(directory, 'External directory obstruction', { flag: 'wx' });
    }
    const after = worldFilenameState(retainedDirectory);
    fs.writeSync(writer, JSON.stringify(settings));
    parentPort.postMessage({ event: 'released', nativeFifo: stat.isFIFO(), before, after, retainedDirectory });
} finally {
    fs.closeSync(writer);
}
