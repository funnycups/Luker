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
// re-tokenized growing accumulators. If the worker is unavailable or rejects,
// we throw; client-tokenizers/index.js converts that to a null return and
// tokenizers.js routes the count through the server tokenizer endpoint.

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

function ensureWorker() {
    if (workerDisabled || typeof Worker === 'undefined') return null;
    if (workerInstance) return workerInstance;

    try {
        workerInstance = new Worker(
            new URL('../workers/sentencepiece-worker.js', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        console.error('[sentencepiece-adapter] Failed to spawn worker; sentencepiece counts will route through the server', error);
        workerDisabled = true;
        workerInstance = null;
        return null;
    }

    workerInstance.addEventListener('message', (event) => {
        const id = Number(event?.data?.id);
        if (!Number.isInteger(id)) return;
        const pending = workerPending.get(id);
        if (!pending) return;
        workerPending.delete(id);
        if (event.data?.ok) {
            pending.resolve(event.data.result);
        } else {
            pending.reject(new Error(String(event.data?.error || 'sentencepiece worker failed')));
        }
    });

    workerInstance.addEventListener('error', (event) => {
        console.error('[sentencepiece-adapter] Worker crashed; sentencepiece counts will route through the server', event?.error || event);
        const crashErr = event?.error || new Error('sentencepiece worker crashed');
        for (const [, pending] of workerPending) {
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
        workerPending.set(id, { resolve, reject });
        try {
            worker.postMessage({ id, op, ...payload });
        } catch (error) {
            workerPending.delete(id);
            reject(error);
        }
    });
}

// ---- Public surface ------------------------------------------------------

export function countMessages(model, messages) {
    return callWorker('countMessages', { model, messages });
}

export function encode(model, text) {
    return callWorker('encode', { model, text });
}

export function decode(model, ids) {
    return callWorker('decode', { model, ids });
}

export function supports(model) {
    return Object.hasOwn(MODEL_URLS, model);
}
