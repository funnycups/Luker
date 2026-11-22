// SPDX-License-Identifier: AGPL-3.0-or-later

import { openTransientSession } from '../../../lib/transient-session.js';
import { fetchReferenceImage, promoteLocalReferenceImage } from '../character-sources-client.js';
import { normalizeLocalImagePath } from '../media-path.js';
import { i18n } from './i18n.js';

function readDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

export function createTempMediaTracker(context) {
    const controller = new AbortController();
    const pending = new Set();
    let opening = null;
    let session = null;
    let closing = false;
    let cleanupPromise = null;

    async function ready() {
        controller.signal.throwIfAborted();
        if (!opening) {
            opening = openTransientSession(context, { abortSignal: controller.signal }).then(value => {
                session = value;
                value.closed.then(() => controller.abort(new DOMException('Temporary media connection closed.', 'AbortError')));
                return value;
            }, error => {
                opening = null;
                throw error;
            });
        }
        return opening;
    }

    function run(action) {
        const operation = (async () => {
            if (closing) throw new DOMException('Temporary media session is closing.', 'AbortError');
            const owner = await ready();
            controller.signal.throwIfAborted();
            return action(owner);
        })();
        pending.add(operation);
        const finished = () => pending.delete(operation);
        operation.then(finished, finished);
        return operation;
    }

    function signalFor(signal) {
        return signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    }

    async function post(owner, url, data) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { ...context.getRequestHeaders(), ...owner.requestHeaders() },
            body: JSON.stringify(data),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status} — ${await response.text()}`);
        return response.json();
    }

    async function waitForIdle() {
        while (pending.size) await Promise.allSettled([...pending]);
    }

    return {
        ready,
        get sessionId() { return session?.sessionId; },
        fetchReferenceImage(args) {
            return run(owner => {
                const options = {
                    ...args,
                    context,
                    staging: true,
                    transientSessionId: owner.sessionId,
                    abortSignal: signalFor(args.abortSignal),
                };
                return /^https?:\/\//i.test(args.imageUrl)
                    ? fetchReferenceImage(options)
                    : promoteLocalReferenceImage({ ...options, sourcePath: args.imageUrl });
            });
        },
        generate(prompt, options = {}) {
            return run(async owner => {
                const result = await context.imageGeneration.generate({
                    ...options,
                    prompt,
                    signal: signalFor(options.signal),
                    attribution: 'none',
                    skipActivityTracking: true,
                    transientSessionId: owner.sessionId,
                });
                return result.imagePath;
            });
        },
        upload(file) {
            return run(async owner => {
                const encoded = await readDataUrl(file);
                const image = /^data:image\/([^;,]+);base64,(.*)$/s.exec(encoded);
                if (!image) throw new Error(i18n('Select an image file.'));
                const result = await post(owner, '/api/images/upload', {
                    format: image[1],
                    image: image[2],
                });
                return result.path;
            });
        },
        preview(imagePath) {
            return run(async owner => {
                const response = await fetch(imagePath, {
                    headers: { ...context.getRequestHeaders(), ...owner.requestHeaders() },
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(`${imagePath}: HTTP ${response.status} — ${await response.text()}`);
                return readDataUrl(await response.blob());
            });
        },
        waitForIdle,
        promote(paths, { profileId, namespace }) {
            return run(owner => post(owner, '/api/sd/character-sources/promote-staged', {
                paths: paths.filter(imagePath => normalizeLocalImagePath(imagePath).startsWith('/user/images/_sandbox_tmp/')),
                profileId,
                namespace,
            }));
        },
        rollback(promotionId) {
            return run(owner => post(owner, '/api/sd/character-sources/rollback-staged-promotion', { promotionId }));
        },
        complete(promotionId) {
            return run(owner => post(owner, '/api/sd/character-sources/complete-staged-promotion', { promotionId }));
        },
        cleanup() {
            if (!cleanupPromise) {
                closing = true;
                controller.abort(new DOMException('Temporary media session closed by its owner.', 'AbortError'));
                cleanupPromise = (async () => {
                    await waitForIdle();
                    if (opening && !session) {
                        try {
                            await opening;
                        } catch (error) {
                            if (error.name !== 'AbortError') throw error;
                        }
                    }
                    if (session) await session.close();
                })().catch(error => {
                    cleanupPromise = null;
                    throw error;
                });
            }
            return cleanupPromise;
        },
    };
}
