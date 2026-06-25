// /api/chats/get is the "is there any chat?" probe. The legacy version short-
// circuited on `fs.existsSync(<chats>/<charDir>)`, which is always false in
// db modes — making the engine state invisible.

import request from 'supertest';

import { ENDPOINT_HARNESSES, makeEndpointHarness } from '../harness/endpoint-harness.js';
import { router as chatsRouter } from '../../../src/endpoints/chats.js';
import { getChatRepo } from '../../../src/storage/index.js';

const HEADER = { user_name: 'tester', character_name: 'Alice', chat_metadata: {} };
const MESSAGES = [
    { name: 'User', is_user: true, mes: 'hi' },
    { name: 'Alice', is_user: false, mes: 'hello' },
];

describe.each(ENDPOINT_HARNESSES)('/api/chats/get on $name', ({ mode }) => {
    let harness;

    beforeEach(async () => {
        harness = await makeEndpointHarness({
            mode,
            mount: (app) => { app.use('/api/chats', chatsRouter); },
        });
    });

    afterEach(async () => {
        if (harness) await harness.cleanup();
    });

    test('REGRESSION: probe returns saved chat when only the engine has it', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'c1', HEADER, MESSAGES, null);

        // Probe with file_name — must hit the engine, not short-circuit on directory existence.
        const res = await request(harness.app)
            .post('/api/chats/get')
            .send({ avatar_url: 'Alice.png', file_name: 'c1' })
            .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        // [headerWithIntegrity, ...messages]
        expect(res.body.length).toBe(MESSAGES.length + 1);
        expect(res.body[1].mes).toBe('hi');
    });

    test('REGRESSION: probe without file_name returns new_chat:true when engine is empty', async () => {
        const res = await request(harness.app)
            .post('/api/chats/get')
            .send({ avatar_url: 'NewChar.png' })
            .expect(200);
        expect(res.body.new_chat).toBe(true);
    });

    test('REGRESSION: probe with unknown file_name returns new_chat:true', async () => {
        await getChatRepo().save(harness.handle, 'Alice', 'c1', HEADER, MESSAGES, null);
        const res = await request(harness.app)
            .post('/api/chats/get')
            .send({ avatar_url: 'Alice.png', file_name: 'does-not-exist' })
            .expect(200);
        expect(res.body.new_chat).toBe(true);
    });
});
