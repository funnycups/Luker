// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lightweight CDP Network + Fetch observation and response-hold helper for E2E
// tests. Inspects real browser requests/responses and holds/releases HTTP
// delivery without touching Debugger domains or application internals.

function normalizeHeaderMap(headers) {
    if (!headers) return {};
    if (Array.isArray(headers)) {
        const out = {};
        for (const entry of headers) {
            if (entry && typeof entry.name === 'string') {
                out[entry.name.toLowerCase()] = entry.value;
            }
        }
        return out;
    }
    if (typeof headers === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(headers)) {
            out[k.toLowerCase()] = v;
        }
        return out;
    }
    return {};
}

class NetworkObserver {
    constructor(options) {
        this.page = options.page;
        this.context = options.context ?? options.page.context();
        this.scope = options.scope;
        this.patterns = Array.isArray(options.patterns) ? options.patterns.slice() : [];
        this.networkFilter = typeof options.networkFilter === 'function' ? options.networkFilter : null;
        this.readStored = typeof options.readStored === 'function' ? options.readStored : null;
        this.recordBodies = Boolean(options.recordBodies);
        this.onFetchPaused = typeof options.onFetchPaused === 'function' ? options.onFetchPaused : null;

        this.network = new Map();
        this.fetch = new Map();
        this.holds = new Map();
        this.rules = [];
        this.jobs = new Set();
        this.waiters = new Set();
        this.errors = [];

        this.cdp = null;
        this.started = false;
        this.fetchClosing = false;
        this.closed = false;
        this.closePromise = null;
    }

    ensureNetworkRow(networkId) {
        let row = this.network.get(networkId);
        if (!row) {
            row = {
                networkId,
                fetchIds: [],
                request: null,
                response: null,
                finished: null,
                failed: null,
                responseBody: null,
                storedBefore: null,
                storedAtResponse: null,
            };
            this.network.set(networkId, row);
        }
        return row;
    }

    notify() {
        for (const waiter of [...this.waiters]) {
            if (this.errors.length && !waiter.allowErrors) {
                this.waiters.delete(waiter);
                waiter.reject(this.errors[0]);
                continue;
            }
            const value = waiter.predicate();
            if (value) {
                this.waiters.delete(waiter);
                waiter.resolve(value);
            }
        }
    }

    wait(predicate, { allowErrors = false } = {}) {
        if (this.errors.length && !allowErrors) return Promise.reject(this.errors[0]);
        const value = predicate();
        if (value) return Promise.resolve(value);
        if (this.closed) return Promise.reject(new Error('Network observer is already closed'));
        return new Promise((resolve, reject) => {
            this.waiters.add({ predicate, resolve, reject, allowErrors });
        });
    }

    job(work) {
        const task = Promise.resolve().then(work).catch(error => {
            this.errors.push(error);
        }).finally(() => {
            this.jobs.delete(task);
            this.notify();
        });
        this.jobs.add(task);
        return task;
    }

    async #handleFetchPaused(event) {
        const isResponse = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
        const stage = isResponse ? 'Response' : 'Request';
        const stored = this.readStored ? this.readStored() : null;
        const row = this.ensureNetworkRow(event.networkId);
        if (!row.fetchIds.includes(event.requestId)) row.fetchIds.push(event.requestId);
        if (!isResponse && stored !== null) row.storedBefore = stored;
        if (isResponse && stored !== null) row.storedAtResponse = stored;

        const matchesFilter = !this.networkFilter || this.networkFilter({ request: event.request });
        if (matchesFilter) {
            await this.wait(() => this.network.get(event.networkId)?.request, { allowErrors: true });
        }

        if (isResponse && this.recordBodies && !event.responseErrorReason) {
            const body = await this.cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            const decoded = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body);
            row.responseBody = decoded.toString('utf8');
        }

        if (this.onFetchPaused) {
            const handled = await this.onFetchPaused({ event, response: isResponse, stage, row, stored });
            if (handled === true) return;
        }

        const rule = this.rules.find(candidate => !candidate.used && candidate.predicate({
            event,
            response: isResponse,
            stage,
            row,
            network: row.request,
            stored,
        }));
        if (rule) {
            rule.used = !rule.repeat;
            const pausedRecord = {
                ...event,
                fetchId: event.requestId,
                networkId: event.networkId,
                stage,
                stored,
                ruleName: rule.name,
            };
            rule.event = pausedRecord;
            rule.events.push(pausedRecord);
            this.holds.set(event.requestId, pausedRecord);
            this.notify();
            return;
        }

        await this.continueFetch(event);
    }

    async start() {
        if (this.started) return this;
        this.started = true;
        this.cdp = await this.context.newCDPSession(this.page);

        this.cdp.on('Network.requestWillBeSent', (event) => {
            if (this.networkFilter && !this.networkFilter(event)) return;
            const row = this.ensureNetworkRow(event.requestId);
            row.request = event;
            this.notify();
        });
        this.cdp.on('Network.responseReceived', (event) => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.response = event;
            this.notify();
        });
        this.cdp.on('Network.loadingFinished', (event) => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.finished = event;
            this.notify();
        });
        this.cdp.on('Network.loadingFailed', (event) => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.failed = event;
            this.notify();
        });
        this.cdp.on('Fetch.requestPaused', (event) => {
            this.fetch.set(event.requestId, event);
            if (this.fetchClosing) return;
            this.job(() => this.#handleFetchPaused(event));
        });

        await this.cdp.send('Network.enable');
        if (this.patterns.length) {
            await this.cdp.send('Fetch.enable', { patterns: this.patterns });
        }

        await this.scope.onFinalize({
            label: 'close network observer',
            stage: 'drain',
            callback: () => this.close(),
        });
        return this;
    }

    hold(name, predicate, { repeat = false } = {}) {
        const rule = { name, predicate, used: false, repeat, event: null, events: [] };
        this.rules.push(rule);
        return {
            paused: () => this.wait(() => rule.event),
            rule,
        };
    }

    async continueFetch(event, { failReason = null } = {}) {
        const fetchId = typeof event === 'string' ? event : (event.fetchId ?? event.requestId);
        const raw = this.fetch.get(fetchId) || event;
        const isResponse = raw?.responseStatusCode !== undefined || raw?.responseErrorReason !== undefined || raw?.stage === 'Response';
        if (failReason) {
            await this.cdp.send('Fetch.failRequest', { requestId: fetchId, errorReason: failReason });
        } else {
            await this.cdp.send(isResponse ? 'Fetch.continueResponse' : 'Fetch.continueRequest', { requestId: fetchId });
        }
        this.fetch.delete(fetchId);
        this.holds.delete(fetchId);
    }

    async release(pausedEvent, { failReason = null, cleanup = false } = {}) {
        const fetchId = typeof pausedEvent === 'string' ? pausedEvent : (pausedEvent.fetchId ?? pausedEvent.requestId);
        const networkId = typeof pausedEvent === 'string' ? this.fetch.get(fetchId)?.networkId : pausedEvent.networkId;
        await this.continueFetch(pausedEvent, { failReason });
        if (!networkId) return { fetchId, networkId: null, finished: true, failed: Boolean(failReason) };
        const tracked = this.network.get(networkId);
        if (!tracked?.request) return { fetchId, networkId, finished: true, failed: Boolean(failReason) };

        const row = await this.wait(() => {
            const candidate = this.network.get(networkId);
            return candidate?.finished || candidate?.failed ? candidate : false;
        }, { allowErrors: cleanup });
        if (row.failed && !failReason && !cleanup) {
            throw new Error(`Released request ${networkId} failed: ${JSON.stringify(row.failed)}`);
        }
        return {
            networkId,
            fetchId,
            status: row.response?.response?.status ?? null,
            finished: Boolean(row.finished),
            failed: Boolean(row.failed),
        };
    }

    getNetworkRecord(networkId) {
        const row = this.network.get(networkId);
        if (!row) return null;
        return {
            networkId: row.networkId,
            fetchIds: row.fetchIds.slice(),
            url: row.request?.request?.url ?? null,
            method: row.request?.request?.method ?? null,
            headers: normalizeHeaderMap(row.request?.request?.headers),
            postData: row.request?.request?.postData ?? null,
            initiator: row.request?.initiator ?? null,
            status: row.response?.response?.status ?? null,
            responseHeaders: normalizeHeaderMap(row.response?.response?.headers),
            responseBody: row.responseBody,
            storedBefore: row.storedBefore,
            storedAtResponse: row.storedAtResponse,
            finished: Boolean(row.finished),
            failed: Boolean(row.failed),
        };
    }

    getNetworkRecords() {
        return [...this.network.keys()].map(id => this.getNetworkRecord(id));
    }

    close() {
        this.closePromise ??= this.#finish();
        return this.closePromise;
    }

    async #finish() {
        this.rules = [];
        const cleanupErrors = [];
        try {
            if (!this.page.isClosed()) {
                for (const event of [...this.holds.values()]) {
                    await this.release(event, { cleanup: true }).catch(err => cleanupErrors.push(err));
                }
                while (this.jobs.size) {
                    await Promise.all([...this.jobs]);
                }
                for (const event of [...this.fetch.values()]) {
                    await this.continueFetch(event).catch(err => cleanupErrors.push(err));
                }
            }
        } finally {
            if (this.cdp) {
                this.fetchClosing = true;
                if (this.patterns.length) {
                    await this.cdp.send('Fetch.disable').catch(() => {});
                }
                this.fetch.clear();
                await this.cdp.send('Network.disable').catch(() => {});
                await this.cdp.detach().catch(() => {});
                this.cdp.removeAllListeners();
            }
            this.closed = true;
            for (const waiter of this.waiters) {
                waiter.reject(new Error('Network observer closed before condition was satisfied'));
            }
            this.waiters.clear();
        }
        if (this.errors.length || cleanupErrors.length) {
            throw new AggregateError([...this.errors, ...cleanupErrors], 'Network observer closure failed');
        }
    }
}

export async function observeOperations(options = {}) {
    if (!options.page || typeof options.page.context !== 'function') {
        throw new TypeError('observeOperations requires a Playwright page');
    }
    if (!options.scope || typeof options.scope.onFinalize !== 'function') {
        throw new TypeError('observeOperations requires a managed resource scope');
    }
    const observer = new NetworkObserver(options);
    await observer.start();
    return observer;
}
