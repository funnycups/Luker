// In-process ComfyUI-compatible image generation mock: the HTTP surface the
// dispatch calls plus the /ws progress channel it waits on. The mock records
// the parsed body of every /prompt request so specs can assert the exact
// graph that reached the backend.

import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ONE_PX_PNG_BASE64 } from './sdMock.js';

/**
 * @param {{ loraNames?: string[] }} [options]
 * @returns {Promise<{
 *   baseURL: string,
 *   requests: Array<object>,
 *   setLoras: (names: string[]) => void,
 *   stop: () => Promise<void>,
 * }>}
 */
export async function startComfyMock({ loraNames = [] } = {}) {
    /** Parsed /prompt bodies, in arrival order. */
    const requests = [];
    /** Uploaded files from POST /upload/image, in arrival order. */
    const uploads = [];
    let loras = [...loraNames];
    let lastPromptId = '';
    let promptCounter = 0;
    const pngBuffer = Buffer.from(ONE_PX_PNG_BASE64, 'base64');

    const objectInfo = () => ({
        KSampler: {
            input: {
                required: {
                    sampler_name: [['euler'], {}],
                    scheduler: [['normal'], {}],
                },
            },
        },
        CheckpointLoaderSimple: {
            input: {
                required: {
                    ckpt_name: [['mock-model.safetensors'], {}],
                },
            },
        },
        UNETLoader: {
            input: {
                required: {
                    unet_name: [['mock-unet.safetensors'], {}],
                },
            },
        },
        VAELoader: {
            input: {
                required: {
                    vae_name: [['mock-vae.safetensors'], {}],
                },
            },
        },
        LoadImage: {
            input: {
                required: {
                    image: [['example.png'], {}],
                },
            },
        },
        LoraLoader: {
            input: {
                required: {
                    lora_name: [[...loras], {}],
                    strength_model: ['FLOAT', {}],
                    strength_clip: ['FLOAT', {}],
                },
            },
        },
    });

    const executingFrame = promptId => JSON.stringify({
        type: 'executing',
        data: { prompt_id: promptId, node: null },
    });

    const wsServer = new WebSocketServer({ noServer: true });

    const broadcastExecuting = promptId => {
        for (const socket of wsServer.clients) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(executingFrame(promptId));
            }
        }
    };

    // The dispatch POSTs /prompt before it opens the progress socket, so a
    // connection that lands after the request still has to learn the id.
    wsServer.on('connection', socket => {
        if (lastPromptId) {
            socket.send(executingFrame(lastPromptId));
        }
    });

    const httpServer = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const rawBuffer = Buffer.concat(chunks);
        const raw = rawBuffer.toString('utf8');
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;

        const respondJson = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        if (pathname === '/system_stats' && req.method === 'GET') {
            respondJson(200, { system: { os: 'mock' } });
            return;
        }
        if (pathname === '/object_info' && req.method === 'GET') {
            respondJson(200, objectInfo());
            return;
        }
        if (pathname === '/upload/image' && req.method === 'POST') {
            const filenameMatch = /filename="([^"]+)"/.exec(rawBuffer.toString('latin1'));
            const originalFilename = filenameMatch ? filenameMatch[1] : `ref_${uploads.length + 1}.png`;
            const returnedName = `uploaded_${uploads.length + 1}_${originalFilename}`;
            uploads.push({
                originalFilename,
                returnedName,
                size: rawBuffer.length,
                contentType: String(req.headers['content-type'] || ''),
            });
            respondJson(200, {
                name: returnedName,
                subfolder: '',
                type: 'input',
            });
            return;
        }
        if (pathname === '/prompt' && req.method === 'POST') {
            const body = raw ? JSON.parse(raw) : {};
            requests.push(body);
            lastPromptId = `mock-prompt-${++promptCounter}`;
            respondJson(200, { prompt_id: lastPromptId });
            broadcastExecuting(lastPromptId);
            return;
        }
        if (pathname.startsWith('/history/') && req.method === 'GET') {
            const promptId = decodeURIComponent(pathname.slice('/history/'.length));
            respondJson(200, {
                [promptId]: {
                    outputs: {
                        9: { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] },
                    },
                },
            });
            return;
        }
        if (pathname === '/view' && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(pngBuffer);
            return;
        }
        if (pathname === '/interrupt' && req.method === 'POST') {
            respondJson(200, {});
            return;
        }
        respondJson(404, {});
    });

    httpServer.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (pathname !== '/ws') {
            socket.destroy();
            return;
        }
        wsServer.handleUpgrade(req, socket, head, ws => {
            wsServer.emit('connection', ws, req);
        });
    });

    await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;

    return {
        baseURL: `http://127.0.0.1:${port}`,
        requests,
        uploads,
        setLoras(names) {
            loras = [...names];
        },
        stop: () => new Promise(resolve => {
            for (const socket of wsServer.clients) {
                socket.terminate();
            }
            wsServer.close(() => {
                httpServer.closeAllConnections?.();
                httpServer.close(() => resolve());
            });
        }),
    };
}
