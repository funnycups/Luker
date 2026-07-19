import { makeFixtureUser } from './_fixture-helper.js';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';
import {
    enumerateCategory,
    enumerateChatsCharacter,
    enumerateGroupChats,
    enumerateChatFile,
    readFirstLineByteLen,
    StorageInspectorError,
} from '../../src/storage/inspector.js';

describe('enumerateCategory("chats") · L2', () => {
    test('empty user returns entries limited to character-chat-group / group-chats-virtual kinds', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({});
        try {
            const res = await enumerateCategory(userRoot, 'chats');
            expect(res.isLeaf).toBe(false);
            expect(res.path).toEqual(['chats']);
            for (const e of res.entries) {
                expect(['character-chat-group', 'group-chats-virtual']).toContain(e.kind);
            }
        } finally {
            await cleanup();
        }
    });

    test('rich fixture · 2 chars + group-chats virtual row', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await enumerateCategory(userRoot, 'chats');
            const keys = res.entries.map(e => e.key).sort();
            expect(keys).toEqual(expect.arrayContaining(['__group_chats__', 'default_Coding', 'default_Seraphina']));

            const seraphina = res.entries.find(e => e.key === 'default_Seraphina');
            expect(seraphina.kind).toBe('character-chat-group');
            expect(seraphina.sizeBytes).toBeGreaterThan(0);
            expect(seraphina.childCount).toBe(2); // 2 chats

            const grp = res.entries.find(e => e.key === '__group_chats__');
            expect(grp.kind).toBe('group-chats-virtual');
            expect(grp.sizeBytes).toBeGreaterThan(0);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateChatsCharacter · L3', () => {
    test('lists chat files with chat+sidecar合计 size', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await enumerateChatsCharacter(userRoot, 'default_Seraphina');
            expect(res.path).toEqual(['chats', 'default_Seraphina']);
            const labels = res.entries.map(e => e.label).sort();
            expect(labels).toEqual(['Chat 2024-01-15.jsonl', 'Chat 2024-02-20.jsonl']);
            for (const e of res.entries) {
                expect(e.kind).toBe('chat-file');
                expect(e.canDrill).toBe(true);
                expect(e.sizeBytes).toBeGreaterThan(0);
                expect(e.childCount).toBeGreaterThanOrEqual(3); // chat body + 2 sidecars
            }
        } finally {
            await cleanup();
        }
    });

    test('non-existent char throws StorageInspectorError', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            await expect(enumerateChatsCharacter(userRoot, 'bogus_char'))
                .rejects.toThrow(StorageInspectorError);
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateGroupChats · L3', () => {
    test('lists each group chat file', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const res = await enumerateGroupChats(userRoot);
            expect(res.path).toEqual(['chats', '__group_chats__']);
            expect(res.entries.some(e => e.label === 'group_abc.jsonl')).toBe(true);
        } finally {
            await cleanup();
        }
    });
});

describe('readFirstLineByteLen', () => {
    test('returns byte length of first line without trailing newline', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const chatPath = path.join(userRoot, 'chats/default_Seraphina/Chat 2024-01-15.jsonl');
            const firstLine = (await fsPromises.readFile(chatPath, 'utf-8')).split('\n')[0];
            const len = await readFirstLineByteLen(chatPath);
            expect(len).toBe(Buffer.byteLength(firstLine, 'utf-8'));
        } finally {
            await cleanup();
        }
    });
});

describe('enumerateChatFile · L4 leaf', () => {
    test('splits into metadata + messages + sidecar rows', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const chatPath = path.join(userRoot, 'chats/default_Seraphina/Chat 2024-01-15.jsonl');
            const res = await enumerateChatFile(
                chatPath,
                'Chat 2024-01-15.jsonl',
                ['chats', 'default_Seraphina', 'Chat 2024-01-15.jsonl'],
            );
            expect(res.isLeaf).toBe(true);
            const kinds = res.entries.map(e => e.kind).sort();
            expect(kinds).toEqual(expect.arrayContaining(['chat-metadata', 'chat-messages', 'chat-sidecar', 'chat-sidecar']));

            const meta = res.entries.find(e => e.kind === 'chat-metadata');
            const msgs = res.entries.find(e => e.kind === 'chat-messages');
            expect(meta.sizeBytes).toBeGreaterThan(0);
            expect(msgs.sizeBytes).toBeGreaterThan(0);

            // math relation · metadataBytes + messagesBytes = totalBytes - 1(减去 metadata 行后那个 \n)
            const totalBytes = (await fsPromises.stat(chatPath)).size;
            expect(meta.sizeBytes + msgs.sizeBytes).toBe(totalBytes - 1);
        } finally {
            await cleanup();
        }
    });

    test('sidecar rows carry namespace as label', async () => {
        const { userRoot, cleanup } = await makeFixtureUser({ chatsRich: true });
        try {
            const chatPath = path.join(userRoot, 'chats/default_Seraphina/Chat 2024-01-15.jsonl');
            const res = await enumerateChatFile(chatPath, 'Chat 2024-01-15.jsonl',
                ['chats', 'default_Seraphina', 'Chat 2024-01-15.jsonl']);
            const sidecars = res.entries.filter(e => e.kind === 'chat-sidecar');
            const labels = sidecars.map(s => s.label).sort();
            expect(labels).toEqual(['luker_orchestrator_anchors__floor_log', 'memory_graph__floor_log']);
        } finally {
            await cleanup();
        }
    });
});
