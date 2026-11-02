import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../../storage/harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo, getGroupRepo, getStorageEngine } from '../../../src/storage/index.js';
import { materializeUserDataIntoWorkdir } from '../../../src/sync/materialize.js';
import { buildSidecarFilename } from '../../../src/storage/engines/sidecar-naming.js';
import { branchChatBaseName } from '../../../src/sync/pipeline/chat-fork.js';

const HEADER = { user_name: 'U', character_name: 'Seraphina', chat_metadata: {} };
const branch = branchChatBaseName({ base: 'Forest Path', deviceLabel: 'Phone', date: new Date(2026, 9, 13, 9, 5), taken: new Set() });

describe.each(ENDPOINT_HARNESSES)('chat fork companion names match the chat state endpoint on $name', ({ mode }) => {
    let harness;
    let workdir;
    beforeEach(async () => {
        harness = await makeEndpointHarness({ mode, mount: app => app.use('/api/chats', chatsRouter) });
        workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-fork-workdir-'));
    });
    afterEach(async () => {
        fs.rmSync(workdir, { recursive: true, force: true });
        await harness.cleanup();
    });

    async function companionRoot() {
        if (mode === 'fs') return harness.dirs.root;
        await materializeUserDataIntoWorkdir({ handle: harness.handle, directories: harness.dirs, categories: ['chats'], workdir, engine: getStorageEngine() });
        return workdir;
    }

    test('character branch companion', async () => {
        await getChatRepo().save(harness.handle, 'Seraphina', branch, HEADER, [], null);
        const res = await request(harness.server).post('/api/chats/state/patch')
            .send({ is_group: false, avatar_url: 'Seraphina.png', file_name: branch, namespace: 'memory_graph', operations: [{ op: 'add', path: '/k', value: 1 }] });
        expect(res.status).toBe(200);
        const rel = `chats/Seraphina/${buildSidecarFilename(branch, 'memory_graph')}`;
        expect(fs.existsSync(path.join(await companionRoot(), ...rel.split('/')))).toBe(true);
    });

    test('group branch companion', async () => {
        await getGroupRepo().save(harness.handle, 'g1', { id: 'g1', name: 'Glade Watch', members: ['Seraphina.png'], chat_id: 'Forest Path', chats: ['Forest Path', branch] });
        await getChatRepo().save(harness.handle, '', branch, HEADER, [], null, { isGroup: true, groupId: branch });
        const res = await request(harness.server).post('/api/chats/state/patch')
            .send({ is_group: true, id: branch, namespace: 'memory_graph', operations: [{ op: 'add', path: '/k', value: 1 }] });
        expect(res.status).toBe(200);
        const rel = `group chats/${buildSidecarFilename(branch, 'memory_graph')}`;
        expect(fs.existsSync(path.join(await companionRoot(), ...rel.split('/')))).toBe(true);
    });
});
