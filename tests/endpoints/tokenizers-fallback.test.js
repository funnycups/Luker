import { describe, test, expect, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Force the tiktoken path to fail so both /openai/count catch branches
// run. The tiktoken dependency is the only mock here — the router, the
// fallback estimator, and the request pipeline are the real ones.
jest.unstable_mockModule('tiktoken', () => ({
    default: {
        encoding_for_model: () => { throw new Error('tiktoken unavailable'); },
    },
}));

let tokenizersRouter;

beforeAll(async () => {
    ({ router: tokenizersRouter } = await import('../../src/endpoints/tokenizers.js'));
});

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/tokenizers', tokenizersRouter);
    return app;
}

describe('tokenizer fallback estimation', () => {
    test('POST /openai/count returns an estimated token count when the tokenizer fails', async () => {
        const app = makeApp();
        const body = [{ role: 'user', content: 'The reef shifts with the tide.' }];
        const res = await request(app)
            .post('/api/tokenizers/openai/count?model=gpt-4')
            .send(body);

        expect(res.status).toBe(200);
        expect(typeof res.body.token_count).toBe('number');
        expect(res.body.token_count).toBeGreaterThan(0);
    });

    test('POST /openai/count-batch returns per-message estimates when the tokenizer fails', async () => {
        const app = makeApp();
        const body = [
            { role: 'user', content: 'First message about the lantern.' },
            { role: 'assistant', content: 'The wick is trimmed and ready.' },
        ];
        const res = await request(app)
            .post('/api/tokenizers/openai/count-batch?model=gpt-4')
            .send(body);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.token_counts)).toBe(true);
        expect(res.body.token_counts).toHaveLength(2);
        for (const count of res.body.token_counts) {
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThan(0);
        }
        expect(res.body.token_count).toBe(res.body.token_counts[0] + res.body.token_counts[1]);
    });
});
