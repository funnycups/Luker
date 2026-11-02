import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ipaddr from 'ipaddr.js';

const exec = promisify(execFile);

// Decode both ordinary labels and compression pointers in real DNS questions.
function readName(packet, offset, visited = new Set()) {
    if (visited.has(offset)) throw new Error('DNS compression loop');
    visited.add(offset);
    const labels = [];
    let cursor = offset;
    while (packet[cursor]) {
        const length = packet[cursor++];
        if ((length & 0xc0) === 0xc0) {
            labels.push(readName(packet, ((length & 0x3f) << 8) | packet[cursor++], visited).name);
            return { name: labels.join('.'), end: cursor };
        }
        labels.push(packet.subarray(cursor, cursor + length).toString('ascii'));
        cursor += length;
    }
    return { name: labels.join('.').toLowerCase(), end: cursor + 1 };
}

export async function startDnsFixture() {
    const socket = dgram.createSocket('udp4');
    const records = new Map();
    const holds = new Map();
    const queries = [];
    socket.on('message', async (packet, peer) => {
        const question = readName(packet, 12);
        const type = packet.readUInt16BE(question.end);
        queries.push({ hostname: question.name, type, id: packet.readUInt16BE(0) });
        const hold = holds.get(question.name);
        if (hold) {
            hold.reach();
            await hold.released;
        }
        const record = records.get(question.name);
        if (record?.dropType === type) return;
        const addresses = type === 1 ? record?.a ?? [] : type === 28 ? record?.aaaa ?? [] : [];
        const code = record?.servfail || record?.servfailType === type ? 2 : record ? 0 : 3;
        const header = Buffer.alloc(12);
        header.writeUInt16BE(packet.readUInt16BE(0), 0);
        header.writeUInt16BE(0x8180 | code, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(code ? 0 : addresses.length, 6);
        const answers = code ? [] : addresses.map(address => {
            const bytes = Buffer.from(ipaddr.parse(address).toByteArray());
            const answer = Buffer.alloc(12);
            answer.writeUInt16BE(0xc00c, 0);
            answer.writeUInt16BE(type, 2);
            answer.writeUInt16BE(1, 4);
            answer.writeUInt16BE(bytes.length, 10);
            return Buffer.concat([answer, bytes]);
        });
        socket.send(Buffer.concat([header, packet.subarray(12, question.end + 4), ...answers]), peer.port, peer.address);
    });
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const resolver = new Resolver({ timeout: 100, tries: 1 });
    resolver.setServers([`127.0.0.1:${socket.address().port}`]);
    async function family(hostname, method, value) {
        try {
            return (await resolver[method](hostname)).map(address => ({ address, family: value }));
        } catch (error) {
            if (error.code === 'ENODATA') return [];
            throw error;
        }
    }
    return {
        serverAddress: `127.0.0.1:${socket.address().port}`,
        resolveAll: async hostname => (await Promise.all([family(hostname, 'resolve4', 4), family(hostname, 'resolve6', 6)])).flat(),
        setAnswers: (hostname, answers) => records.set(hostname, answers),
        holdNext(hostname) {
            let reach;
            let release;
            const reached = new Promise(resolve => { reach = resolve; });
            const released = new Promise(resolve => { release = resolve; });
            holds.set(hostname, { reach, released });
            return { reached, release: () => { holds.delete(hostname); release(); } };
        },
        queries,
        close: () => new Promise(resolve => { resolver.cancel(); socket.close(resolve); }),
    };
}

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
    });
}

export async function startHttpFixture(handler = (_req, res) => res.end('ok')) {
    const hits = [];
    const connections = [];
    const server = http.createServer((req, res) => { hits.push({ url: req.url, host: req.headers.host }); handler(req, res); });
    server.on('connection', socket => connections.push(socket.remoteAddress));
    const port = await listen(server);
    return { url: `http://127.0.0.1:${port}`, hits, connections, close: () => closeServer(server) };
}

export async function startTlsFixture({ dnsSans = [], ipSans = [], handler }) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'luker-sync-tls-'));
    try {
        await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Sync Test CA'], { cwd: dir });
        await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=sync.test'], { cwd: dir });
        await fs.writeFile(path.join(dir, 'extensions'), `subjectAltName=${[...dnsSans.map(name => `DNS:${name}`), ...ipSans.map(ip => `IP:${ip}`)].join(',')}\nextendedKeyUsage=serverAuth\n`);
        await exec('openssl', ['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '1', '-extfile', 'extensions'], { cwd: dir });
        const [key, cert, caPem] = await Promise.all(['server.key', 'server.pem', 'ca.pem'].map(name => fs.readFile(path.join(dir, name))));
        const hits = [];
        const sniNames = [];
        const server = https.createServer({ key, cert }, (req, res) => { hits.push(handler ? { host: req.headers.host, url: req.url } : { host: req.headers.host }); if (handler) handler(req, res); else res.end('secure'); });
        server.on('secureConnection', socket => sniNames.push(socket.servername));
        const port = await listen(server);
        return { port, caPem, hits, sniNames, close: async () => { await closeServer(server); await fs.rm(dir, { recursive: true, force: true }); } };
    } catch (error) {
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
    }
}
