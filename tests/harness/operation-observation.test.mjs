import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { test as managedTest } from './node.js';
import { observeOperations } from './observations.js';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const runOptions = {
    projectRoot: repository,
    profile: 'unit',
    command: [process.execPath, '--test', 'harness/operation-observation.test.mjs'],
    source: 'operation-observation-contract',
};

async function startFixtureApp(scope) {
    const dir = await scope.directory('operation observation app');
    const stateFile = path.join(dir.path, 'state.json');
    const initialState = { version: 0, records: [], lastValue: null };
    fs.writeFileSync(stateFile, JSON.stringify(initialState, null, 2));
    const readStored = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    const pageHtml = `<!doctype html>
<html>
<body>
<button id="btn-write" type="button">Write</button>
<button id="btn-bg" type="button">Background</button>
<button id="btn-noop" type="button">Noop</button>
<button id="btn-reject-local" type="button">RejectLocal</button>
<button id="btn-reject-http" type="button">RejectHttp</button>
<button id="btn-uncorrelated" type="button">Uncorrelated</button>
<input id="payload-input" value="same-payload" />
<pre id="status"></pre>
<script>
const PREFIX = '[luker-operation] ';
const NATIVE_MARKER = 'luker-operation-native';
let localCommitted = null;
const emit = (record) => console.debug(PREFIX + JSON.stringify(record));
const emitNative = (label, snapshot, references = {}) => {
    console.dir(Object.freeze({
        marker: NATIVE_MARKER,
        label,
        snapshot: JSON.stringify(snapshot),
        references: Object.freeze(references),
    }));
};

async function performWrite(invocationId, target, input, opts = {}) {
    const body = JSON.stringify({ value: input.value });
    const headers = { 'content-type': 'application/json' };
    if (opts.emitProof !== false) {
        emitNative('operation-send', { invocationId, url: '/api/items', method: 'POST', target, input });
    }
    const resp = await fetch(opts.url || '/api/items', { method: 'POST', headers, body });
    const receipt = resp.headers.get('x-operation-receipt');
    if (opts.emitProof !== false) {
        emitNative('operation-reply', { invocationId, url: '/api/items', status: resp.status, ok: resp.ok, receipt });
    }
    if (!resp.ok) {
        throw new Error('HTTP write failed with status ' + resp.status);
    }
    const data = await resp.json();
    localCommitted = input.value;
    return data;
}

document.getElementById('btn-bg').addEventListener('click', async () => {
    const value = document.getElementById('payload-input').value;
    await fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-background-source': '1' },
        body: JSON.stringify({ value }),
    });
});

document.getElementById('btn-write').addEventListener('click', async () => {
    const invocationId = crypto.randomUUID();
    const input = { value: document.getElementById('payload-input').value };
    emit({ status: 'entry', invocationId, action: 'write', target: '/api/items', input });
    try {
        // Trigger an unrelated GET poll during the write to ensure non-target GETs stay separate.
        const poll = fetch('/api/items?poll=1', { method: 'GET' });
        const result = await performWrite(invocationId, '/api/items', input);
        await poll;
        emit({ status: 'fulfilled', invocationId, action: 'write', target: '/api/items', input, value: result });
        document.getElementById('status').textContent = 'ok:' + result.version;
    } catch (error) {
        emit({ status: 'rejected', invocationId, action: 'write', target: '/api/items', input, error: { message: error.message } });
        document.getElementById('status').textContent = 'err:' + error.message;
    }
});

document.getElementById('btn-noop').addEventListener('click', async () => {
    const invocationId = crypto.randomUUID();
    const input = { value: localCommitted };
    emit({ status: 'entry', invocationId, action: 'noop', target: '/api/items', input });
    emit({ status: 'fulfilled', invocationId, action: 'noop', target: '/api/items', input, value: { changed: false, http: false } });
    document.getElementById('status').textContent = 'noop';
});

document.getElementById('btn-reject-local').addEventListener('click', async () => {
    const invocationId = crypto.randomUUID();
    const input = { value: '' };
    emit({ status: 'entry', invocationId, action: 'reject-local', target: '/api/items', input });
    try {
        throw new Error('Validation rejected empty value');
    } catch (error) {
        emit({ status: 'rejected', invocationId, action: 'reject-local', target: '/api/items', input, error: { message: error.message } });
        document.getElementById('status').textContent = 'err:' + error.message;
    }
});

document.getElementById('btn-reject-http').addEventListener('click', async () => {
    const invocationId = crypto.randomUUID();
    const input = { value: 'fail-me' };
    emit({ status: 'entry', invocationId, action: 'reject-http', target: '/api/items', input });
    try {
        await performWrite(invocationId, '/api/items', input, { url: '/api/items?fail=1' });
        emit({ status: 'fulfilled', invocationId, action: 'reject-http', target: '/api/items', input });
    } catch (error) {
        emit({ status: 'rejected', invocationId, action: 'reject-http', target: '/api/items', input, error: { message: error.message } });
        document.getElementById('status').textContent = 'err:' + error.message;
    }
});

document.getElementById('btn-uncorrelated').addEventListener('click', async () => {
    const invocationId = crypto.randomUUID();
    const input = { value: document.getElementById('payload-input').value };
    emit({ status: 'entry', invocationId, action: 'uncorrelated', target: '/api/items', input });
    try {
        const result = await performWrite(invocationId, '/api/items', input, { emitProof: false });
        emit({ status: 'fulfilled', invocationId, action: 'uncorrelated', target: '/api/items', input, value: result });
    } catch (error) {
        emit({ status: 'rejected', invocationId, action: 'uncorrelated', target: '/api/items', input, error: { message: error.message } });
    }
});
</script>
</body>
</html>`;

    let receiptSeq = 0;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(pageHtml);
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/items') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(readStored()));
            return;
        }
        if (req.method === 'POST' && url.pathname === '/api/items') {
            const chunks = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const receipt = `receipt-${++receiptSeq}`;
                if (url.searchParams.get('fail') === '1') {
                    res.writeHead(500, { 'content-type': 'application/json', 'x-operation-receipt': receipt });
                    res.end(JSON.stringify({ error: 'forced server failure' }));
                    return;
                }
                const current = readStored();
                current.version += 1;
                current.lastValue = body.value;
                current.records.push({
                    version: current.version,
                    value: body.value,
                    background: req.headers['x-background-source'] === '1',
                    receipt,
                });
                fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));
                res.writeHead(200, { 'content-type': 'application/json', 'x-operation-receipt': receipt });
                res.end(JSON.stringify(current));
            });
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const baseURL = `http://127.0.0.1:${port}`;
    await scope.onFinalize({
        label: 'close fixture HTTP server',
        stage: 'complete',
        callback: async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        },
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await scope.onFinalize({
        label: 'close fixture browser',
        stage: 'complete',
        callback: async () => {
            await context.close();
            await browser.close();
        },
    });

    await page.goto(baseURL);
    return { page, context, baseURL, readStored };
}

managedTest('same-body background request and non-target GET are not attributed to the consumer invocation', runOptions, async (_t, scope) => {
    const { page, baseURL, readStored } = await startFixtureApp(scope);
    const observer = await observeOperations({
        page,
        scope,
        baseURL,
        patterns: [
            { urlPattern: '*/api/items*', requestStage: 'Request' },
            { urlPattern: '*/api/items*', requestStage: 'Response' },
        ],
        readStored,
        receiptHeader: 'x-operation-receipt',
    });

    // Hold the background POST response with identical body.
    const bgHold = observer.hold('background-same-body', ({ stage, event }) => (
        stage === 'Response'
        && event.request.method === 'POST'
        && event.request.headers['x-background-source'] === '1'
    ));
    // Hold the consumer POST response separately.
    const writeHold = observer.hold('consumer-write', ({ stage, event }) => (
        stage === 'Response'
        && event.request.method === 'POST'
        && event.request.headers['x-background-source'] !== '1'
    ));

    await page.locator('#btn-bg').click();
    const pausedBg = await bgHold.paused();

    const writeEntryPromise = observer.waitForInvocationEntry('write');
    await page.locator('#btn-write').click();
    const actualConsumerInvocation = await writeEntryPromise;
    const actualPausedRequest = await writeHold.paused();

    // Release background first, then consumer write.
    await observer.release(pausedBg);
    await observer.release(actualPausedRequest);

    const settled = await observer.waitForInvocation(actualConsumerInvocation.invocationId);
    await observer.drain();

    assert.equal(settled.status, 'fulfilled');
    const linkedRequests = observer.getInvocationRequests(actualConsumerInvocation.invocationId);
    assert.equal(linkedRequests.length, 1);
    const linkedRequest = linkedRequests[0];
    const backgroundRequest = observer.getNetworkRecord(pausedBg.networkId);

    assert.equal(linkedRequest.networkId, actualPausedRequest.networkId);
    assert.equal(linkedRequest.invocationId, actualConsumerInvocation.invocationId);
    assert.notEqual(backgroundRequest.networkId, linkedRequest.networkId);
    assert.equal(backgroundRequest.invocationId, null);

    // Non-target GET poll was observed, never misattributed to the POST write.
    const getRequests = observer.getNetworkRecords().filter(r => r.method === 'GET' && r.url.includes('/api/items?poll=1'));
    assert.equal(getRequests.length, 1);
    assert.equal(getRequests[0].invocationId, null);

    // Unattributed background POST is explicitly surfaced in evidence gaps rather than silently merged.
    assert.ok(observer.evidenceGaps.some(gap => gap.kind === 'unattributed-request' && gap.networkId === backgroundRequest.networkId));

    const actualFinalStoredState = readStored();
    const independentExpectedState = {
        version: 2,
        lastValue: 'same-payload',
        records: [
            { version: 1, value: 'same-payload', background: true, receipt: 'receipt-1' },
            { version: 2, value: 'same-payload', background: false, receipt: 'receipt-2' },
        ],
    };
    assert.deepEqual(actualFinalStoredState, independentExpectedState);
});

managedTest('zero-HTTP real no-op, local rejection, and HTTP rejection settle accurately', runOptions, async (_t, scope) => {
    const { page, baseURL, readStored } = await startFixtureApp(scope);
    const observer = await observeOperations({
        page,
        scope,
        baseURL,
        patterns: [
            { urlPattern: '*/api/items*', requestStage: 'Request' },
            { urlPattern: '*/api/items*', requestStage: 'Response' },
        ],
        readStored,
        receiptHeader: 'x-operation-receipt',
    });

    // 1. Zero-HTTP real no-op
    const noopEntryP = observer.waitForInvocationEntry('noop');
    await page.locator('#btn-noop').click();
    const noopEntry = await noopEntryP;
    const noopSettled = await observer.waitForInvocation(noopEntry.invocationId);
    assert.equal(noopSettled.status, 'fulfilled');
    assert.deepEqual(observer.getInvocationRequests(noopEntry.invocationId), []);
    assert.deepEqual(readStored(), { version: 0, records: [], lastValue: null });

    // 2. Local validation rejection (zero HTTP)
    const localRejectP = observer.waitForInvocationEntry('reject-local');
    await page.locator('#btn-reject-local').click();
    const localRejectEntry = await localRejectP;
    const localRejectSettled = await observer.waitForInvocation(localRejectEntry.invocationId);
    assert.equal(localRejectSettled.status, 'rejected');
    assert.match(localRejectSettled.error.message, /Validation rejected/);
    assert.deepEqual(observer.getInvocationRequests(localRejectEntry.invocationId), []);

    // 3. HTTP 500 rejection (linked failed request, stored state unchanged)
    const httpRejectP = observer.waitForInvocationEntry('reject-http');
    await page.locator('#btn-reject-http').click();
    const httpRejectEntry = await httpRejectP;
    const httpRejectSettled = await observer.waitForInvocation(httpRejectEntry.invocationId);
    assert.equal(httpRejectSettled.status, 'rejected');
    assert.match(httpRejectSettled.error.message, /500/);
    const httpRejectRequests = observer.getInvocationRequests(httpRejectEntry.invocationId);
    assert.equal(httpRejectRequests.length, 1);
    assert.equal(httpRejectRequests[0].status, 500);
    assert.deepEqual(readStored(), { version: 0, records: [], lastValue: null });
});

managedTest('missing causal proof reports an evidence gap instead of guessing by body or order', runOptions, async (_t, scope) => {
    const { page, baseURL, readStored } = await startFixtureApp(scope);
    const observer = await observeOperations({
        page,
        scope,
        baseURL,
        patterns: [
            { urlPattern: '*/api/items*', requestStage: 'Request' },
            { urlPattern: '*/api/items*', requestStage: 'Response' },
        ],
        readStored,
        receiptHeader: 'x-operation-receipt',
    });

    const entryP = observer.waitForInvocationEntry('uncorrelated');
    await page.locator('#btn-uncorrelated').click();
    const entry = await entryP;
    const settled = await observer.waitForInvocation(entry.invocationId);
    await observer.drain();

    assert.equal(settled.status, 'fulfilled');
    assert.deepEqual(observer.getInvocationRequests(entry.invocationId), []);
    assert.throws(
        () => observer.requireCorrelatedRequest(entry.invocationId),
        (err) => err?.code === 'OBSERVATION_EVIDENCE_GAP',
    );
    assert.ok(observer.evidenceGaps.some(gap => gap.kind === 'unattributed-request'));
});

managedTest('releasing a held write awaits actual network completion and scope disposal drains unclosed holds with readable diagnostics', runOptions, async (_t, scope, run) => {
    const { page, baseURL, readStored } = await startFixtureApp(scope);
    const observer = await observeOperations({
        page,
        scope,
        baseURL,
        patterns: [
            { urlPattern: '*/api/items*', requestStage: 'Request' },
            { urlPattern: '*/api/items*', requestStage: 'Response' },
        ],
        readStored,
        receiptHeader: 'x-operation-receipt',
        diagnosticName: 'operation-observation-release.json',
    });

    const firstHold = observer.hold('first-write', ({ stage, event }) => (
        stage === 'Response' && event.request.method === 'POST'
    ));
    await page.locator('#payload-input').fill('first-value');
    const firstEntryP = observer.waitForInvocationEntry('write');
    await page.locator('#btn-write').click();
    const firstEntry = await firstEntryP;
    const pausedFirst = await firstHold.paused();

    // While first write is held, issue a second write (not held).
    await page.locator('#payload-input').fill('second-value');
    const secondEntryP = observer.waitForInvocationEntry('write');
    await page.locator('#btn-write').click();
    const secondEntry = await secondEntryP;
    const secondSettled = await observer.waitForInvocation(secondEntry.invocationId);
    assert.equal(secondSettled.status, 'fulfilled');

    // First write must still NOT be settled before release.
    assert.equal(observer.getInvocation(firstEntry.invocationId).settled, false);

    // Release first write and verify actual loadingFinished before settlement.
    const released = await observer.release(pausedFirst);
    assert.equal(released.finished, true);
    const firstSettled = await observer.waitForInvocation(firstEntry.invocationId);
    assert.equal(firstSettled.status, 'fulfilled');

    // Verify independent final state reflects both real writes.
    assert.deepEqual(readStored(), {
        version: 2,
        lastValue: 'second-value',
        records: [
            { version: 1, value: 'first-value', background: false, receipt: 'receipt-1' },
            { version: 2, value: 'second-value', background: false, receipt: 'receipt-2' },
        ],
    });

    // Explicitly close and verify captured diagnostic artifact is readable.
    await observer.close();
    const bytes = observer.serializeDiagnosticBytes();
    const parsed = JSON.parse(bytes.toString('utf8'));
    assert.equal(parsed.invocations.length, 2);
    assert.equal(parsed.errors.length, 0);
    assert.ok(run.registry.scopes.some(s => s.finalizers?.some(f => f.label === 'operation-observation-release.json')));
});

managedTest('scope disposal automatically releases held requests and detaches unclosed observer with readable diagnostics', runOptions, async (_t, scope, run) => {
    const { page, baseURL, readStored } = await startFixtureApp(scope);
    const childScope = await scope.child({ kind: 'case', label: 'auto-dispose observation child' });
    const observer = await observeOperations({
        page,
        scope: childScope,
        baseURL,
        patterns: [
            { urlPattern: '*/api/items*', requestStage: 'Request' },
            { urlPattern: '*/api/items*', requestStage: 'Response' },
        ],
        readStored,
        receiptHeader: 'x-operation-receipt',
        diagnosticName: 'operation-observation-auto-dispose.json',
    });

    const hold = observer.hold('unclosed-hold', ({ stage, event }) => (
        stage === 'Response' && event.request.method === 'POST'
    ));
    await page.locator('#payload-input').fill('auto-released');
    const entryP = observer.waitForInvocationEntry('write');
    await page.locator('#btn-write').click();
    await entryP;
    await hold.paused();
    assert.equal(observer.holds.size, 1);

    // Intentionally omit observer.close(): disposing the child scope must
    // release the held response, finish network delivery, detach CDP, and
    // persist a complete readable diagnostic artifact.
    await childScope.dispose();
    assert.equal(observer.closed, true);
    assert.equal(observer.holds.size, 0);
    assert.equal(page.isClosed(), false);
    const ref = run.registry.diagnostics.artifacts.find(a => a.name === 'operation-observation-auto-dispose.json');
    assert.ok(ref && ref.readStatus === 'complete', 'expected complete diagnostic artifact after scope disposal');
    const storedBytes = fs.readFileSync(path.join(run.registry.diagnostics.objects.path, ref.sha256), 'utf8');
    const parsed = JSON.parse(storedBytes);
    assert.equal(parsed.invocations.length, 1);
    assert.equal(parsed.errors.length, 0);
    assert.deepEqual(readStored(), {
        version: 1,
        lastValue: 'auto-released',
        records: [
            { version: 1, value: 'auto-released', background: false, receipt: 'receipt-1' },
        ],
    });
});
