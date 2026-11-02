import { DirectoryBackend } from './directory-backend.js';

const [remoteDir, userRoot, headOid] = process.argv.slice(2);
await new DirectoryBackend({ id: 'remote', remoteDir, userRoot }).pushObjects(headOid, null);
process.stdout.write('pushed');
