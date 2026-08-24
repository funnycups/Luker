// public/scripts/client-tokenizers/tiktoken-adapter.js
//
// js-tiktoken is pure ESM but its chunk module imports `base64-js` as a bare
// specifier that the browser cannot resolve. The server synthesizes a
// self-contained bundle at /lib/tokenizers/js-tiktoken-bundle.js. The rank
// tables (cl100k_base etc.) are plain `export default {...}` ESM modules and
// load as-is from the static mount.
//
// Replicates the wrapping arithmetic in src/endpoints/tokenizers.js:984-1010
// (countOpenAIMessagesTokenCount tiktoken branch).
//
// All tokenization runs in a dedicated module worker
// (workers/tiktoken-worker.js). js-tiktoken's `bytePairMerge` is a pure-JS
// O(token^2) pass; a mobile trace of a long-chat prompt showed a single
// PromptManager idle-callback pinning the renderer for 34s doing nothing but
// tiktoken encode. Moving it off-thread matches sentencepiece-adapter.js and
// web-tokenizer-adapter.js. When Worker is unavailable or the worker crashes
// we fall back to synchronous main-thread encode so counts never silently
// vanish (routing through the server would be worse for a client tokenizer
// that has no server counterpart for these encodings).

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
            new URL('../workers/tiktoken-worker.js', import.meta.url),
            { type: 'module' },
        );
    } catch (error) {
        console.warn('[tiktoken-adapter] Failed to spawn worker, falling back to main-thread tokenizer', error);
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
            pending.reject(new Error(String(event.data?.error || 'tiktoken worker failed')));
        }
    });

    workerInstance.addEventListener('error', (event) => {
        console.warn('[tiktoken-adapter] Worker crashed, disabling and falling back', event?.error || event);
        const crashErr = event?.error || new Error('tiktoken worker crashed');
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
    if (!worker) return Promise.reject(new Error('tiktoken worker unavailable'));

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

// ---- Shared model->encoding mapping --------------------------------------

// Keep in sync with workers/tiktoken-worker.js modelToEncoding.
function modelToEncoding(model) {
    if (!model) return 'cl100k_base';
    if (model.startsWith('gpt-4o') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-5')) return 'o200k_base';
    if (model.startsWith('gpt-4') || model.startsWith('gpt-3.5')) return 'cl100k_base';
    if (model.startsWith('text-davinci') || model.startsWith('code-')) return 'p50k_base';
    return 'cl100k_base';
}

// ---- In-thread fallback (also exercised on worker errors) ----------------

const tiktokenLib = () => import('/lib/tokenizers/js-tiktoken-bundle.js');
const rankModule = encodingName => import(`/lib/tokenizers/js-tiktoken/ranks/${encodingName}.js`);

const fallbackEncoderCache = new Map(); // encodingName -> Promise<Tiktoken>

function getFallbackEncoder(encodingName) {
    if (fallbackEncoderCache.has(encodingName)) return fallbackEncoderCache.get(encodingName);
    const promise = (async () => {
        const [{ Tiktoken }, rankMod] = await Promise.all([
            tiktokenLib(),
            rankModule(encodingName),
        ]);
        return new Tiktoken(rankMod.default);
    })();
    fallbackEncoderCache.set(encodingName, promise);
    promise.catch(() => fallbackEncoderCache.delete(encodingName));
    return promise;
}

async function countMessagesFallback(model, messages) {
    const enc = await getFallbackEncoder(modelToEncoding(model));
    // Mirrors handleCountMessages in workers/tiktoken-worker.js and the server
    // wrapping arithmetic in src/endpoints/tokenizers.js:984-1010.
    const tokensPerName    = model.includes('gpt-3.5-turbo-0301') ? -1 : 1;
    const tokensPerMessage = model.includes('gpt-3.5-turbo-0301') ?  4 : 3;
    const tokensPadding    = 3;
    let n = 0;
    for (const msg of messages) {
        n += tokensPerMessage;
        for (const [k, v] of Object.entries(msg)) {
            n += enc.encode(String(v ?? '')).length;
            if (k === 'name') n += tokensPerName;
        }
    }
    n += tokensPadding;
    if (model.includes('gpt-3.5-turbo-0301')) n += 9;
    return n;
}

async function encodeFallback(model, text) {
    const enc = await getFallbackEncoder(modelToEncoding(model));
    return enc.encode(String(text ?? ''));
}

async function decodeFallback(model, ids) {
    const enc = await getFallbackEncoder(modelToEncoding(model));
    return enc.decode(ids);
}

// ---- Public surface ------------------------------------------------------

export async function countMessages(model, messages) {
    try {
        return await callWorker('countMessages', { model, messages });
    } catch (error) {
        console.warn(`[tiktoken-adapter] worker countMessages failed for ${model}, falling back`, error);
        return countMessagesFallback(model, messages);
    }
}

export async function encode(model, text) {
    try {
        return await callWorker('encode', { model, text });
    } catch (error) {
        console.warn(`[tiktoken-adapter] worker encode failed for ${model}, falling back`, error);
        return encodeFallback(model, text);
    }
}

export async function decode(model, ids) {
    try {
        return await callWorker('decode', { model, ids });
    } catch (error) {
        console.warn(`[tiktoken-adapter] worker decode failed for ${model}, falling back`, error);
        return decodeFallback(model, ids);
    }
}

// Catch-all. tiktoken cl100k_base is what src/endpoints/tokenizers.js falls
// back to when its own getTokenizerModel() keyword table misses (see the
// generic branch at src/endpoints/tokenizers.js:997-1023 — same 3/1/3 padding,
// same encoding via getTiktokenTokenizer('gpt-3.5-turbo')). Handling the
// unknown case here keeps count-batch strictly a "client tokenizer threw"
// fallback instead of a "model name not in our keyword list" fallback, so
// ordinary sync counting for OpenAI-compatible providers (CUSTOM with kimi,
// moonshot, self-hosted qwen, …) stays local.
//
// Order matters in index.js's ADAPTERS: webTokenizer and sentencepiece must
// come first so canonical keys ('qwen2', 'claude', 'llama3', …) hit their
// accurate adapter; tiktoken is last so it only takes what nobody else claimed.
export function supports(model) {
    return typeof model === 'string' && model.length > 0;
}
