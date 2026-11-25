// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect } from '@jest/globals';

import { testWithResources } from '../harness/jest.js';
import { DataMaidService } from '../../src/endpoints/data-maid.js';

function makeUserDirs(root) {
    const dirs = {
        root,
        chats: path.join(root, 'chats'),
        groupChats: path.join(root, 'group chats'),
        groups: path.join(root, 'groups'),
        characters: path.join(root, 'characters'),
        openAI_Settings: path.join(root, 'OpenAI Settings'),
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

describe('Data Maid scoped state attachment reference scanning', () => {
    testWithResources('protects _ai_attachments referenced in character, chat, preset, and global states and flags unreferenced orphans', async (scope) => {
        const dir = await scope.directory('data-maid-scoped-states');
        const dirs = makeUserDirs(dir.path);
        const attDir = path.join(dirs.userImages, '_ai_attachments');
        fs.mkdirSync(attDir, { recursive: true });

        const files = {
            charRef: path.join(attDir, 'char-ref.png'),
            chatRef: path.join(attDir, 'chat-ref.png'),
            groupChatRef: path.join(attDir, 'group-chat-ref.png'),
            presetRef: path.join(attDir, 'preset-ref.png'),
            globalRef: path.join(attDir, 'global-ref.png'),
            orphan: path.join(attDir, 'orphan.png'),
        };
        for (const f of Object.values(files)) fs.writeFileSync(f, 'img');

        // Character state sidecar (e.g. workbench character session / CardApp Studio)
        fs.writeFileSync(
            path.join(dirs.characters, 'Alice.state.workbench_session_s1.json'),
            JSON.stringify({ turns: [{ role: 'user', attachments: [{ path: '/user/images/_ai_attachments/char-ref.png' }] }] }),
        );
        // Chat state sidecar (individual chat)
        const aliceChats = path.join(dirs.chats, 'Alice');
        fs.mkdirSync(aliceChats, { recursive: true });
        fs.writeFileSync(
            path.join(aliceChats, 'chat1.state.workbench_session_s2.json'),
            JSON.stringify({ turns: [{ role: 'user', attachments: [{ path: '/user/images/_ai_attachments/chat-ref.png' }] }] }),
        );
        // Group chat state sidecar
        fs.writeFileSync(
            path.join(dirs.groupChats, 'grp1.state.workbench_session_s3.json'),
            JSON.stringify({ turns: [{ role: 'user', attachments: [{ path: '/user/images/_ai_attachments/group-chat-ref.png' }] }] }),
        );
        // Preset state sidecar
        fs.writeFileSync(
            path.join(dirs.openAI_Settings, 'Default.state.workbench_session_s4.json'),
            JSON.stringify({ turns: [{ role: 'user', attachments: [{ path: '/user/images/_ai_attachments/preset-ref.png' }] }] }),
        );
        // Global state
        const statesDir = path.join(dirs.root, 'states');
        fs.mkdirSync(statesDir, { recursive: true });
        fs.writeFileSync(
            path.join(statesDir, 'sd_studio_sessions.json'),
            JSON.stringify({ sessions: { st1: { messages: [{ role: 'user', attachments: [{ path: '/user/images/_ai_attachments/global-ref.png' }] }] } } }),
        );

        const report1 = await new DataMaidService('default-user', dirs).generateReport();
        expect(report1.images).not.toContain(files.charRef);
        expect(report1.images).not.toContain(files.chatRef);
        expect(report1.images).not.toContain(files.groupChatRef);
        expect(report1.images).not.toContain(files.presetRef);
        expect(report1.images).not.toContain(files.globalRef);
        expect(report1.images).toContain(files.orphan);

        // Removing the character state sidecar causes charRef to become cleanable
        fs.unlinkSync(path.join(dirs.characters, 'Alice.state.workbench_session_s1.json'));
        const report2 = await new DataMaidService('default-user', dirs).generateReport();
        expect(report2.images).toContain(files.charRef);
        expect(report2.images).not.toContain(files.chatRef);
    });
});
