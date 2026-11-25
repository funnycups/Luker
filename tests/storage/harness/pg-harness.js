import path from 'node:path';
import { PgEngine } from '../../../src/storage/engines/postgres-engine.js';
import { acquirePostgresDatabase, PG_ROOT_URL } from '../../harness/database.js';
import { currentScopeForResources } from '../../harness/storage-scope.js';

// Stub directory map. PgEngine stores nothing on disk, but the Repo contract
// tests share their beforeEach with FsEngine, which means they call
// `fs.mkdirSync(h.dirs.<bucket>, { recursive: true })` to pre-create the FS
// scaffold. Hand back paths under a managed directory so those calls succeed;
// tests that assert on FS state use the FS harness instead.
const USER_DIR_KEYS = Object.freeze([
    'root', 'thumbnails', 'thumbnailsBg', 'thumbnailsAvatar', 'thumbnailsPersona',
    'worlds', 'user', 'avatars', 'userImages', 'groups', 'groupChats', 'chats',
    'characters', 'backgrounds', 'novelAI_Settings', 'koboldAI_Settings',
    'openAI_Settings', 'textGen_Settings', 'themes', 'movingUI', 'extensions',
    'instruct', 'context', 'quickreplies', 'assets', 'comfyWorkflows', 'files',
    'vectors', 'backups', 'sysprompt', 'reasoning', 'cardApps', 'states',
]);

function buildStubDirs(rootDir) {
    const dirs = {};
    for (const key of USER_DIR_KEYS) dirs[key] = path.join(rootDir, key);
    return dirs;
}

// Each call leases its own schema inside the shared test database, so parallel
// tests don't collide. The managed scope owns the schema; the harness only
// closes its engine.
export async function makeTempPgEngineHarness({ scope = currentScopeForResources() } = {}) {
    if (!scope || typeof scope.directory !== 'function') throw new TypeError('PostgreSQL contract harness requires a managed resource scope');
    const lease = await acquirePostgresDatabase(scope, PG_ROOT_URL);
    const engine = new PgEngine({ url: lease.url });
    const stubRoot = (await scope.directory('postgres contract')).path;
    const dirs = buildStubDirs(stubRoot);
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await engine.close();
    };
    await scope.onFinalize({ label: 'close postgres contract engine', stage: 'capture', callback: close });
    return {
        engine,
        kind: 'postgres',
        handle: 'u',
        schemaName: lease.namespace,
        url: lease.url,
        dataRoot: stubRoot,
        backupRoot: path.join(stubRoot, '_storage-migrations'),
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: close,
    };
}
