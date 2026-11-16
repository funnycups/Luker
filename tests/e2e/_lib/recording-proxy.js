// SPDX-License-Identifier: AGPL-3.0-or-later
import http from 'node:http';

/**
 * Start a minimal forward HTTP proxy that records every request it handles.
 * Plain HTTP upstreams arrive in absolute-form (`GET http://host/path`), which
 * is exactly what http-proxy-agent sends. HTTPS upstreams would use CONNECT,
 * which this helper intentionally does not support.
 */
export async function startRecordingProxy() {
    /** @type {Array<{ method: string, url: string }>} */
    const requests = [];
    const directAgent = new http.Agent({ keepAlive: false });

    const server = http.createServer((req, res) => {
        requests.push({ method: String(req.method || ''), url: String(req.url || '') });

        if (req.method === 'CONNECT') {
            res.writeHead(501);
            res.end('CONNECT is not supported by the recording proxy');
            return;
        }

        let destination;
        try {
            destination = new URL(String(req.url));
        } catch {
            res.writeHead(400);
            res.end('Expected an absolute-form proxy request');
            return;
        }

        const upstream = http.request({
            hostname: destination.hostname,
            port: destination.port,
            path: `${destination.pathname}${destination.search}`,
            method: req.method,
            headers: req.headers,
            // The app under test may replace http.globalAgent with a proxy.
            // Forward directly so the recording proxy never loops through it.
            agent: directAgent,
        }, upstreamResponse => {
            res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
            upstreamResponse.pipe(res);
        });

        upstream.on('error', () => {
            res.writeHead(502);
            res.end();
        });

        req.pipe(upstream);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(undefined);
        });
    });

    return {
        baseURL: `http://127.0.0.1:${server.address().port}`,
        requests,
        stop: () => new Promise(resolve => {
            directAgent.destroy();
            server.close(resolve);
        }),
    };
}
