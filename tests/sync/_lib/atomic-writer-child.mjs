import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';

const [target, sizeArg] = process.argv.slice(2);
const size = Number(sizeArg);
const payloads = [Buffer.alloc(size, 'A'), Buffer.alloc(size, 'B')];
await atomicFs.promises.writeFile(target, payloads[0]);
process.stdout.write('ready\n');
for (let round = 1; ; round++) {
    await atomicFs.promises.writeFile(target, payloads[round % 2]);
}
