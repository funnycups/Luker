import git from 'isomorphic-git';

import { commitLocalEdit, runSyncCycle } from '../../../src/sync/pipeline/cycle.js';
import { createConflictPolicy } from '../../../src/sync/pipeline/conflict-policy.js';
import { atomicFs } from '../../../src/sync/pipeline/atomic-fs.js';
import { openDevice } from './devices.js';

const config = JSON.parse(process.argv[2]);
const device = openDevice({ userRoot: config.userRoot, remoteDir: config.remoteDir, categories: config.categories });
if (config.policy) {
    device.ctx.onConflicts = createConflictPolicy({ directories: device.directories, localDevice: 'B', remoteDevice: 'remote' });
}
if (config.localEdit) {
    const { path, content } = config.localEdit;
    const result = await commitLocalEdit(device.ctx, async ({ gitdir, files }) => {
        const oid = await git.writeBlob({ fs: atomicFs, gitdir, blob: Buffer.from(content) });
        return { files: new Map([...files, [path, { oid, mode: '100644' }]]), message: 'local edit' };
    });
    process.stdout.write(JSON.stringify({ committed: result.committed }));
} else {
    const outcome = await runSyncCycle(device.ctx);
    process.stdout.write(JSON.stringify({ status: outcome.status, mergeCase: outcome.mergeCase }));
}
