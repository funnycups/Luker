import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sync as atomicWrite } from 'write-file-atomic';
import { read } from '../../../src/character-card-parser.js';

/** Native cache I/O rendezvous. The real reader receives the original PNG's complete datum. */
export function holdCharacterCacheRead(dataRoot, filename) {
    const source = fs.readFileSync(filename);
    atomicWrite(filename, source);
    // Must match the production disk-cache key: the `card-v2:` namespace
    // separates current card projections from older cached representations.
    const key = `card-v2:${filename}-${fs.statSync(filename).mtimeMs}`;
    const directory = path.join(dataRoot, '_cache', 'characters');
    fs.mkdirSync(directory, { recursive: true });
    const fifo = path.join(directory, createHash('sha256').update(key).digest('hex'));
    if (fs.existsSync(fifo)) throw new Error(`Expected an uncached source at ${fifo}`);
    execFileSync('mkfifo', [fifo]);
    const datum = { key, value: read(source), ttl: false };
    let writer, released = false;
    const opened = fsp.open(fifo, 'w').then(handle => { writer = handle; return { fifo, key, opened: new Date().toISOString() }; });
    return {
        source, datum, opened,
        async release() {
            await opened;
            await writer.writeFile(JSON.stringify(datum));
            await writer.close();
            fs.unlinkSync(fifo);
            released = true;
        },
        async close() {
            if (released) return;
            // Pair a pending native open during failed-fixture cleanup only.
            const rescue = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
            try { await opened; await writer.writeFile(JSON.stringify(datum)); await writer.close(); }
            finally { fs.closeSync(rescue); fs.unlinkSync(fifo); }
            released = true;
        },
    };
}
