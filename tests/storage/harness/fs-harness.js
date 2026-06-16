import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FsEngine } from '../../../src/storage/engines/fs-engine.js';

// Mirror src/constants.js USER_DIRECTORY_TEMPLATE — keep keys in sync so any
// future Repo that targets a directory can find it on the harness's stub.
const USER_DIRS = Object.freeze({
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

export async function makeTempFsEngine() {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fs-engine-test-'));
    const handle = 'u';
    const userDir = path.join(dataRoot, handle);
    const dirs = {};
    for (const [key, rel] of Object.entries(USER_DIRS)) {
        dirs[key] = path.join(userDir, rel);
    }
    // Pre-create the directories existing tests rely on. Preset/other handlers
    // mkdirSync-on-write so they don't need pre-creation here.
    fs.mkdirSync(dirs.characters, { recursive: true });
    fs.mkdirSync(dirs.chats, { recursive: true });

    const engine = new FsEngine({
        directoriesByHandle: (h) => {
            if (h !== handle) throw new Error(`unknown handle ${h}`);
            return dirs;
        },
    });

    return {
        engine,
        dataRoot,
        handle,
        charsDir: dirs.characters,
        chatsDir: dirs.chats,
        dirs,
        cleanup: () => fs.rmSync(dataRoot, { recursive: true, force: true }),
    };
}
