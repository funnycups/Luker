import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateGroupChatsMetadataFormat } from '../../../src/endpoints/groups.js';

describe('group chat metadata migration', () => {
    test('migrates legacy chats[] entries carrying a .jsonl suffix', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-group-migration-'));
        const dirs = {
            root,
            groups: path.join(root, 'groups'),
            groupChats: path.join(root, 'group chats'),
            backups: path.join(root, 'backups'),
        };
        fs.mkdirSync(dirs.groups, { recursive: true });
        fs.mkdirSync(dirs.groupChats, { recursive: true });
        fs.writeFileSync(path.join(dirs.groupChats, 'legacy-chat.jsonl'), JSON.stringify({ name: 'User', mes: 'hi' }));
        fs.writeFileSync(path.join(dirs.groups, 'grp.json'), JSON.stringify({
            id: 'grp-1',
            chat_id: 'legacy-chat',
            chats: ['legacy-chat.jsonl'],
            chat_metadata: { lorebook: 'LegacyLore' },
        }));

        try {
            await migrateGroupChatsMetadataFormat([dirs]);

            const lines = fs.readFileSync(path.join(dirs.groupChats, 'legacy-chat.jsonl'), 'utf8')
                .split('\n').filter(line => line.trim());
            const header = JSON.parse(lines[0]);
            expect(header.chat_metadata.lorebook).toBe('LegacyLore');
            expect(lines).toHaveLength(2);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
