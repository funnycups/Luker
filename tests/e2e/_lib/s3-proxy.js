import http from 'node:http';
import https from 'node:https';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable, Transform } from 'node:stream';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

/** A streaming, one-shot fault fixture. Every non-redirect response is from
 * real storage. Re-signing changes only routing and explicitly stripped headers. */
export async function startS3Proxy({ upstream, credentials, region }) {
    const target = new URL(upstream);
    const sdk = new S3Client({ endpoint: upstream, region, credentials, forcePathStyle: true, maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: 'WHEN_REQUIRED', requestHandler: { connectionTimeout: 0, requestTimeout: 0, socketTimeout: 0 } });
    const signer = await sdk.config.signer();
    const requests = [];
    const faults = [];
    const waiters = [];
    const sockets = new Set();
    const outbound = new Set();
    let disposed = false;
    function matches(record, match) {
        return record.method === match.method
            && (match.keyPrefix === undefined || record.relativeKey.startsWith(match.keyPrefix))
            && (match.relativeKey === undefined || record.relativeKey === match.relativeKey)
            && (match.keySuffix === undefined || record.relativeKey.endsWith(match.keySuffix));
    }
    async function handle(req, res) {
        const pathname = decodeURIComponent(new URL(req.url, 'http://proxy').pathname);
        const relativeKey = pathname.split('/').slice(2).join('/');
        const record = { id: requests.length + 1, method: req.method, relativeKey, headers: { ...req.headers }, bytesObserved: 0, bytesForwarded: 0, upstreamStatus: null, responseDelivered: false, closed: false };
        requests.push(record);
        res.on('finish', () => { record.responseDelivered = true; });
        res.on('close', () => { record.closed = true; });
        for (const waiter of [...waiters]) {
            if (matches(record, waiter.match) && requests.filter(candidate => matches(candidate, waiter.match)).length >= (waiter.match.attempt ?? 1)) {
                waiter.resolve(record); waiters.splice(waiters.indexOf(waiter), 1);
            }
        }
        const fault = faults.find(entry => {
            if (entry.used || !matches(record, entry.rule.match)) return false;
            entry.attempts++;
            return entry.rule.match.attempt === undefined || entry.attempts === entry.rule.match.attempt;
        });
        if (fault) {
            fault.used = !fault.rule.repeat;
            fault.abort = () => res.destroy();
            if (!fault.rule.hold) fault.reached.resolve(record);
        }
        const gate = async point => {
            if (fault?.rule.hold === point) { fault.reached.resolve(record); await fault.released.promise; }
        };
        await gate('before-forward');
        if (disposed || res.destroyed) return;
        if (fault?.rule.dropConnection) { res.destroy(); return; }
        if (fault?.rule.redirectTo) { res.writeHead(307, { location: fault.rule.redirectTo }); res.end(); return; }
        const headers = { ...req.headers };
        const earlyConditional = fault?.rule.hold === 'after-first-body-chunk' && req.method === 'PUT' && headers['if-none-match'] === '*';
        if (earlyConditional) {
            await new Promise(resolve => req.once('data', chunk => {
                record.bytesObserved += chunk.length;
                req.pause();
                fault.reached.resolve(record);
                resolve();
            }));
            await fault.released.promise;
            if (disposed || res.destroyed) return;
            // RustFS validates ordinary conditional requests after reading their
            // body. Send a fixture-owned Buffer command to obtain its actual
            // early rejection while the caller's source remains pending.
            const command = new PutObjectCommand({ Bucket: pathname.split('/')[1], Key: relativeKey, Body: Buffer.alloc(0), ContentLength: 0, IfNoneMatch: fault.rule.stripHeaders?.includes('if-none-match') ? undefined : '*' });
            let captured;
            command.middlewareStack.add(next => async args => {
                const result = await next(args);
                const chunks = [];
                for await (const chunk of result.response.body) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                captured = { status: result.response.statusCode, headers: result.response.headers, bytes };
                result.response.body = Readable.from([bytes]);
                return result;
            }, { name: 'captureRealResponse', step: 'deserialize', priority: 'low' });
            try { await sdk.send(command); } catch (error) { if (!captured) throw error; }
            record.upstreamStatus = captured.status;
            await gate('after-upstream-response');
            if (disposed || res.destroyed) return;
            res.writeHead(captured.status, captured.headers);
            res.end(captured.bytes);
            return;
        }
        const stripped = fault?.rule.stripHeaders ?? [];
        for (const name of stripped) delete headers[name];
        const rewritten = [];
        if (fault?.rule.rejectQuotedIfMatch && /^".*"$/.test(headers['if-match'] ?? '')) {
            // A provider that parses only an unquoted ETag rejects the quoted
            // value. Substitute a different well-formed ETag so the response
            // and the status still come from real storage.
            headers['if-match'] = `"${'0'.repeat(32)}"`;
            rewritten.push('if-match');
        }
        // Unmodified requests retain their signed Host/path exactly. A reverse
        // proxy may dial a different address without altering the signed wire.
        if (stripped.length || rewritten.length) {
            delete headers.authorization;
            const parsed = new URL(req.url, 'http://proxy');
            const query = {};
            for (const [name, value] of parsed.searchParams) {
                query[name] = Object.hasOwn(query, name) ? [].concat(query[name], value) : value;
            }
            const signed = await signer.sign({ method: req.method, protocol: target.protocol, hostname: req.headers.host.split(':')[0], path: parsed.pathname, headers, query, body: req }, { signingRegion: region, signingService: 's3' });
            Object.assign(headers, signed.headers);
        }
        // Corrupt only the forwarded signature; RustFS supplies the real
        // authentication failure response rather than a fabricated status.
        if (fault?.rule.invalidSignature) headers.authorization = String(headers.authorization).replace(/Signature=[a-f0-9]+/, `Signature=${'0'.repeat(64)}`);
        await new Promise(resolve => {
            const upstreamRequest = (target.protocol === 'https:' ? https : http).request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, agent: false }, async response => {
                record.upstreamStatus = response.statusCode;
                record.upstreamHeaders = { ...response.headers };
                await gate('after-upstream-response');
                if (disposed || res.destroyed) { response.destroy(); resolve(); return; }
                if (fault?.rule.dropResponseAfterUpstreamSuccess && response.statusCode >= 200 && response.statusCode < 300) {
                    response.resume(); res.destroy(); resolve(); return;
                }
                res.writeHead(response.statusCode, response.headers);
                response.on('error', () => res.destroy());
                if (req.method === 'GET') response.on('data', chunk => { record.bytesObserved += chunk.length; });
                if (req.method === 'GET' && fault?.rule.hold === 'after-first-body-chunk') {
                    let firstChunk = true;
                    const barrier = new Transform({ transform(chunk, _encoding, callback) {
                        if (!firstChunk) { callback(null, chunk); return; }
                        firstChunk = false;
                        res.write(chunk);
                        fault.reached.resolve(record);
                        fault.released.promise.then(() => callback());
                    } });
                    response.pipe(barrier).pipe(res);
                    res.once('close', () => { barrier.destroy(); response.destroy(); });
                } else response.pipe(res);
                response.on('end', resolve);
            });
            outbound.add(upstreamRequest);
            upstreamRequest.on('close', () => outbound.delete(upstreamRequest));
            upstreamRequest.on('error', () => { res.destroy(); resolve(); });
            res.on('close', () => { upstreamRequest.destroy(); resolve(); });
            req.on('error', () => upstreamRequest.destroy());
            let first = true;
            req.on('data', chunk => {
                record.bytesObserved += chunk.length;
                // Head payload capture is read-only evidence of exactly what
                // the original caller published, never a replacement body.
                if (req.method === 'PUT' && relativeKey.endsWith('/head')) record.body = Buffer.concat([record.body ?? Buffer.alloc(0), chunk]);
                if (first && ['after-first-body-chunk', 'after-first-forwarded-body-chunk'].includes(fault?.rule.hold)) {
                    first = false;
                    req.pause();
                    upstreamRequest.write(chunk);
                    record.bytesForwarded += chunk.length;
                    fault.reached.resolve(record);
                    fault.released.promise.then(() => { if (!disposed) req.resume(); });
                } else {
                    record.bytesForwarded += chunk.length;
                    if (!upstreamRequest.write(chunk)) {
                        req.pause(); upstreamRequest.once('drain', () => req.resume());
                    }
                }
            });
            req.on('end', () => upstreamRequest.end());
        });
    }
    const server = http.createServer((req, res) => { handle(req, res).catch(() => res.destroy()); });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requests,
        addFault(rule) {
            const reached = deferred(), released = deferred();
            const entry = { rule, reached, released, used: false, attempts: 0 };
            faults.push(entry);
            return { reached: reached.promise, release: () => released.resolve(), cancel: () => { entry.used = true; entry.abort?.(); released.resolve(); } };
        },
        waitForRequest(match) {
            const found = requests.filter(record => matches(record, match))[((match.attempt ?? 1) - 1)];
            if (found) return Promise.resolve(found);
            const waiter = deferred();
            waiters.push({ match, resolve: waiter.resolve });
            return waiter.promise;
        },
        async close() {
            disposed = true;
            for (const fault of faults) fault.released.resolve();
            for (const request of outbound) request.destroy();
            for (const socket of sockets) socket.destroy();
            sdk.destroy();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
