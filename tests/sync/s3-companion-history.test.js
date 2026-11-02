import { afterEach, beforeEach, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { assertCompanionHistory } from '../e2e/_lib/s3-chat.js';
import { commitFiles } from './_lib/commits.js';

const CHAT = 'chats/Seraphina/Forest Path.jsonl';
const COMPANION = 'chats/Seraphina/Forest Path.luker-state.memory_graph.json';
const PAYLOAD = { nodes: { spring: { facts: ['birches', 'silver stones'], revision: 7 } }, edges: [], legacyNote: ['before dawn', 'north path'] };
let root, gitdir, device;

beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-companion-history-'));
    const syncRoot = path.join(root, 'default-user', '.sync');
    gitdir = path.join(syncRoot, 'history', 'repo.git');
    await git.init({ fs, gitdir, bare: true, defaultBranch: 'main' });
    // Offline reader input only. No server or backend is started/configured.
    fs.writeFileSync(path.join(syncRoot, 'state.json'), JSON.stringify({ backends: { history: {} } }));
    device = { server: { dataRoot: root } };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function history(content = JSON.stringify(PAYLOAD)) {
    const absent = await commitFiles(gitdir, {});
    const matching = await commitFiles(gitdir, { [COMPANION]: JSON.stringify(PAYLOAD) }, [absent]);
    const head = await commitFiles(gitdir, { [COMPANION]: content }, [matching]);
    await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: head, force: true });
    return { matching, head };
}

function removeLooseObject(oid) {
    fs.unlinkSync(path.join(gitdir, 'objects', oid.slice(0, 2), oid.slice(2)));
}

test('a present complete historical payload passes', async () => {
    await history();
    await expect(assertCompanionHistory(device, [CHAT], PAYLOAD)).resolves.toBeUndefined();
});

test('genuinely absent paths do not hide a complete matching historical payload', async () => {
    const { head } = await history();
    const absent = await commitFiles(gitdir, {}, [head]);
    await git.writeRef({ fs, gitdir, ref: 'refs/heads/main', value: absent, force: true });
    await expect(git.readBlob({ fs, gitdir, oid: absent, filepath: COMPANION })).rejects.toMatchObject({ code: 'NotFoundError' });
    await expect(assertCompanionHistory(device, [CHAT], PAYLOAD)).resolves.toBeUndefined();
});

const faults = [
    { name: 'missing root tree', causeKey: 'code', causeValue: 'NotFoundError', content: '{"other":"root tree"}',
        damage: async head => removeLooseObject((await git.readCommit({ fs, gitdir, oid: head })).commit.tree) },
    { name: 'missing nested tree', causeKey: 'code', causeValue: 'NotFoundError', content: '{"other":"nested tree"}',
        damage: async head => removeLooseObject((await git.readTree({ fs, gitdir, oid: head, filepath: 'chats/Seraphina' })).oid) },
    { name: 'missing referenced blob', causeKey: 'code', causeValue: 'NotFoundError', content: '{"other":"blob"}',
        damage: async head => removeLooseObject((await git.readBlob({ fs, gitdir, oid: head, filepath: COMPANION })).oid) },
    { name: 'invalid JSON', causeKey: 'name', causeValue: 'SyntaxError', content: '{', damage: async () => {} },
];

test.each(faults)('$name rejects with commit/path context even when another version still matches', async ({ damage, content, causeKey, causeValue }) => {
    const { matching, head } = await history(content);
    await damage(head);
    const readable = await git.readBlob({ fs, gitdir, oid: matching, filepath: COMPANION });
    expect(JSON.parse(Buffer.from(readable.blob).toString())).toEqual(PAYLOAD);
    const result = assertCompanionHistory(device, [CHAT], PAYLOAD);
    await expect(result).rejects.toThrow(`commit ${head} path ${COMPANION}`);
    await expect(result).rejects.toHaveProperty(`cause.${causeKey}`, causeValue);
});
