import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DataMaidService } from '../../src/endpoints/data-maid.js';

function makeUserDirs(root) {
    const dirs = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group chats'),
        groups: path.join(root, 'groups'),
        userImages: path.join(root, 'user', 'images'),
        files: path.join(root, 'user', 'files'),
        themes: path.join(root, 'themes'),
        movingUI: path.join(root, 'movingUI'),
        quickreplies: path.join(root, 'QuickReplies'),
        thumbnails: path.join(root, 'thumbnails'),
        thumbnailsBg: path.join(root, 'thumbnails', 'bg'),
        thumbnailsAvatar: path.join(root, 'thumbnails', 'avatar'),
        thumbnailsPersona: path.join(root, 'thumbnails', 'persona'),
        backups: path.join(root, 'backups'),
    };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    return dirs;
}

describe('Data Maid image collection', () => {
    test('keeps body-embedded images out of the loose list', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-maid-'));
        const dirs = makeUserDirs(root);
        const chatDir = path.join(dirs.chats, 'Ash');
        fs.mkdirSync(chatDir, { recursive: true });

        const imageDir = path.join(dirs.userImages, 'Ash');
        fs.mkdirSync(imageDir, { recursive: true });
        const referenced = path.join(imageDir, 'referenced.png');
        const orphan = path.join(imageDir, 'orphan.png');
        fs.writeFileSync(referenced, 'ref');
        fs.writeFileSync(orphan, 'orphan');

        const header = { chat_metadata: {} };
        const message = { name: 'Ash', mes: '<img src="/user/images/Ash/referenced.png" alt="x">' };
        fs.writeFileSync(path.join(chatDir, 'main.jsonl'), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);

        const report = await new DataMaidService('default-user', dirs).generateReport();
        expect(report.images).toContain(orphan);
        expect(report.images).not.toContain(referenced);
    });
});
