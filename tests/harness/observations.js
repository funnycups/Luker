// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared causal operation & CDP network observation adapter.
//
// Records declared consumer invocations, real CDP Network.requestId /
// Fetch.requestId lifecycles, optional read-only Debugger logpoints & remote
// object identities, and delivery holds. Never guesses causal ownership from
// request body equality or arrival order; unattributed traffic is explicitly
// recorded in `evidenceGaps`.

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const DEFAULT_MARKER_PREFIX = '[luker-operation] ';
const DEFAULT_NATIVE_MARKER = 'luker-operation-native';

export class ObservationEvidenceGapError extends Error {
    constructor(message, { invocationId = null, evidenceGaps = [], networkRecords = [] } = {}) {
        super(message);
        this.name = 'ObservationEvidenceGapError';
        this.code = 'OBSERVATION_EVIDENCE_GAP';
        this.invocationId = invocationId;
        this.evidenceGaps = evidenceGaps;
        this.networkRecords = networkRecords;
    }
}

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

function getHeaderCaseInsensitive(headers, name) {
    if (!name) return null;
    const target = name.toLowerCase();
    if (Array.isArray(headers)) {
        const found = headers.find(h => typeof h?.name === 'string' && h.name.toLowerCase() === target);
        return found ? found.value : null;
    }
    if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
            if (k.toLowerCase() === target) return v;
        }
    }
    return null;
}

function requireObserverInputs({ page, scope }) {
    if (!page || typeof page.context !== 'function' || typeof page.on !== 'function') {
        throw new TypeError('observeOperations requires a Playwright page');
    }
    if (!scope || typeof scope.onFinalize !== 'function') {
        throw new TypeError('observeOperations requires a managed resource scope');
    }
}

class OperationObserver {
    constructor(options) {
        this.page = options.page;
        this.context = options.context ?? options.page.context();
        this.scope = options.scope;
        this.baseURL = options.baseURL ?? null;
        this.patterns = Array.isArray(options.patterns) ? options.patterns.slice() : [];
        this.networkFilter = typeof options.networkFilter === 'function' ? options.networkFilter : null;
        this.readStored = typeof options.readStored === 'function' ? options.readStored : null;
        this.recordBodies = Boolean(options.recordBodies);
        this.receiptHeader = options.receiptHeader ? String(options.receiptHeader).toLowerCase() : null;
        this.markerPrefix = options.markerPrefix ?? DEFAULT_MARKER_PREFIX;
        this.nativeMarker = options.nativeMarker ?? DEFAULT_NATIVE_MARKER;
        this.diagnosticName = options.diagnosticName ?? `operation-observations-${randomUUID().slice(0, 8)}.json`;
        this.artifactDir = options.artifactDir ?? null;
        this.enableDebugger = options.enableDebugger !== false;
        this.onNativePacket = typeof options.onNativePacket === 'function' ? options.onNativePacket : null;
        this.onFetchPaused = typeof options.onFetchPaused === 'function' ? options.onFetchPaused : null;
        this.onInvocationEvent = typeof options.onInvocationEvent === 'function' ? options.onInvocationEvent : null;
        this.beforeClose = typeof options.beforeClose === 'function' ? options.beforeClose : null;
        this.afterClose = typeof options.afterClose === 'function' ? options.afterClose : null;

        if (this.artifactDir) {
            mkdirSync(resolve(this.artifactDir, 'bodies'), { recursive: true });
        }

        this.serial = 0;
        this.events = [];
        this.ledger = [];
        this.errors = [];
        this.evidenceGaps = [];
        this.recordedGapKeys = new Set();
        this.jobs = new Set();
        this.waiters = new Set();

        this.network = new Map();
        this.fetch = new Map();
        this.holds = new Map();
        this.rules = [];

        this.invocations = new Map();
        this.nativeSends = [];
        this.nativeReplies = [];
        this.httpReceipts = new Map();

        this.scripts = new Map();
        this.validatedScripts = new Set();
        this.points = new Map();
        this.breakpoints = new Map();
        this.remoteHandles = new Set();
        this.objects = [];
        this.identityGroups = new Map();
        this.captureQueue = Promise.resolve();

        this.cdp = null;
        this.started = false;
        this.fetchClosing = false;
        this.closed = false;
        this.closePromise = null;
        this.diagnosticRef = null;
    }

    storeBody(value, type = 'application/json') {
        if (!this.artifactDir) return value;
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(type === 'application/json' ? JSON.stringify(value) : String(value));
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const name = `bodies/${sha256}`;
        writeFileSync(resolve(this.artifactDir, name), bytes);
        return { sha256, bytes: bytes.length, type, path: name };
    }

    record(kind, data) {
        const event = { sequence: ++this.serial, kind, observedAt: new Date().toISOString(), data };
        this.events.push(event);
        if (this.artifactDir) {
            const row = { ...event, data: this.storeBody(data) };
            this.ledger.push(row);
            appendFileSync(resolve(this.artifactDir, 'events.jsonl'), JSON.stringify(row) + '\n');
        }
        this.notify();
        return event;
    }

    recordGap(gap) {
        const key = `${gap.kind}:${gap.networkId ?? ''}:${gap.invocationId ?? ''}:${gap.reason ?? ''}`;
        if (this.recordedGapKeys.has(key)) return;
        this.recordedGapKeys.add(key);
        const entry = { observedAt: new Date().toISOString(), ...gap };
        this.evidenceGaps.push(entry);
        this.record('evidence-gap', entry);
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
        if (this.closed) return Promise.reject(new Error('Operation observer is already closed'));
        return new Promise((resolvePromise, rejectPromise) => {
            this.waiters.add({ predicate, resolve: resolvePromise, reject: rejectPromise, allowErrors });
        });
    }

    job(work) {
        const task = Promise.resolve().then(work).catch(error => {
            this.errors.push(error);
            this.record('observer-error', { message: error.message, stack: error.stack });
        }).finally(() => {
            this.jobs.delete(task);
            this.notify();
        });
        this.jobs.add(task);
        return task;
    }

    async capturesSettled() {
        while (this.jobs.size) {
            await Promise.all([...this.jobs]);
        }
        await this.captureQueue;
        if (this.errors.length) {
            throw new AggregateError(this.errors, 'Operation observer encountered capture errors');
        }
    }

    async readRemoteProperties(objectId) {
        this.remoteHandles.add(objectId);
        const result = await this.cdp.send('Runtime.getProperties', { objectId, ownProperties: true });
        if (result.exceptionDetails) {
            throw new Error(`Native observation packet read failed: ${JSON.stringify(result.exceptionDetails)}`);
        }
        for (const property of result.result) {
            if (property.value?.objectId) this.remoteHandles.add(property.value.objectId);
        }
        return Object.fromEntries(result.result.map(property => [property.name, property.value]));
    }

    async resolveRemoteIdentity(remote, group) {
        if (!remote?.objectId) return null;
        this.remoteHandles.add(remote.objectId);
        const objects = this.identityGroups.get(group) || [];
        this.identityGroups.set(group, objects);
        for (const object of objects) {
            const equal = await this.cdp.send('Runtime.callFunctionOn', {
                objectId: remote.objectId,
                functionDeclaration: 'function(other) { return this === other; }',
                arguments: [{ objectId: object.remote }],
                returnByValue: true,
                throwOnSideEffect: true,
            });
            if (equal.exceptionDetails) {
                throw new Error(`Native identity comparison failed: ${JSON.stringify(equal.exceptionDetails)}`);
            }
            this.record('native-identity-comparison', { group, left: remote.objectId, right: object.remote, result: equal });
            if (equal.result.value) return object.id;
        }
        const object = { id: `object-${this.objects.length + 1}`, remote: remote.objectId, group };
        this.objects.push(object);
        objects.push(object);
        return object.id;
    }

    buildLogpointCondition(point) {
        const identities = Object.entries(point.identities || {})
            .map(([name, expression]) => `${JSON.stringify(name)}:(${expression})`)
            .join(',');
        return `(() => { try { if (${point.guard || 'true'}) console.dir(Object.freeze({marker:${JSON.stringify(this.nativeMarker)},point:${JSON.stringify(point.key)},snapshot:JSON.stringify({at:performance.now(),...(${point.expression})}),references:Object.freeze({${identities}})})); } catch(error) { console.dir(Object.freeze({marker:${JSON.stringify(this.nativeMarker)},point:${JSON.stringify(point.key)},error:String(error),stack:error.stack})); } return false; })()`;
    }

    async validateScriptSource(script, repoRelativePath) {
        if (this.validatedScripts.has(script.scriptId)) return;
        const expected = readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');
        const actual = await this.cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
        if (actual.scriptSource !== expected) {
            throw new Error(`Loaded script differs from frozen source: ${repoRelativePath} / ${script.scriptId}`);
        }
        this.validatedScripts.add(script.scriptId);
        this.record('source-validated', {
            path: repoRelativePath,
            scriptId: script.scriptId,
            sha256: createHash('sha256').update(expected).digest('hex'),
        });
    }

    async addLogpoint(repoRelativePath, needle, label, expression, identities = {}, scopeNeedle = null, condition = '') {
        if (!this.baseURL) throw new Error('addLogpoint requires baseURL');
        const source = readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');
        const start = scopeNeedle ? source.indexOf(scopeNeedle) : 0;
        if (start < 0) throw new Error(`Missing debugger scope ${repoRelativePath}: ${scopeNeedle}`);
        const end = scopeNeedle ? source.indexOf('\n}', start) : source.length;
        const region = source.slice(start, end);
        const relative = region.indexOf(needle);
        if (relative < 0 || region.indexOf(needle, relative + needle.length) >= 0) {
            throw new Error(`Non-unique debugger anchor ${repoRelativePath}: ${needle}`);
        }
        const index = start + relative;
        const prefix = source.slice(0, index);
        const lineNumber = prefix.split('\n').length - 1;
        const columnNumber = prefix.length - prefix.lastIndexOf('\n') - 1;
        const url = this.baseURL + '/' + repoRelativePath.replace(/^public\//, '');
        const urlRegex = '^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\?.*)?$';
        const point = {
            key: `point-${this.points.size + 1}`,
            path: repoRelativePath,
            needle,
            label,
            expression,
            identities,
            lineNumber,
            columnNumber,
            guard: condition,
            removed: false,
        };
        this.points.set(point.key, point);
        for (const script of this.scripts.values()) {
            if (script.url.split('?')[0] === url) await this.validateScriptSource(script, repoRelativePath);
        }
        const nativeCondition = this.buildLogpointCondition(point);
        const result = await this.cdp.send('Debugger.setBreakpointByUrl', {
            urlRegex,
            lineNumber,
            columnNumber,
            condition: nativeCondition,
        });
        this.breakpoints.set(result.breakpointId, point);
        this.record('native-logpoint', {
            breakpointId: result.breakpointId,
            path: repoRelativePath,
            label,
            lineNumber,
            columnNumber,
            condition: nativeCondition,
            locations: result.locations,
        });
        return result;
    }

    async addReturnLogpoints(repoRelativePath, startNeedle, endNeedle, label, expression, identities = {}) {
        if (!this.baseURL) throw new Error('addReturnLogpoints requires baseURL');
        const source = readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');
        const startIndex = source.indexOf(startNeedle);
        const endIndex = source.indexOf(endNeedle, startIndex);
        if (startIndex < 0 || endIndex < 0) {
            throw new Error(`Missing function return boundary ${repoRelativePath}: ${startNeedle}`);
        }
        const lineNumber = source.slice(0, source.indexOf('\n', startIndex) + 1).split('\n').length - 1;
        const endLine = source.slice(0, endIndex).split('\n').length - 1;
        const url = this.baseURL + '/' + repoRelativePath.replace(/^public\//, '');
        const scripts = [...this.scripts.values()].filter(script => script.url.split('?')[0] === url);
        if (!scripts.length) throw new Error(`No loaded script for return observation: ${url}`);
        for (const script of scripts) {
            const actual = await this.cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
            const sourceHash = createHash('sha256').update(actual.scriptSource).digest('hex');
            if (actual.scriptSource !== source) {
                throw new Error(`Loaded script differs from frozen source: ${url} ${script.scriptId} ${sourceHash}`);
            }
            const possible = await this.cdp.send('Debugger.getPossibleBreakpoints', {
                start: { scriptId: script.scriptId, lineNumber, columnNumber: 0 },
                end: { scriptId: script.scriptId, lineNumber: endLine, columnNumber: 0 },
                restrictToFunction: true,
            });
            const returns = possible.locations.filter(location => location.type === 'return');
            if (!returns.length) throw new Error(`No actual return locations for ${url}: ${startNeedle}`);
            for (const location of returns) {
                const point = {
                    key: `point-${this.points.size + 1}`,
                    path: repoRelativePath,
                    label,
                    expression,
                    identities,
                    lineNumber: location.lineNumber,
                    columnNumber: location.columnNumber,
                    removed: false,
                };
                this.points.set(point.key, point);
                const condition = this.buildLogpointCondition(point);
                const breakpoint = await this.cdp.send('Debugger.setBreakpoint', { location, condition });
                this.breakpoints.set(breakpoint.breakpointId, point);
                this.record('native-return-logpoint', {
                    path: repoRelativePath,
                    label,
                    breakpoint,
                    location,
                    scriptId: script.scriptId,
                    sourceHash,
                    condition,
                });
            }
        }
    }

    async removeLogpoints(predicate) {
        for (const [breakpointId, point] of this.breakpoints) {
            if (point.removed || !predicate(point)) continue;
            await this.cdp.send('Debugger.removeBreakpoint', { breakpointId });
            point.removed = true;
            this.record('breakpoint-removed', { breakpointId, label: point.label });
        }
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
                invocationId: null,
                ownerProofs: [],
                receipt: null,
            };
            this.network.set(networkId, row);
        }
        return row;
    }

    linkRequest(networkId, invocationId, proof) {
        if (!networkId || !invocationId) {
            throw new TypeError('linkRequest requires non-empty networkId and invocationId');
        }
        const row = this.ensureNetworkRow(networkId);
        if (row.invocationId && row.invocationId !== invocationId) {
            throw new Error(`Conflicting invocation owners for Network ${networkId}: ${row.invocationId} vs ${invocationId}`);
        }
        row.invocationId = invocationId;
        row.ownerProofs.push(proof);
        const inv = this.invocations.get(invocationId) || this.#createInvocationSlot(invocationId);
        if (!inv.linkedNetworkIds.includes(networkId)) {
            inv.linkedNetworkIds.push(networkId);
        }
        this.record('request-linked', { networkId, invocationId, proof });
    }

    #createInvocationSlot(invocationId) {
        const slot = {
            invocationId,
            action: null,
            target: null,
            input: null,
            entry: null,
            fulfilled: null,
            rejected: null,
            linkedNetworkIds: [],
        };
        this.invocations.set(invocationId, slot);
        return slot;
    }

    recordInvocation(record) {
        if (!record || typeof record.invocationId !== 'string' || !record.invocationId) {
            throw new TypeError('Invocation record requires a non-empty invocationId');
        }
        const slot = this.invocations.get(record.invocationId) || this.#createInvocationSlot(record.invocationId);
        if (record.action !== undefined && slot.action === null) slot.action = record.action;
        if (record.target !== undefined && slot.target === null) slot.target = record.target;
        if (record.input !== undefined && slot.input === null) slot.input = record.input;
        const enriched = { ...record };
        if (this.readStored) {
            enriched.observedStored = this.readStored();
            enriched.storedObservation = { boundary: 'independently-timed-after-native-log', observedAt: new Date().toISOString() };
        }
        slot[record.status] = enriched;
        this.record('invocation-' + record.status, enriched);
        if (this.onInvocationEvent) this.onInvocationEvent(enriched, slot);
        return enriched;
    }

    #joinReceipts() {
        if (!this.receiptHeader) return;
        for (const reply of this.nativeReplies) {
            if (!reply.receipt) {
                this.recordGap({
                    kind: 'missing-receipt',
                    invocationId: reply.invocationId,
                    reason: 'Native reply had no response receipt header; cannot attribute request.',
                });
                continue;
            }
            const httpMatches = this.httpReceipts.get(reply.receipt) || [];
            const nativeMatches = this.nativeReplies.filter(candidate => candidate.receipt === reply.receipt);
            if (httpMatches.length !== 1 || nativeMatches.length !== 1) {
                this.recordGap({
                    kind: 'ambiguous-receipt',
                    invocationId: reply.invocationId,
                    receipt: reply.receipt,
                    httpCount: httpMatches.length,
                    nativeCount: nativeMatches.length,
                    reason: 'Receipt is not unique across HTTP and native replies.',
                });
                continue;
            }
            if (reply.joinedNetworkId) continue;
            const httpEntry = httpMatches[0];
            const matchingSends = this.nativeSends.filter(s => s.invocationId === reply.invocationId);
            if (!matchingSends.length) {
                this.recordGap({
                    kind: 'missing-native-send',
                    networkId: httpEntry.networkId,
                    invocationId: reply.invocationId,
                    receipt: reply.receipt,
                    reason: 'Native reply lacked a matching observed native send.',
                });
                continue;
            }
            if (reply.status !== httpEntry.status) {
                throw new Error(`Native/HTTP receipt status mismatch for ${reply.receipt}: ${reply.status} vs ${httpEntry.status}`);
            }
            reply.joinedNetworkId = httpEntry.networkId;
            const row = this.ensureNetworkRow(httpEntry.networkId);
            row.receipt = reply.receipt;
            this.linkRequest(httpEntry.networkId, reply.invocationId, {
                mechanism: 'actual-native-response-receipt',
                receipt: reply.receipt,
                fetchId: httpEntry.fetchId,
                status: reply.status,
            });
        }
    }

    async #handleNativeConsole(event) {
        if (event.type !== 'dir' || !event.args?.[0]?.objectId) return;
        const packet = await this.readRemoteProperties(event.args[0].objectId);
        if (packet.marker?.value !== this.nativeMarker) return;
        this.record('native-console-packet', { type: event.type, timestamp: event.timestamp });
        if (packet.error) {
            throw new Error(`Native logpoint ${packet.point?.value || packet.label?.value} failed: ${packet.error.value}\n${packet.stack?.value || ''}`);
        }
        const point = packet.point ? this.points.get(packet.point.value) : { label: packet.label?.value };
        if (!point) throw new Error(`Unknown native logpoint ${packet.point?.value}`);
        const data = JSON.parse(packet.snapshot.value);
        const references = packet.references?.objectId ? await this.readRemoteProperties(packet.references.objectId) : {};
        const stack = (event.stackTrace?.callFrames || []).map(({ functionName, url, scriptId, lineNumber, columnNumber }) => ({
            functionName,
            url,
            location: { scriptId, lineNumber, columnNumber },
        }));
        if (point.path && this.baseURL) {
            const script = [...this.scripts.values()].find(s => s.url.split('?')[0] === this.baseURL + '/' + point.path.replace(/^public\//, ''));
            if (!script) throw new Error(`Native logpoint has no loaded source: ${point.path}`);
            await this.validateScriptSource(script, point.path);
        }

        if (this.onNativePacket) {
            await this.onNativePacket({ event, packet, point, data, references, stack });
            return;
        }

        if (point.label === 'operation-send') {
            this.nativeSends.push({ ...data, stack, timestamp: event.timestamp });
            this.record('operation-send', data);
            return;
        }
        if (point.label === 'operation-reply') {
            this.nativeReplies.push({ ...data, stack, timestamp: event.timestamp, joinedNetworkId: null });
            this.record('operation-reply', data);
            this.#joinReceipts();
            return;
        }
        this.record(point.label || 'native-packet', { data, stack });
    }

    async #handleFetchPaused(event) {
        const isResponse = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
        const stage = isResponse ? 'Response' : 'Request';
        const stored = this.readStored ? this.readStored() : null;
        const row = this.ensureNetworkRow(event.networkId);
        if (!row.fetchIds.includes(event.requestId)) row.fetchIds.push(event.requestId);
        if (!isResponse && stored !== null) row.storedBefore = stored;
        if (isResponse && stored !== null) row.storedAtResponse = stored;

        this.record('fetch-pause', {
            fetchId: event.requestId,
            networkId: event.networkId,
            stage,
            url: event.request?.url,
            method: event.request?.method,
            status: event.responseStatusCode,
            errorReason: event.responseErrorReason,
            stored: this.storeBody(stored),
        });

        await this.wait(() => this.network.get(event.networkId)?.request, { allowErrors: true });
        await this.captureQueue;

        if (isResponse && this.receiptHeader) {
            const receipt = getHeaderCaseInsensitive(event.responseHeaders, this.receiptHeader);
            if (receipt) {
                const list = this.httpReceipts.get(receipt) || [];
                list.push({ event, networkId: event.networkId, fetchId: event.requestId, status: event.responseStatusCode, stored });
                this.httpReceipts.set(receipt, list);
                this.record('http-response-receipt', { receipt, networkId: event.networkId, fetchId: event.requestId, status: event.responseStatusCode });
                this.#joinReceipts();
            }
        }

        if (isResponse && this.recordBodies && !event.responseErrorReason) {
            const body = await this.cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
            const decoded = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body);
            row.responseBody = decoded.toString('utf8');
            this.record('response-body', {
                networkId: event.networkId,
                fetchId: event.requestId,
                status: event.responseStatusCode,
                body: this.storeBody(decoded, 'application/octet-stream'),
            });
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
            this.record('delivery-held', {
                name: rule.name,
                networkId: event.networkId,
                fetchId: event.requestId,
                stage,
            });
            return;
        }

        await this.continueFetch(event);
    }

    async start() {
        if (this.started) return this;
        this.started = true;
        this.cdp = await this.context.newCDPSession(this.page);

        this.onConsole = message => {
            const text = message.text();
            this.record('browser-console', { type: message.type(), text: this.storeBody(text, 'text/plain'), location: message.location() });
            if (this.markerPrefix && text.startsWith(this.markerPrefix)) {
                try {
                    const parsed = JSON.parse(text.slice(this.markerPrefix.length));
                    if (parsed && typeof parsed.invocationId === 'string' && typeof parsed.status === 'string') {
                        this.recordInvocation(parsed);
                    }
                } catch (err) {
                    this.errors.push(err);
                    this.record('observer-error', { message: `Malformed consumer invocation log: ${err.message}` });
                }
            }
        };
        this.onPageError = error => this.record('browser-error', { message: error.message, stack: error.stack });
        this.onPageClose = () => this.record('page-closed-before-observer', {});

        this.onNetworkRequest = event => {
            if (this.networkFilter && !this.networkFilter(event)) return;
            const row = this.ensureNetworkRow(event.requestId);
            row.request = event;
            this.record('network-request', {
                networkId: event.requestId,
                url: event.request?.url,
                method: event.request?.method,
                headers: event.request?.headers,
                postData: event.request?.postData,
                initiator: event.initiator,
            });
        };
        this.onNetworkResponse = event => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.response = event;
            this.record('network-response', {
                networkId: event.requestId,
                status: event.response?.status,
                headers: event.response?.headers,
            });
        };
        this.onNetworkFinished = event => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.finished = event;
            this.record('network-finished', { networkId: event.requestId, encodedDataLength: event.encodedDataLength });
        };
        this.onNetworkFailed = event => {
            const row = this.network.get(event.requestId);
            if (!row) return;
            row.failed = event;
            this.record('network-failed', { networkId: event.requestId, errorText: event.errorText, canceled: event.canceled });
        };
        this.onFetchEvent = event => {
            this.fetch.set(event.requestId, event);
            if (this.fetchClosing) {
                this.record('fetch-pause-during-disable', { fetchId: event.requestId, networkId: event.networkId });
                return;
            }
            this.job(() => this.#handleFetchPaused(event));
        };
        this.onDebuggerPaused = event => {
            this.errors.push(new Error(`Non-pausing operation observer received Debugger.paused: ${event.reason}`));
            this.record('unexpected-debugger-pause', event);
        };
        this.onRuntimeConsole = event => {
            if (event.type !== 'dir' || !event.args?.[0]?.objectId) return;
            const previous = this.captureQueue;
            this.captureQueue = this.job(async () => {
                await previous;
                await this.#handleNativeConsole(event);
            });
        };
        this.onScriptParsed = event => {
            this.scripts.set(event.scriptId, event);
        };

        this.page.on('console', this.onConsole);
        this.page.on('pageerror', this.onPageError);
        this.page.on('close', this.onPageClose);

        this.cdp.on('Network.requestWillBeSent', this.onNetworkRequest);
        this.cdp.on('Network.responseReceived', this.onNetworkResponse);
        this.cdp.on('Network.loadingFinished', this.onNetworkFinished);
        this.cdp.on('Network.loadingFailed', this.onNetworkFailed);
        this.cdp.on('Fetch.requestPaused', this.onFetchEvent);
        this.cdp.on('Debugger.paused', this.onDebuggerPaused);
        this.cdp.on('Runtime.consoleAPICalled', this.onRuntimeConsole);
        this.cdp.on('Debugger.scriptParsed', this.onScriptParsed);
        this.cdp.on('Debugger.breakpointResolved', event => this.record('breakpoint-resolved', event));
        this.cdp.on('Page.frameNavigated', event => this.record('frame-navigated', event));
        this.cdp.on('Page.frameScheduledNavigation', event => this.record('frame-scheduled-navigation', event));
        this.cdp.on('Runtime.executionContextsCleared', event => this.record('execution-contexts-cleared', event));
        this.cdp.on('Runtime.executionContextDestroyed', event => this.record('execution-context-destroyed', event));

        await this.cdp.send('Page.enable');
        await this.cdp.send('Runtime.enable');
        await this.cdp.send('Network.enable');
        if (this.enableDebugger) {
            await this.cdp.send('Debugger.enable');
            await this.cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
            const native = await this.cdp.send('Runtime.evaluate', {
                expression: 'Function.prototype.toString.call(console.dir)',
                returnByValue: true,
            });
            if (!String(native?.result?.value || '').includes('[native code]')) {
                throw new Error('Native console.dir observation is unavailable');
            }
        }
        if (this.patterns.length) {
            await this.cdp.send('Fetch.enable', { patterns: this.patterns });
        }

        await this.scope.onFinalize({
            label: `close operation observer ${this.diagnosticName}`,
            stage: 'drain',
            callback: () => this.close(),
        });
        if (typeof this.scope.diagnostic === 'function') {
            await this.scope.diagnostic({
                name: this.diagnosticName,
                contentType: 'application/json',
                stage: 'complete',
                produce: () => this.serializeDiagnosticBytes(),
            });
        }
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
        this.record('delivery-release', {
            networkId: raw?.networkId ?? null,
            fetchId,
            stage: isResponse ? 'Response' : 'Request',
            failReason,
        });
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
        const row = await this.wait(() => {
            const candidate = this.network.get(networkId);
            return candidate?.finished || candidate?.failed ? candidate : false;
        }, { allowErrors: cleanup });
        if (row.failed && !failReason && !cleanup) {
            throw new Error(`Released Network ${networkId} failed: ${JSON.stringify(row.failed)}`);
        }
        this.record('released-http-completed', {
            networkId,
            fetchId,
            status: row.response?.response?.status ?? null,
            failed: Boolean(row.failed),
            invocationId: row.invocationId,
        });
        return {
            networkId,
            fetchId,
            status: row.response?.response?.status ?? null,
            finished: Boolean(row.finished),
            failed: Boolean(row.failed),
            invocationId: row.invocationId,
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
            invocationId: row.invocationId,
            ownerProofs: row.ownerProofs.slice(),
            receipt: row.receipt,
            finished: Boolean(row.finished),
            failed: Boolean(row.failed),
        };
    }

    getNetworkRecords() {
        return [...this.network.keys()].map(id => this.getNetworkRecord(id));
    }

    getInvocation(invocationId) {
        const slot = this.invocations.get(invocationId);
        if (!slot) return null;
        const settlement = slot.fulfilled || slot.rejected || null;
        return {
            invocationId: slot.invocationId,
            action: slot.action,
            target: slot.target,
            input: slot.input,
            entry: slot.entry,
            fulfilled: slot.fulfilled,
            rejected: slot.rejected,
            settlement,
            status: slot.fulfilled ? 'fulfilled' : slot.rejected ? 'rejected' : 'pending',
            settled: Boolean(settlement),
            value: slot.fulfilled?.value,
            error: slot.rejected?.error ?? slot.rejected?.value ?? null,
            linkedRequests: this.getInvocationRequests(invocationId),
        };
    }

    getInvocationRequests(invocationId) {
        const slot = this.invocations.get(invocationId);
        if (!slot) return [];
        return slot.linkedNetworkIds.map(id => this.getNetworkRecord(id)).filter(Boolean);
    }

    requireCorrelatedRequest(invocationId, predicate = () => true) {
        const linked = this.getInvocationRequests(invocationId).filter(predicate);
        if (linked.length === 1) return linked[0];
        this.#collectUnattributedGaps();
        if (linked.length > 1) {
            this.recordGap({
                kind: 'ambiguous-linked-requests',
                invocationId,
                candidates: linked.map(r => r.networkId),
                reason: `Expected one causally linked request for invocation ${invocationId}, found ${linked.length}.`,
            });
            throw new ObservationEvidenceGapError(
                `Ambiguous causally linked requests for invocation ${invocationId}: ${linked.map(r => r.networkId).join(', ')}`,
                { invocationId, evidenceGaps: this.evidenceGaps.slice(), networkRecords: this.getNetworkRecords() },
            );
        }
        this.recordGap({
            kind: 'missing-network-link',
            invocationId,
            reason: `No verified causal link associates any observed HTTP request with invocation ${invocationId}.`,
        });
        throw new ObservationEvidenceGapError(
            `No causally correlated network request found for invocation ${invocationId}; refusing to guess by body or arrival order.`,
            { invocationId, evidenceGaps: this.evidenceGaps.slice(), networkRecords: this.getNetworkRecords() },
        );
    }

    waitForInvocationEntry(action, { afterSequence = this.serial } = {}) {
        return this.wait(() => {
            const event = this.events.find(candidate => (
                candidate.sequence > afterSequence
                && candidate.kind === 'invocation-entry'
                && (!action || candidate.data.action === action)
            ));
            return event ? event.data : false;
        });
    }

    async waitForInvocation(invocationId) {
        await this.wait(() => {
            const slot = this.invocations.get(invocationId);
            return slot && (slot.fulfilled || slot.rejected) ? slot : false;
        });
        await this.capturesSettled();
        const slot = this.invocations.get(invocationId);
        for (const networkId of slot.linkedNetworkIds) {
            await this.wait(() => {
                const row = this.network.get(networkId);
                return row && (row.finished || row.failed) ? row : false;
            });
        }
        this.#collectUnattributedGaps();
        return this.getInvocation(invocationId);
    }

    #collectUnattributedGaps() {
        for (const row of this.network.values()) {
            const method = row.request?.request?.method;
            const url = row.request?.request?.url;
            if (!method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') continue;
            if (row.invocationId !== null) continue;
            if (!row.finished && !row.failed) continue;
            this.recordGap({
                kind: 'unattributed-request',
                networkId: row.networkId,
                method,
                url,
                status: row.response?.response?.status ?? null,
                reason: 'Non-read HTTP request completed without verified causal proof linking it to a declared invocation.',
            });
        }
    }

    async drain({ cleanup = false } = {}) {
        await this.capturesSettled();
        for (const slot of this.invocations.values()) {
            await this.wait(() => slot.fulfilled || slot.rejected, { allowErrors: cleanup });
        }
        for (const row of this.network.values()) {
            if (row.invocationId !== null || row.fetchIds.length > 0) {
                await this.wait(() => row.finished || row.failed, { allowErrors: cleanup });
            }
        }
        await this.capturesSettled();
        this.#collectUnattributedGaps();
    }

    serializeDiagnosticBytes() {
        this.#collectUnattributedGaps();
        const payload = {
            diagnosticName: this.diagnosticName,
            invocations: [...this.invocations.keys()].map(id => this.getInvocation(id)),
            network: this.getNetworkRecords(),
            evidenceGaps: this.evidenceGaps,
            events: this.artifactDir ? this.ledger : this.events,
            errors: this.errors.map(err => ({ message: err.message, stack: err.stack })),
        };
        return Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    }

    close() {
        this.closePromise ??= this.#finish();
        return this.closePromise;
    }

    async #finish() {
        this.record('observer-close-entry', {
            pendingFetch: [...this.fetch.keys()],
            heldFetch: [...this.holds.keys()],
            pendingJobs: this.jobs.size,
            pageClosed: this.page.isClosed(),
        });
        this.rules = [];
        const cleanupErrors = [];
        const runStep = async (stage, operation) => {
            try {
                await operation();
                this.record('observer-cleanup-completed', { stage });
            } catch (error) {
                cleanupErrors.push(error);
                this.record('observer-cleanup-error', { stage, message: error.message, stack: error.stack });
            }
        };

        try {
            if (this.beforeClose) {
                await this.beforeClose({ cleanupErrors });
            }
            if (!this.page.isClosed()) {
                for (const event of [...this.holds.values()]) {
                    await this.release(event, { cleanup: true });
                }
                while (this.jobs.size) {
                    await Promise.all([...this.jobs]);
                }
                await this.captureQueue;
                for (const event of [...this.fetch.values()]) {
                    await this.continueFetch(event);
                }
            }
        } catch (error) {
            cleanupErrors.push(error);
            this.record('observer-cleanup-error', { stage: 'release-holds', message: error.message, stack: error.stack });
        } finally {
            try {
                if (this.cdp) {
                    if (this.enableDebugger) {
                        await runStep('breakpoints-removed', () => this.removeLogpoints(() => true));
                    }
                    await runStep('pending-observer-captures', async () => {
                        while (this.jobs.size) await Promise.all([...this.jobs]);
                        await this.captureQueue;
                    });
                    if (this.enableDebugger) {
                        await runStep('debugger-disabled', () => this.cdp.send('Debugger.disable'));
                    }
                    if (this.patterns.length) {
                        await runStep('released-interceptions', async () => {
                            while (this.jobs.size) await Promise.all([...this.jobs]);
                            for (const event of [...this.fetch.values()]) await this.continueFetch(event);
                        });
                        this.fetchClosing = true;
                        await runStep('fetch-disabled', () => this.cdp.send('Fetch.disable'));
                        this.fetch.clear();
                    }
                    await runStep('remote-objects-released', async () => {
                        for (const objectId of this.remoteHandles) {
                            await this.cdp.send('Runtime.releaseObject', { objectId });
                        }
                        this.remoteHandles.clear();
                    });
                    await runStep('network-disabled', () => this.cdp.send('Network.disable'));
                    await runStep('runtime-disabled', () => this.cdp.send('Runtime.disable'));
                    await runStep('page-domain-disabled', () => this.cdp.send('Page.disable'));
                    await runStep('session-detached', () => this.cdp.detach());
                    this.cdp.removeAllListeners();
                }
                this.record('observer-detached', { pageClosed: this.page.isClosed(), cleanupErrors: cleanupErrors.length });
            } finally {
                this.closed = true;
                this.page.off('console', this.onConsole);
                this.page.off('pageerror', this.onPageError);
                this.page.off('close', this.onPageClose);
                for (const waiter of this.waiters) {
                    waiter.reject(new Error('Operation observer closed before its observation completed'));
                }
                this.waiters.clear();
                this.#collectUnattributedGaps();
                if (this.artifactDir) {
                    writeFileSync(resolve(this.artifactDir, 'ledger.json'), this.serializeDiagnosticBytes());
                }
                if (this.afterClose) {
                    await this.afterClose({ cleanupErrors });
                }
            }
        }
        if (this.errors.length || cleanupErrors.length) {
            throw new AggregateError([...this.errors, ...cleanupErrors], 'Operation observer closure failed');
        }
    }
}

/**
 * Attach a managed CDP & consumer-invocation observer to a real Playwright page.
 *
 * @param {object} options
 * @returns {Promise<OperationObserver>}
 */
export async function observeOperations(options = {}) {
    requireObserverInputs(options);
    const observer = new OperationObserver(options);
    await observer.start();
    return observer;
}
