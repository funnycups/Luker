import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Display names for user directories must match production exactly:
// SQL engines store records in DB tables, so their contract harnesses use
// the JS key name as the on-disk path (it's never read). But the materializer
// uses `directories[bucketKey]` to compute the workdir-relative path, and
// the fs engine's repo reads/writes those same path values. Production
// `getUserDirectories(handle)` maps both to the human-readable name from
// USER_DIRECTORY_TEMPLATE. Mirror that mapping here so the matrix sees
// the same layout regardless of which engine produced the workdir.
const USER_DIR_DISPLAY = Object.freeze({
    root: '',
    thumbnails: 'thumbnails',
    thumbnailsBg: 'thumbnails/bg',
    thumbnailsAvatar: 'thumbnails/avatar',
    thumbnailsPersona: 'thumbnails/persona',
    worlds: 'worlds',
    user: 'user',
    avatars: 'User Avatars',
    userImages: 'user/images',
    groups: 'groups',
    groupChats: 'group chats',
    chats: 'chats',
    characters: 'characters',
    backgrounds: 'backgrounds',
    novelAI_Settings: 'NovelAI Settings',
    koboldAI_Settings: 'KoboldAI Settings',
    openAI_Settings: 'OpenAI Settings',
    textGen_Settings: 'TextGen Settings',
    themes: 'themes',
    movingUI: 'movingUI',
    extensions: 'extensions',
    instruct: 'instruct',
    context: 'context',
    quickreplies: 'QuickReplies',
    assets: 'assets',
    comfyWorkflows: 'user/workflows',
    files: 'user/files',
    vectors: 'vectors',
    backups: 'backups',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
    cardApps: 'card-apps',
});

// The MySQL/Postgres contract harnesses flatten every USER_DIRS key as a
// sibling under a single stub root because the engine itself never reads
// those paths — the records live in DB tables. The materializer DOES read
// `directories.root` and the per-bucket dirs together: `relUnder(root, bucket)`
// must yield a path UNDER root for `path.join(workdir, rel)` to land inside
// the workdir. So this helper rebuilds `dirs` with the production shape
// (each bucket nested as a child of `root`, using the production display
// names) on a fresh temp tree, leaves the engine untouched, and patches
// `cleanup` to remove both. Sqlite/fs harnesses already use the nested
// production-shape layout; for them this is a no-op pass-through.
export function withNestedDirs(harness) {
    const flat = harness.dirs;
    const flatRoot = flat.root;
    const nested = Object.entries(flat).every(([key, abs]) =>
        key === 'root' || (typeof abs === 'string' && abs.startsWith(flatRoot + path.sep)));
    if (nested) return harness;

    const newDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-nested-dirs-'));
    const userDir = path.join(newDataRoot, harness.handle || 'u');
    const dirsOut = { root: userDir };
    for (const key of Object.keys(flat)) {
        if (key === 'root') continue;
        const rel = USER_DIR_DISPLAY[key];
        if (typeof rel !== 'string') {
            // Pass-through anything not in the production template.
            dirsOut[key] = flat[key];
            continue;
        }
        dirsOut[key] = path.join(userDir, rel);
    }
    fs.mkdirSync(userDir, { recursive: true });
    const innerCleanup = harness.cleanup;
    return {
        ...harness,
        dirs: dirsOut,
        cleanup: async () => {
            await innerCleanup();
            fs.rmSync(newDataRoot, { recursive: true, force: true });
        },
    };
}
