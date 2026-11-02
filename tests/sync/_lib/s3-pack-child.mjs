import { ensureShadowRepo } from '../../../src/sync/shadow.js';
import { createS3Client } from '../../../src/sync/backends/s3/client.js';
import { fetchAndIndexPacks } from '../../../src/sync/backends/s3/packs.js';
import { setConfigFilePath } from '../../../src/util.js';
import { fileURLToPath } from 'node:url';

setConfigFilePath(fileURLToPath(new URL('../../../default/config.yaml', import.meta.url)));
const input = JSON.parse(process.env.LUKER_PACK_CHILD);
const paths = await ensureShadowRepo({ userRoot: input.root, peerId: 's3-test' });
const transport = createS3Client({ owner: { getCurrentProfile: async () => ({ enabled: true, admin: true }) }, settings: input.settings });
try {
    await fetchAndIndexPacks({ transport, paths, key: Buffer.from(input.key, 'base64'), keyId: input.keyId, context: input.settings, head: input.head, withLocal: fn => fn() });
} finally { await transport.close(); }
