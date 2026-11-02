import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { isDeepStrictEqual } from 'node:util';

import { startLanDevice, pair } from '../_lib/lan-devices.js';
import { until } from '../_lib/until.js';
import { SqliteEngine } from '../../../src/storage/engines/sqlite-engine.js';
import { readSqlRecordValue, writeSqlRecordValue } from '../../../src/sync/materialize.js';
import { _resetGateForTests } from '../../../src/sync/in-progress-gate.js';

const WORLD = { kind: 'world', name: 'Glade Lore' };
const CHAT = { kind: 'chat', charDir: 'Seraphina', name: 'Forest Path', isGroup: false };
const sqliteDevice = () => startLanDevice({ makeEngine: directories => new SqliteEngine({ directoriesByHandle: () => directories }) });
const read = (device, record) => device.engine.withTransaction('u', tx => readSqlRecordValue(tx, 'u', record));

describe('LAN sync between two sqlite devices', () => {
    let A;
    let B;
    beforeEach(async () => {
        _resetGateForTests();
        A = await sqliteDevice();
        B = await sqliteDevice();
    });
    afterEach(async () => {
        await A.close();
        await B.close();
    });

    test('records travel both ways through pairing and a later sync', async () => {
        const world = { entries: { 0: { uid: 0, key: ['glade'], content: 'The glade hums at dusk.' } } };
        await A.engine.withTransaction('u', tx => writeSqlRecordValue(tx, 'u', WORLD, world));
        const id = await pair(A, B, { categories: ['worlds', 'chats'] });
        expect(await read(B, WORLD)).toEqual(world);
        const chat = { header: { user_name: 'U', character_name: 'Seraphina', chat_metadata: {} }, body: [{ name: 'U', is_user: true, mes: 'Is the path safe?' }] };
        await B.engine.withTransaction('u', tx => writeSqlRecordValue(tx, 'u', CHAT, chat));
        expect((await B.call('POST', `/backends/${id}/sync`)).body.ok).toBe(true);
        await until(async () => isDeepStrictEqual((await read(A, CHAT))?.body, chat.body));
    });
});
