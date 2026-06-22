// public/scripts/client-tokenizers/sentencepiece-adapter.js
//
// Wraps @agnai/sentencepiece-js (Emscripten WASM, served as ESM-wrapped CJS
// via /lib/tokenizers/sentencepiece-js-bundle.js). Mirrors server-side
// countSentencepieceArrayTokens in src/endpoints/tokenizers.js:393:
//   const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
//   const ids = instance.encodeIds(jsonBody);
//   return ids.length;
//
// All tokenization runs in a dedicated module worker
// (workers/sentencepiece-worker.js) so the synchronous WASM encode doesn't
// block the main thread — a single chat with a large bound lorebook was
// observed pinning the renderer for >50s while the worldinfo budget loop
// re-tokenized growing accumulators. An in-thread fallback stays available
// for environments without Web Workers.

const libPromise = () => import('/lib/tokenizers/sentencepiece-js-bundle.js');

// Mirrors MODEL_URLS in workers/sentencepiece-worker.js — keep in sync.
const MODEL_URLS = {
    llama: '/tokenizers/llama.model',
    mistral: '/tokenizers/mistral.model',
    yi: '/tokenizers/yi.model',
    gemma: '/tokenizers/gemma.model',
    // ST aliases gemini to gemma per src/endpoints/tokenizers.js:946
    gemini: '/tokenizers/gemma.model',
    jamba: '/tokenizers/jamba.model',
    nerdstash: '/tokenizers/nerdstash.model',
    nerdstash_v2: '/tokenizers/nerdstash_v2.model',
};

// ---- Worker bridge -------------------------------------------------------

let workerInstance = null;
let workerDisabled = false;
let workerSequence = 0;
const workerPending = new Map();
const WORKER_REQUEST_TIMEOUT_MS = 30000;

function ensureWorker() {
    if (workerDisabled || typeof Worker === 'undefined') return null;
    if (workerInstance) return workerInstance;

    try {
        workerInstance = new Worker(
            new URL('../workers/sentencepiece-worker.js', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        console.warn('[sentencepiece-adapter] Failed to spawn worker, falling back to main-thread tokenizer', error);
        workerDisabled = true;
        workerInstance = null;
        return null;
    }

    workerInstance.addEventListener('message', (event) => {
        const id = Number(event?.data?.id);
        if (!Number.isInteger(id)) return;
        const pending = workerPending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        workerPending.delete(id);
        if (event.data?.ok) {
            pending.resolve(event.data.result);
        } else {
            pending.reject(new Error(String(event.data?.error || 'sentencepiece worker failed')));
        }
    });

    workerInstance.addEventListener('error', (event) => {
        console.warn('[sentencepiece-adapter] Worker crashed, disabling and falling back', event?.error || event);
        const crashErr = event?.error || new Error('sentencepiece worker crashed');
        for (const [, pending] of workerPending) {
            clearTimeout(pending.timeoutId);
            pending.reject(crashErr);
        }
        workerPending.clear();
        try { workerInstance?.terminate(); } catch { /* ignore */ }
        workerInstance = null;
        workerDisabled = true;
    });

    return workerInstance;
}

function callWorker(op, payload) {
    const worker = ensureWorker();
    if (!worker) return Promise.reject(new Error('sentencepiece worker unavailable'));

    return new Promise((resolve, reject) => {
        const id = ++workerSequence;
        const timeoutId = setTimeout(() => {
            workerPending.delete(id);
            reject(new Error(`sentencepiece worker ${op} timed out`));
        }, WORKER_REQUEST_TIMEOUT_MS);
        workerPending.set(id, { resolve, reject, timeoutId });
        try {
            worker.postMessage({ id, op, ...payload });
        } catch (error) {
            clearTimeout(timeoutId);
            workerPending.delete(id);
            reject(error);
        }
    });
}

// ---- In-thread fallback (also exercised on worker errors) ----------------

const fallbackInstanceCache = new Map();

async function getFallbackInstance(model) {
    if (fallbackInstanceCache.has(model)) return fallbackInstanceCache.get(model);
    const promise = (async () => {
        const url = MODEL_URLS[model];
        if (!url) throw new Error(`No sentencepiece model URL for "${model}"`);
        // sentencepiece-js's .load() calls fs.readFileSync(url) synchronously
        // inside the wasm init. The bundle wrapper's fs shim reads from a
        // shared Map; we prefetch the bytes and stash them before sp.load runs.
        const { SentencePieceProcessor, __spFileCache } = await libPromise();
        const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
        __spFileCache.set(url, buf);
        try {
            const sp = new SentencePieceProcessor();
            await sp.load(url);
            return sp;
        } finally {
            __spFileCache.delete(url);
        }
    })();
    fallbackInstanceCache.set(model, promise);
    promise.catch(() => fallbackInstanceCache.delete(model));
    return promise;
}

async function countMessagesFallback(model, messages) {
    const sp = await getFallbackInstance(model);
    const text = messages.flatMap(x => Object.values(x)).join('\n\n');
    return sp.encodeIds(String(text ?? '')).length;
}

async function encodeFallback(model, text) {
    const sp = await getFallbackInstance(model);
    return Array.from(sp.encodeIds(String(text ?? '')));
}

async function decodeFallback(model, ids) {
    const sp = await getFallbackInstance(model);
    return sp.decodeIds(Array.from(ids));
}

// ---- Public surface ------------------------------------------------------

export async function countMessages(model, messages) {
    try {
        return await callWorker('countMessages', { model, messages });
    } catch (error) {
        console.warn(`[sentencepiece-adapter] worker countMessages failed for ${model}, falling back`, error);
        return countMessagesFallback(model, messages);
    }
}

export async function encode(model, text) {
    try {
        return await callWorker('encode', { model, text });
    } catch (error) {
        console.warn(`[sentencepiece-adapter] worker encode failed for ${model}, falling back`, error);
        return encodeFallback(model, text);
    }
}

export async function decode(model, ids) {
    try {
        return await callWorker('decode', { model, ids });
    } catch (error) {
        console.warn(`[sentencepiece-adapter] worker decode failed for ${model}, falling back`, error);
        return decodeFallback(model, ids);
    }
}

export function supports(model) {
    return Object.hasOwn(MODEL_URLS, model);
}
