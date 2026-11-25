import net from 'node:net';
import { createHash } from 'node:crypto';

/** Forward real protocol frames unchanged, holding only a world DELETE's COMMIT acknowledgement. */
export async function createDatabaseCommitFault(kind, sourceUrl) {
    const target = new URL(sourceUrl);
    const sockets = new Set();
    const observations = [];
    const errors = [];
    let armed;
    let connectionId = 0;

    const server = net.createServer(client => {
        const id = ++connectionId;
        const upstream = net.createConnection({ host: target.hostname, port: Number(target.port) });
        const state = { id, statements: new Set(), deleted: false, commit: false, prepare: false, startup: true, holding: false, handshake: true, queryAttributes: false };
        for (const socket of [client, upstream]) {
            sockets.add(socket);
            socket.on('error', error => errors.push({ id, code: error.code, message: error.message, faultConnection: armed?.connection === state }));
            socket.on('close', () => { sockets.delete(socket); if (!client.destroyed) client.destroy(); if (!upstream.destroyed) upstream.destroy(); });
        }

        function clientFrame(frame, payload, type) {
            let query;
            if (kind === 'mysql') {
                if (state.handshake) {
                    // CLIENT_QUERY_ATTRIBUTES changes the real COM_QUERY SQL offset.
                    state.queryAttributes = (payload.readUInt32LE(0) & 0x08000000) !== 0;
                    state.handshake = false;
                    observations.push({ id, event: 'negotiated-query-attributes', enabled: state.queryAttributes });
                    upstream.write(frame);
                    return;
                }
                if (payload[0] === 3) query = payload.subarray(state.queryAttributes ? 3 : 1).toString('utf8').trim().toUpperCase();
                if (payload[0] === 22 && /^DELETE FROM worlds\b/i.test(payload.subarray(1).toString('utf8'))) {
                    state.prepare = true;
                    observations.push({ id, event: 'prepare-world-delete' });
                }
                if (payload[0] === 23 && state.statements.has(payload.readUInt32LE(1))) {
                    state.deleted = true;
                    observations.push({ id, event: 'execute-world-delete' });
                }
            } else {
                if (type === 'Q') query = payload.toString('utf8').replace(/\0$/, '').trim().toUpperCase();
                if (type === 'P') {
                    const sql = payload.subarray(payload.indexOf(0) + 1).toString('utf8').split('\0')[0];
                    if (/^DELETE FROM worlds\b/i.test(sql)) {
                        state.deleted = true;
                        observations.push({ id, event: 'execute-world-delete' });
                    }
                }
            }
            if (['BEGIN', 'START TRANSACTION', 'COMMIT', 'ROLLBACK'].includes(query)) observations.push({ id, event: query.toLowerCase() });
            if (query === 'BEGIN' || query === 'START TRANSACTION') { state.commit = false; state.deleted = false; }
            if (query === 'COMMIT') state.commit = true;
            upstream.write(frame);
        }

        function serverFrame(frame, payload, type) {
            if (kind === 'mysql' && state.prepare && payload[0] === 0 && payload.length >= 5) {
                state.statements.add(payload.readUInt32LE(1));
                state.prepare = false;
            }
            const commitAck = kind === 'mysql' ? payload[0] === 0 : type === 'C' && payload.toString('utf8') === 'COMMIT\0';
            if (armed && !armed.connection && state.deleted && state.commit && commitAck) {
                armed.connection = state;
                armed.client = client;
                armed.upstream = upstream;
                state.holding = true;
            }
            if (state.holding) {
                const observation = { id, event: 'held-commit-frame', type: kind === 'mysql' ? 'OK' : type, bytes: frame.length, sha256: createHash('sha256').update(frame).digest('hex') };
                observations.push(observation);
                if (kind === 'mysql' || type === 'Z') armed.resolve({ id, frames: observations.filter(entry => entry.id === id && entry.event === 'held-commit-frame') });
                return;
            }
            client.write(frame);
        }

        function frames(socket, fromClient, consume) {
            let buffered = Buffer.alloc(0);
            socket.on('data', chunk => {
                buffered = Buffer.concat([buffered, chunk]);
                while (buffered.length) {
                    if (kind === 'mysql') {
                        if (buffered.length < 4) return;
                        const length = buffered.readUIntLE(0, 3) + 4;
                        if (buffered.length < length) return;
                        const frame = buffered.subarray(0, length); buffered = buffered.subarray(length);
                        consume(frame, frame.subarray(4));
                    } else {
                        const startup = fromClient && state.startup;
                        if (buffered.length < (startup ? 4 : 5)) return;
                        const length = buffered.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
                        if (buffered.length < length) return;
                        const frame = buffered.subarray(0, length); buffered = buffered.subarray(length);
                        if (startup) { state.startup = false; upstream.write(frame); }
                        else consume(frame, frame.subarray(5), String.fromCharCode(frame[0]));
                    }
                }
            });
        }
        frames(client, true, clientFrame);
        frames(upstream, false, serverFrame);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = new URL(sourceUrl); url.hostname = '127.0.0.1'; url.port = String(server.address().port);
    return {
        url: url.href,
        observations,
        errors,
        arm() {
            let resolve;
            const held = new Promise(done => { resolve = done; });
            armed = { resolve };
            return held;
        },
        async drop() {
            const fault = armed;
            observations.push({ id: fault.connection.id, event: 'drop-held-commit-acknowledgement' });
            await Promise.all([fault.client, fault.upstream].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); })));
        },
        async close() {
            const closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            for (const socket of sockets) socket.destroy();
            await closing;
            const unexpected = errors.filter(error => !error.faultConnection);
            if (unexpected.length) throw new Error(`Database fault proxy had unrelated socket errors: ${JSON.stringify(unexpected)}`);
        },
    };
}
