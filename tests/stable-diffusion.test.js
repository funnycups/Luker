import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: jest.fn(),
    getRequestedSecretId: jest.fn(),
    SECRET_KEYS: {},
}));

// Fake WebSocket injected through comfy.js's test hook: the dispatch waits
// for an `executing`/`node: null` message before reading /history. Stands in
// for the upstream `ws` module (CJS + ESM mock friction).
class FakeWebSocket extends EventEmitter {
    static instances = [];
    static onNew = null;
    constructor(url) {
        super();
        this.url = url;
        this.terminated = false;
        this.closed = false;
        FakeWebSocket.instances.push(this);
        if (FakeWebSocket.onNew) {
            setImmediate(() => FakeWebSocket.onNew(this));
        }
    }
    terminate() { this.terminated = true; }
    close(code = 1000) {
        if (this.closed) return;
        this.closed = true;
        setImmediate(() => this.emit('close', code));
    }
}

describe('ComfyUI generation', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    /** @type {(ctor: any) => void} */
    let setWebSocketForTest;
    /** @type {() => void} */
    let resetWebSocketForTest;
    /** @type {(requestId: string, owner: string) => any} */
    let getTaskByRequestId;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/stable-diffusion.js');
        const comfy = await import('../src/luker-dispatch/providers/sd/comfy.js');
        setWebSocketForTest = comfy.__setWebSocketForTest;
        resetWebSocketForTest = comfy.__resetWebSocketForTest;
        ({ getTaskByRequestId } = await import('../src/endpoints/backends/luker-generation.js'));

        const app = express();
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = {
                profile: { handle: 'test-user' },
                directories: {},
            };
            next();
        });
        app.use(router);
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        fetchMock.mockReset();
        FakeWebSocket.instances.length = 0;
        FakeWebSocket.onNew = null;
        setWebSocketForTest(FakeWebSocket);
    });

    afterEach(() => {
        resetWebSocketForTest();
    });

    /**
     * Drives the real HTTP route, then reads the generation job the dispatch
     * wrote to. Luker's SD routes answer 200 {} immediately and stream the
     * payload through generation-job events, so assertions read the job.
     */
    async function runComfy(jobId, promptId) {
        FakeWebSocket.onNew = (ws) => {
            ws.emit('open');
            setTimeout(() => {
                ws.emit('message', Buffer.from(JSON.stringify({
                    type: 'executing',
                    data: { prompt_id: promptId, node: null },
                })));
            }, 10);
        };

        const response = await fetch(`${baseUrl}/comfy/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: 'http://127.0.0.1:8188',
                prompt: '{}',
                luker_generation: { job_id: jobId },
            }),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({});

        const deadline = Date.now() + 2000;
        let job = null;
        while (Date.now() < deadline) {
            job = getTaskByRequestId(jobId, 'test-user');
            if (job && job.status !== 'running') break;
            await new Promise(r => setTimeout(r, 10));
        }
        expect(job).not.toBeNull();
        return job;
    }

    function findChunkPayload(job) {
        const chunk = job.events.find(e => e?.data?.kind === 'chunk');
        expect(chunk).toBeDefined();
        const bytes = chunk.data.data;
        return JSON.parse(Buffer.from(bytes).toString('utf8'));
    }

    test('skips output nodes without images', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-1' }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    'prompt-1': {
                        status: { status_str: 'success' },
                        outputs: {
                            117: { a_images: [{ filename: 'comparison.png' }] },
                            197: { images: [{ filename: 'result.png', subfolder: '', type: 'temp' }] },
                        },
                    },
                }),
            })
            .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });

        const job = await runComfy('comfy-images-1', 'prompt-1');
        expect(job.status).toBe('awaiting_ack');
        expect(findChunkPayload(job)).toEqual({ format: 'png', data: 'AQID' });
    });

    test('falls back to gifs when no output node has images', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-2' }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    'prompt-2': {
                        status: { status_str: 'success' },
                        outputs: {
                            10: { text: ['some non-media output'] },
                            42: { gifs: [{ filename: 'animation.webp', subfolder: '', type: 'output' }] },
                        },
                    },
                }),
            })
            .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer });

        const job = await runComfy('comfy-gifs-1', 'prompt-2');
        expect(job.status).toBe('awaiting_ack');
        expect(findChunkPayload(job)).toEqual({ format: 'webp', data: 'BAUG' });
    });

    test('reports an error when no output has images or gifs', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, json: async () => ({ prompt_id: 'prompt-3' }) })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    'prompt-3': {
                        status: { status_str: 'success' },
                        outputs: {
                            10: { text: ['no media at all'] },
                        },
                    },
                }),
            });

        const job = await runComfy('comfy-nomedia-1', 'prompt-3');
        const errorEvent = job.events.find(e => e?.data?.kind === 'error');
        expect(errorEvent).toBeDefined();
        expect(errorEvent.data.data.message).toContain('did not return any recognizable outputs');
    });
});
