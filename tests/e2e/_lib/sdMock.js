import http from 'node:http';

export const ONE_PX_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Spawn an in-process Automatic1111-compatible image generation mock.
 * @param {{ txt2imgDelayMs?: number }} [options]
 * @returns {Promise<{ baseURL: string, requests: Array<{url: string, method: string, body: object}>, setTxt2imgDelayMs: (ms: number) => void, stop: () => Promise<void> }>}
 */
export async function startSdWebUiMock({ txt2imgDelayMs = 0 } = {}) {
    const requests = [];
    let txt2imgDelay = txt2imgDelayMs;
    const httpServer = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        let parsed = {};
        try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore non-JSON probes */ }
        requests.push({ url: req.url, method: req.method, body: parsed });

        const respondJson = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        if (req.url === '/sdapi/v1/options' && req.method === 'GET') {
            respondJson(200, { samples_format: 'png', sd_model_checkpoint: 'mock-model' });
            return;
        }
        if (req.url === '/sdapi/v1/sd-models') {
            respondJson(200, [
                { title: 'mock-model [abc]', model_name: 'mock-model', hash: 'abc', sha256: 'def', filename: 'mock-model.safetensors', config: null },
            ]);
            return;
        }
        if (req.url === '/sdapi/v1/samplers') {
            respondJson(200, [{ name: 'DDIM', aliases: [], options: {} }]);
            return;
        }
        if (req.url === '/sdapi/v1/schedulers') {
            respondJson(200, [{ name: 'normal', label: 'Normal' }]);
            return;
        }
        if (req.url === '/sdapi/v1/upscalers') {
            respondJson(200, [{ name: 'Latent' }]);
            return;
        }
        if (req.url === '/sdapi/v1/latent-upscale-modes') {
            respondJson(200, [{ name: 'Latent' }]);
            return;
        }
        if (req.url === '/sdapi/v1/txt2img' && req.method === 'POST') {
            if (txt2imgDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, txt2imgDelay));
            }
            respondJson(200, {
                images: [ONE_PX_PNG_BASE64],
                parameters: parsed,
                info: JSON.stringify({ prompt: parsed.prompt, seed: 42 }),
            });
            return;
        }
        if (req.url === '/sdapi/v1/interrupt' && req.method === 'POST') {
            respondJson(200, {});
            return;
        }
        respondJson(200, {});
    });

    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = httpServer.address().port;
    return {
        baseURL: `http://127.0.0.1:${port}`,
        requests,
        setTxt2imgDelayMs(ms) { txt2imgDelay = Number(ms) || 0; },
        stop: () => new Promise((resolve) => httpServer.close(() => resolve())),
    };
}
