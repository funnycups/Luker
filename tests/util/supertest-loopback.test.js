import http from 'node:http';
import express from 'express';
import request from 'supertest';

// supertest's stock behavior listens on the wildcard address and then
// connects to 127.0.0.1. On macOS a wildcard bind can take a port another
// process already holds on 127.0.0.1, so the request reaches that process.
// The jest moduleNameMapper routes `supertest` through a loopback-binding
// wrapper; these tests pin that contract.
function probeApp(seen) {
    const app = express();
    app.get('/probe', (req, res) => {
        seen.push(req.socket.server);
        res.json({ bound: req.socket.server.address().address });
    });
    return app;
}

describe('supertest loopback binding', () => {
    test('request(app) binds the ephemeral server to 127.0.0.1 and closes it', async () => {
        const seen = [];
        const res = await request(probeApp(seen)).get('/probe').expect(200);
        expect(res.body.bound).toBe('127.0.0.1');
        expect(seen[0].listening).toBe(false);
    });

    test('request(server) with an unlistened http.Server binds to 127.0.0.1', async () => {
        const seen = [];
        const server = http.createServer(probeApp(seen));
        const res = await request(server).get('/probe');
        expect(res.status).toBe(200);
        expect(res.body.bound).toBe('127.0.0.1');
        expect(server.listening).toBe(false);
    });

    test('request.agent(app) binds each request to 127.0.0.1', async () => {
        const seen = [];
        const agent = request.agent(probeApp(seen));
        const first = await agent.get('/probe');
        const second = await agent.get('/probe');
        expect(first.body.bound).toBe('127.0.0.1');
        expect(second.body.bound).toBe('127.0.0.1');
        expect(seen.every(s => !s.listening)).toBe(true);
    });

    test('concurrent requests through one agent share the server and close it after the last', async () => {
        const seen = [];
        const agent = request.agent(probeApp(seen));
        const responses = await Promise.all([agent.get('/probe'), agent.get('/probe'), agent.get('/probe')]);
        expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
        expect(new Set(seen).size).toBe(1);
        expect(seen[0].listening).toBe(false);
    });

    test('callback-style .expect(status, fn) still resolves', async () => {
        const seen = [];
        await new Promise((resolve, reject) => {
            request(probeApp(seen)).get('/probe').expect(200, (err) => (err ? reject(err) : resolve()));
        });
        expect(seen).toHaveLength(1);
    });

    test('a server the caller already listens on is used as-is', async () => {
        const seen = [];
        const server = http.createServer(probeApp(seen));
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        try {
            const res = await request(server).get('/probe');
            expect(res.body.bound).toBe('127.0.0.1');
            expect(server.listening).toBe(true);
        } finally {
            await new Promise(r => server.close(r));
        }
    });
});
