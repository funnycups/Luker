import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { serializeFailure, receiveFailureGraph } from './errors.js';

/** An exclusive kernel listener is released on process death, without stale lock files. */
export class Authority {
    #server;
    #closing;
    #listenerClosed;
    #retiring = false;
    #connections = new Set();
    #requests = new Map();
    #work = new Map();
    errors = [];

    static async open(identity, { port = 0, handle, onError, diagnostic = serializeFailure } = {}) {
        const authority = new Authority();
        authority.identity = { ...identity, control: { host: '127.0.0.1', port } };
        const report = error => { authority.errors.push(error); onError?.(error); };
        const server = net.createServer(socket => {
            const connection = { socket, work: null, closed: new Promise(resolve => socket.once('close', resolve)) };
            authority.#connections.add(connection);
            socket.once('close', () => authority.#connections.delete(connection));
            socket.on('error', error => report(new Error(`Authority connection for ${identity.runId}: ${error.message}`, { cause: error })));
            let source = '';
            socket.setEncoding('utf8');
            socket.on('data', value => {
                source += value;
                if (!source.includes('\n')) return;
                socket.removeAllListeners('data');
                let request;
                const responding = async () => {
                    request = JSON.parse(source.slice(0, source.indexOf('\n')));
                    if (request.runId !== identity.runId || request.executionId !== identity.executionId || typeof request.nonce !== 'string') throw new Error(`Execution authority does not match run ${identity.runId}`);
                    authority.#requests.set(request, connection);
                    const result = request.action === 'identify' ? authority.identity : await handle(request);
                    socket.end(JSON.stringify({ nonce: request.nonce, result }) + '\n');
                };
                connection.work = responding().catch(error => {
                    report(error);
                    if (!socket.destroyed) socket.end(JSON.stringify({ nonce: request?.nonce, error: diagnostic(error) }) + '\n');
                }).finally(() => {
                    authority.#requests.delete(request);
                    authority.#work.delete(connection.work);
                });
                authority.#work.set(connection.work, connection);
            });
        });
        authority.#server = server;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
        });
        server.on('error', report);
        authority.identity.control.port = server.address().port;
        return authority;
    }

    /** Retire admission and drain producers outside the replying release transaction. */
    async quiesce(requests = new Set()) {
        if (!this.#retiring) {
            this.#retiring = true;
            this.#listenerClosed = new Promise((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
            Promise.allSettled([this.#listenerClosed]);
        }
        const replying = new Set([...requests].map(request => this.#requests.get(request)));
        const connections = [...this.#connections].filter(connection => !replying.has(connection));
        for (const connection of connections) {
            if (connection.work) continue;
            connection.socket.removeAllListeners('data');
            connection.socket.end();
        }
        await Promise.all([
            ...[...this.#work].filter(([, connection]) => !replying.has(connection)).map(([work]) => work),
            ...connections.map(connection => connection.closed),
        ]);
    }

    close() {
        if (this.#closing) return this.#closing;
        this.#closing = (async () => { await this.quiesce(); await this.#listenerClosed; })();
        return this.#closing;
    }
}

export function requestAuthority(identity, action, payload) {
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
        const request = JSON.stringify({ runId: identity.runId, executionId: identity.executionId, nonce, action, ...(payload === undefined ? {} : { payload }) }) + '\n';
        const socket = net.connect(identity.control);
        let source = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.once('connect', () => { socket.write(request); });
        socket.on('data', value => { source += value; });
        socket.once('end', () => {
            try {
                const receipt = JSON.parse(source);
                if (receipt.nonce !== nonce) throw new Error(`Execution authority returned a different request identity for run ${identity.runId}`);
                if (receipt.error) {
                    if (receipt.error.type !== 'error') throw new Error(`Authority ${action} for run ${identity.runId} returned an incomplete failure`);
                    const graph = receiveFailureGraph(receipt.error);
                    throw Object.assign(new Error(`Authority ${action} for run ${identity.runId}: ${graph.message}`, { cause: graph }), { code: graph.code });
                }
                resolve(receipt.result);
            } catch (error) { reject(error); }
        });
    });
}
