import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { WebSocketServer } from 'ws';

const fetchMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    readSecret: jest.fn(),
    getRequestedSecretId: jest.fn(),
    SECRET_KEYS: {},
}));

describe('ComfyUI generation', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    /** @type {WebSocketServer} */
    let wsServer;
    let comfyBaseUrl;
    /** @type {string | null} */
    let activePromptId = null;
    /** @type {(requestId: string, owner: string) => any} */
    let getTaskByRequestId;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/stable-diffusion.js');
        ({ getTaskByRequestId } = await import('../src/endpoints/backends/luker-generation.js'));

        wsServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise(resolve => wsServer.once('listening', resolve));
        const wsAddress = wsServer.address();
        comfyBaseUrl = `http://127.0.0.1:${wsAddress.port}`;
        wsServer.on('connection', (socket) => {
            const promptId = activePromptId;
            if (!promptId) return;
            setTimeout(() => {
                if (socket.readyState === socket.OPEN) {
                    socket.send(JSON.stringify({
                        type: 'executing',
                        data: { prompt_id: promptId, node: null },
                    }));
                }
            }, 10);
        });

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
        await new Promise((resolve, reject) => wsServer.close(error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    beforeEach(() => {
        fetchMock.mockReset();
        activePromptId = null;
    });

    /**
     * Drives the real HTTP route, then reads the generation job the dispatch
     * wrote to. Luker's SD routes answer 200 {} immediately and stream the
     * payload through generation-job events, so assertions read the job.
     */
    async function runComfy(jobId, promptId) {
        activePromptId = promptId;

        const response = await fetch(`${baseUrl}/comfy/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: comfyBaseUrl,
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

describe('ComfyUI LoRA catalog', () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;

    beforeAll(async () => {
        const { default: express } = await import('express');
        const { router } = await import('../src/endpoints/stable-diffusion.js');

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
    });

    async function postLoras(url = 'http://127.0.0.1:8188') {
        return fetch(`${baseUrl}/comfy/loras`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });
    }

    test('returns the lora_name options from the upstream object info', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                LoraLoader: {
                    input: { required: { lora_name: [['a.safetensors', 'b.safetensors']] } },
                },
            }),
        });

        const response = await postLoras();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(['a.safetensors', 'b.safetensors']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8188/object_info');
    });

    test('returns an empty list when the LoRA loader node is absent', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ KSampler: { input: { required: {} } } }),
        });

        const response = await postLoras();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([]);
    });

    test('reports a server error for a malformed lora_name option list', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            fetchMock.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    LoraLoader: {
                        input: { required: { lora_name: ['a.safetensors'] } },
                    },
                }),
            });

            const response = await postLoras();
            expect(response.status).toBe(500);
        } finally {
            consoleError.mockRestore();
        }
    });

    test('reports a server error when the upstream request fails', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            fetchMock.mockResolvedValueOnce({ ok: false });

            const response = await postLoras();
            expect(response.status).toBe(500);
        } finally {
            consoleError.mockRestore();
        }
    });
});
