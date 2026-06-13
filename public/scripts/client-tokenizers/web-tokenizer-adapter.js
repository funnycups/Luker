// public/scripts/client-tokenizers/web-tokenizer-adapter.js
//
// Wraps @agnai/web-tokenizers (Emscripten UMD bundle, 4MB). Mirrors
// src/endpoints/tokenizers.js:547 countWebTokenizerTokens:
//   const convertedPrompt = convertClaudePrompt(messages, false, '', false, false, '', false);
//   const count = tokenizer.encode(convertedPrompt).length;
// `convertClaudePrompt` is ported below from src/prompt-converters.js:115 —
// only the subset reachable with the all-false call args is needed.
//
// All tokenization runs in a dedicated worker (workers/tokenizer-worker.js).
// The WASM encode of a long-chat prompt blocked the main thread for >30s in
// mobile traces; moving it off-thread keeps the UI responsive. A synchronous
// in-thread fallback stays available for environments without Web Workers.

import { loadUmdScript } from './umd-loader.js';

const LIB_URL = '/lib/tokenizers/web-tokenizers/index.js';

// Model name -> tokenizer.json URL on our static mount.
// Matches dispatch in src/endpoints/tokenizers.js:920-982.
// Keep in sync with workers/tokenizer-worker.js TOKENIZER_URLS.
const TOKENIZER_URLS = {
    claude: '/tokenizers/claude.json',
    llama3: '/tokenizers/llama3.json',
    'llama-3': '/tokenizers/llama3.json',
    // Remote-hosted upstream — proxied through ST server (/tokenizers-remote/*)
    // to avoid CORS on browser direct-fetch from GitHub raw.
    qwen2: '/tokenizers-remote/qwen2.json.gz',
    'command-r': '/tokenizers-remote/command-r.json.gz',
    'command-a': '/tokenizers-remote/command-a.json.gz',
    nemo: '/tokenizers-remote/nemo.json.gz',
    deepseek: '/tokenizers-remote/deepseek.json.gz',
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
        workerInstance = new Worker(new URL('../workers/tokenizer-worker.js', import.meta.url));
    } catch (error) {
        console.warn('[web-tokenizer-adapter] Failed to spawn worker, falling back to main-thread tokenizer', error);
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
            pending.reject(new Error(String(event.data?.error || 'tokenizer worker failed')));
        }
    });

    workerInstance.addEventListener('error', (event) => {
        console.warn('[web-tokenizer-adapter] Worker crashed, disabling and falling back', event?.error || event);
        const crashErr = event?.error || new Error('tokenizer worker crashed');
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
    if (!worker) return Promise.reject(new Error('tokenizer worker unavailable'));

    return new Promise((resolve, reject) => {
        const id = ++workerSequence;
        const timeoutId = setTimeout(() => {
            workerPending.delete(id);
            reject(new Error(`tokenizer worker ${op} timed out`));
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

async function fetchTokenizerJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tokenizer fetch failed: ${url} -> ${res.status}`);
    if (url.endsWith('.gz')) {
        const buf = await res.arrayBuffer();
        const ds = new DecompressionStream('gzip');
        const decompressed = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
        return new Uint8Array(decompressed);
    }
    return new Uint8Array(await res.arrayBuffer());
}

async function getFallbackInstance(model) {
    if (fallbackInstanceCache.has(model)) return fallbackInstanceCache.get(model);
    const promise = (async () => {
        const ns = await loadUmdScript(LIB_URL, 'tokenizers');
        const url = TOKENIZER_URLS[model];
        if (!url) throw new Error(`No web-tokenizer URL for model "${model}"`);
        const buf = await fetchTokenizerJson(url);
        return ns.Tokenizer.fromJSON(buf);
    })();
    // Cache the promise so concurrent callers share it. If it rejects, evict
    // so a later call can retry instead of permanently failing.
    fallbackInstanceCache.set(model, promise);
    promise.catch(() => fallbackInstanceCache.delete(model));
    return promise;
}

// Port of src/prompt-converters.js:115 `convertClaudePrompt`, specialized for
// the call shape used at src/endpoints/tokenizers.js:549:
//   convertClaudePrompt(messages, false, '', false, false, '', false)
// With all flags off, only these branches execute. Mutates the messages array
// (matching server behavior); callers pass throwaway copies.
// Kept in sync with workers/tokenizer-worker.js convertClaudePromptForCount.
function convertClaudePromptForCount(messages) {
    if (messages.length > 0) {
        messages.forEach((m) => {
            if (!m.content) m.content = '';
            if (m.tool_calls) m.content += JSON.stringify(m.tool_calls);
        });
        messages[0].role = 'system';
        const firstAssistantIndex = messages.findIndex((message, i) => message.role === 'assistant' && i > 0);
        // withSysPromptSupport && useSystemPrompt both false -> else branch
        messages[0].role = 'user';
        if (firstAssistantIndex > 0) {
            messages[firstAssistantIndex - 1].role =
                firstAssistantIndex - 1 !== 0 && messages[firstAssistantIndex - 1].role === 'user'
                    ? 'FixHumMsg'
                    : messages[firstAssistantIndex - 1].role;
        }
    }
    return messages.map((v, i) => {
        const prefix = {
            'assistant': '\n\nAssistant: ',
            'user': '\n\nHuman: ',
            'system': i === 0
                ? ''
                : v.name === 'example_assistant'
                    ? '\n\nA: '
                    : v.name === 'example_user'
                        ? '\n\nH: '
                        : '\n\n',
            'FixHumMsg': '\n\nFirst message: ',
        }[v.role] ?? '';
        return `${prefix}${v.name && v.role !== 'system' ? `${v.name}: ` : ''}${v.content}`;
    }).join('');
}

async function countMessagesFallback(model, messages) {
    const tok = await getFallbackInstance(model);
    const copy = messages.map(m => ({ ...m }));
    const prompt = convertClaudePromptForCount(copy);
    const out = tok.encode(prompt);
    if (typeof out?.length === 'number') return out.length;
    return out?.ids?.length ?? 0;
}

async function encodeFallback(model, text) {
    const tok = await getFallbackInstance(model);
    const out = tok.encode(String(text ?? ''));
    if (typeof out?.length === 'number') return Array.from(out);
    return Array.from(out?.ids ?? []);
}

async function decodeFallback(model, ids) {
    const tok = await getFallbackInstance(model);
    return tok.decode(Array.from(ids));
}

// ---- Public surface ------------------------------------------------------

export async function countMessages(model, messages) {
    try {
        return await callWorker('countMessages', { model, messages });
    } catch (error) {
        console.warn(`[web-tokenizer-adapter] worker countMessages failed for ${model}, falling back`, error);
        return countMessagesFallback(model, messages);
    }
}

export async function encode(model, text) {
    try {
        return await callWorker('encode', { model, text });
    } catch (error) {
        console.warn(`[web-tokenizer-adapter] worker encode failed for ${model}, falling back`, error);
        return encodeFallback(model, text);
    }
}

export async function decode(model, ids) {
    try {
        return await callWorker('decode', { model, ids });
    } catch (error) {
        console.warn(`[web-tokenizer-adapter] worker decode failed for ${model}, falling back`, error);
        return decodeFallback(model, ids);
    }
}

export function supports(model) {
    return Object.hasOwn(TOKENIZER_URLS, model);
}
