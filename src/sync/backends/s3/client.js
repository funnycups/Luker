import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createSyncAgents } from '../../net-guard.js';
import { syncError } from '../../errors.js';
import { getConfigValue } from '../../../util.js';
import { normalizeS3Settings, objectKey } from './layout.js';

function safeError(error) {
    const status = error?.$metadata?.httpStatusCode;
    const policy = ['SYNC_PRIVATE_ADDRESS', 'SYNC_DNS_ERROR', 'SYNC_AGENT_DESTROYED'];
    const code = policy.includes(error?.code) ? error.code
        : status === 412 || status === 409 ? 'PRECONDITION_FAILED'
            : error?.name === 'NoSuchKey' && status === 404 ? 'S3_OBJECT_NOT_FOUND'
                : error?.name === 'NoSuchBucket' ? 'BUCKET_NOT_FOUND'
                    : status === 401 || status === 403 ? 'AUTH_FAILED'
                        : status ? 'S3_PROVIDER_ERROR' : 'UNREACHABLE';
    return Object.assign(syncError(code, code), status ? { $metadata: { httpStatusCode: status } } : {});
}

/** Some S3-compatible services accept only an unquoted ETag in If-Match. */
function ifMatchValue(settings, ifMatch) {
    if (!settings.stripIfMatchQuotes || typeof ifMatch !== 'string') return ifMatch;
    return /^".*"$/.test(ifMatch) ? ifMatch.slice(1, -1) : ifMatch;
}

/** A single-attempt SDK transport. Ownership ends at send settlement for PUT,
 * and at stream completion/destruction for GET. No operation holds a state lock. */
export function createS3Client({ owner, settings: input, network }) {
    const settings = normalizeS3Settings(input);
    const agents = createSyncAgents({
        owner, network,
        enableAccounts: getConfigValue('enableUserAccounts', false, 'boolean'),
        allowPrivateAddressesForUsers: getConfigValue('sync.allowPrivateAddressesForUsers', false, 'boolean'),
    });
    const sdk = new S3Client({
        endpoint: settings.endpoint, region: settings.region, forcePathStyle: settings.forcePathStyle,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: { connectionTimeout: 0, requestTimeout: 0, socketTimeout: 0, httpAgent: agents.httpAgent, httpsAgent: agents.httpsAgent },
    });
    const requests = new Set();
    const bodies = new Map();
    let closed = false;
    let closing;
    function own(body) {
        if (bodies.has(body)) return bodies.get(body);
        const completion = finished(body, { cleanup: true }).catch(() => {}).finally(() => bodies.delete(body));
        bodies.set(body, completion);
        return completion;
    }
    async function send(command, source) {
        const controller = new AbortController();
        let sourceError;
        let finishing = false;
        const onError = () => { sourceError = syncError('S3_SOURCE_ERROR', 'S3 upload source failed'); controller.abort(); };
        const onClose = () => { if (!finishing && !source.readableEnded) onError(); };
        // Install before send: SDK does not own errors emitted before its pipe.
        if (source) { source.on('error', onError); source.on('close', onClose); own(source); }
        let settle;
        const settled = new Promise(resolve => { settle = resolve; });
        const request = { controller, settled };
        requests.add(request);
        try {
            if (closed) throw syncError('S3_TRANSPORT_CLOSED', 'S3 transport is closed');
            if (source?.errored || source?.destroyed) throw syncError('S3_SOURCE_ERROR', 'S3 upload source failed');
            const result = await sdk.send(command, { abortSignal: controller.signal });
            if (sourceError) throw sourceError;
            return result;
        } catch (error) {
            if (sourceError) throw sourceError;
            if (['S3_TRANSPORT_CLOSED', 'S3_SOURCE_ERROR'].includes(error.code)) throw error;
            throw safeError(error);
        } finally {
            if (source) {
                finishing = true;
                source.unpipe();
                const completion = own(source);
                source.destroy();
                await completion;
                source.removeListener('error', onError);
                source.removeListener('close', onClose);
            }
            requests.delete(request);
            settle();
        }
    }
    const target = relativeKey => ({ Bucket: settings.bucket, Key: objectKey(settings, relativeKey) });
    async function read(relativeKey, head) {
        try {
            const result = await send(head ? new HeadObjectCommand(target(relativeKey)) : new GetObjectCommand(target(relativeKey)));
            if (!head) {
                own(result.Body);
                if (closed) {
                    const completion = own(result.Body);
                    result.Body.destroy();
                    await completion;
                    throw syncError('S3_TRANSPORT_CLOSED', 'S3 transport is closed');
                }
            }
            return { ...(head ? {} : { body: result.Body }), etag: result.ETag ?? null, size: result.ContentLength ?? null };
        } catch (error) {
            // HEAD's empty 404 is ambiguous. Verify with GET to distinguish a
            // missing object from a missing bucket without treating auth as absence.
            if (error.$metadata?.httpStatusCode === 404) {
                if (head) {
                    const found = await read(relativeKey, false);
                    if (found) { found.body.destroy(); return { etag: found.etag, size: found.size }; }
                    return null;
                }
                if (error.code === 'S3_OBJECT_NOT_FOUND') return null;
            }
            throw error;
        }
    }
    return {
        get: relativeKey => read(relativeKey, false),
        head: relativeKey => read(relativeKey, true),
        async put(relativeKey, body, { ifMatch, ifNoneMatch, contentLength }) {
            if ((!Buffer.isBuffer(body) && !(body instanceof Readable)) || !Number.isSafeInteger(contentLength) || contentLength < 0
                || (Buffer.isBuffer(body) && body.length !== contentLength)
                || (ifNoneMatch !== undefined && ifNoneMatch !== '*') || (ifMatch !== undefined && typeof ifMatch !== 'string')) {
                throw syncError('S3_SETTINGS_INVALID', 'S3_SETTINGS_INVALID');
            }
            const result = await send(new PutObjectCommand({ ...target(relativeKey), Body: body, ContentLength: contentLength, IfMatch: ifMatchValue(settings, ifMatch), IfNoneMatch: ifNoneMatch }), body instanceof Readable ? body : undefined);
            if (!result.ETag) throw syncError('S3_PROVIDER_ERROR', 'S3 response has no ETag');
            return { etag: result.ETag };
        },
        async delete(relativeKey) { await send(new DeleteObjectCommand(target(relativeKey))); },
        async list(relativePrefix, continuationToken) {
            // List prefixes may end in a separator, unlike object keys.
            if (typeof relativePrefix !== 'string' || (continuationToken !== undefined && typeof continuationToken !== 'string')) {
                throw syncError('S3_SETTINGS_INVALID', 'S3_SETTINGS_INVALID');
            }
            const suffix = relativePrefix.endsWith('/') ? '/' : '';
            const prefix = relativePrefix ? objectKey(settings, relativePrefix.replace(/\/$/, '')) + suffix : settings.prefix ? `${settings.prefix}/` : '';
            const result = await send(new ListObjectsV2Command({ Bucket: settings.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
            const base = settings.prefix ? `${settings.prefix}/` : '';
            return { objects: (result.Contents ?? []).map(item => ({ key: item.Key.slice(base.length), etag: item.ETag ?? null, size: item.Size ?? null })), nextToken: result.NextContinuationToken ?? null };
        },
        close() {
            if (!closing) {
                closed = true;
                for (const request of requests) request.controller.abort();
                for (const body of bodies.keys()) body.destroy();
                agents.destroy();
                sdk.destroy();
                closing = (async () => {
                    await Promise.all([...requests].map(request => request.settled));
                    await Promise.all([...bodies.values()]);
                })();
            }
            return closing;
        },
    };
}

/** Attempt-owned keys make cleanup independent of concurrent setup attempts. */
export async function probeConditionalWrites(transport, { stripIfMatchQuotes = false } = {}) {
    const key = `.probe/${randomBytes(16).toString('hex')}`;
    const body = randomBytes(32);
    const options = { contentLength: body.length };
    const unsupported = () => syncError('CONDITIONAL_WRITES_UNSUPPORTED', 'S3 conditional writes are required');
    async function putProbe(condition) {
        try {
            return await transport.put(key, body, { ...options, ...condition });
        } catch (error) {
            const status = error?.$metadata?.httpStatusCode;
            if (status === 400 || status === 501) throw unsupported();
            throw error;
        }
    }
    async function requireRejected(condition) {
        try { await putProbe(condition); } catch (error) {
            if (error.code === 'CONDITIONAL_WRITES_UNSUPPORTED') throw error;
            const status = error?.$metadata?.httpStatusCode;
            if (status === 412 || status === 409) return;
            throw error;
        }
        throw unsupported();
    }
    try {
        const current = await putProbe({ ifNoneMatch: '*' });
        await requireRejected({ ifNoneMatch: '*' });
        await requireRejected({ ifMatch: '"00000000000000000000000000000000"' });
        try { await putProbe({ ifMatch: current.etag }); } catch (error) {
            if (error.code === 'CONDITIONAL_WRITES_UNSUPPORTED') throw error;
            const status = error?.$metadata?.httpStatusCode;
            if (status === 412 || status === 409) {
                if (!stripIfMatchQuotes && /^".*"$/.test(current.etag)) {
                    throw syncError('S3_IF_MATCH_QUOTES_UNSUPPORTED', 'S3 service requires an unquoted If-Match ETag');
                }
                throw unsupported();
            }
            throw error;
        }
    } finally {
        try { await transport.delete(key); } catch { console.warn('S3 probe cleanup failed'); }
    }
}
