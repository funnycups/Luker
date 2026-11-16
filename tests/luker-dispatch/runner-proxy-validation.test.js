// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect } from '@jest/globals';
import { runLukerDispatch } from '../../src/luker-dispatch/runner.js';

function createResponseRecorder() {
    const state = { statusCode: 200, body: undefined };
    return {
        state,
        status(code) {
            state.statusCode = code;
            return this;
        },
        setHeader() {},
        json(body) {
            state.body = body;
            return this;
        },
    };
}

test('rejects an invalid network proxy before creating a generation job', async () => {
    const request = {
        body: {
            model: 'test-model',
            network_proxy: 'ftp://127.0.0.1:21',
            luker_generation: { job_id: `proxy-invalid-${Date.now()}` },
        },
        headers: {},
        user: { profile: { handle: 'proxy-invalid-test' }, directories: {} },
    };
    const response = createResponseRecorder();

    await runLukerDispatch(request, response, {
        endpoint: 'chat-completions',
        select: () => async () => {},
    });

    expect(response.state.statusCode).toBe(400);
    expect(response.state.body?.error).toMatch(/Unsupported proxy protocol/);
    expect(request.lukerGenerationJob).toBeUndefined();
});
