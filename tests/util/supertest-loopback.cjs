'use strict';

// Jest maps the bare `supertest` specifier here (see jest.config.json).
//
// Stock supertest calls `server.listen(0)`, which binds the wildcard address,
// then connects to 127.0.0.1. macOS lets a wildcard bind take a port another
// process already holds on 127.0.0.1, so the request reaches that process and
// fails with `socket hang up` or a foreign response. This wrapper binds the
// ephemeral server to 127.0.0.1 instead. A loopback listen resolves its host
// asynchronously, so `end()` waits for `listening` before sending.

const path = require('node:path');
const { Server: TlsServer } = require('node:tls');

const supertestDir = path.join(__dirname, '..', 'node_modules', 'supertest');
const supertest = require(supertestDir);
const Test = require(path.join(supertestDir, 'lib', 'test.js'));

const LOOPBACK = '127.0.0.1';
const originalServerAddress = Test.prototype.serverAddress;
const originalEnd = Test.prototype.end;
// Ephemeral servers this wrapper listened on, keyed to their listen promise
// and in-flight request count. Concurrent requests through one agent share
// the server; the last one to finish closes it.
const ephemeral = new WeakMap();

function acquire(server) {
    let state = ephemeral.get(server);
    if (!state) {
        state = { inflight: 0 };
        state.listening = new Promise((resolve, reject) => {
            const onError = (err) => {
                ephemeral.delete(server);
                reject(err);
            };
            server.once('error', onError);
            server.listen(0, LOOPBACK, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        ephemeral.set(server, state);
    }
    state.inflight += 1;
    return state;
}

function release(server, done) {
    const state = ephemeral.get(server);
    state.inflight -= 1;
    if (state.inflight > 0) return done();
    ephemeral.delete(server);
    server.close(() => done());
}

function loopbackUrl(server, port, urlPath) {
    const protocol = server instanceof TlsServer ? 'https' : 'http';
    return `${protocol}://${LOOPBACK}:${port}${urlPath}`;
}

Test.prototype.serverAddress = function serverAddress(app, urlPath) {
    if (app.address() && !ephemeral.has(app)) return originalServerAddress.call(this, app, urlPath);
    this._loopback = { state: acquire(app), urlPath };
    // Port 0 placeholder until the listen resolves; agents parse this URL
    // for cookie matching at construction, which ignores the port.
    return loopbackUrl(app, 0, urlPath);
};

Test.prototype.end = function end(fn) {
    const loopback = this._loopback;
    if (!loopback) return originalEnd.call(this, fn);
    this._loopback = null;
    const server = this.app;
    const callback = typeof fn === 'function' ? fn : () => {};
    loopback.state.listening.then(
        () => {
            this.url = loopbackUrl(server, server.address().port, loopback.urlPath);
            originalEnd.call(this, (err, res) => release(server, () => callback(err, res)));
        },
        (err) => {
            loopback.state.inflight -= 1;
            callback(err);
        },
    );
    return this;
};

module.exports = supertest;
