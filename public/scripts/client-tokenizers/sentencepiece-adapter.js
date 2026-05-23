// public/scripts/client-tokenizers/sentencepiece-adapter.js
//
// Wraps @agnai/sentencepiece-js (Emscripten WASM, served as ESM-wrapped CJS
// via /lib/tokenizers/sentencepiece-js-bundle.js). Mirrors server-side
// countSentencepieceArrayTokens in src/endpoints/tokenizers.js:393:
//   const jsonBody = array.flatMap(x => Object.values(x)).join('\n\n');
//   const ids = instance.encodeIds(jsonBody);
//   return ids.length;

const libPromise = () => import('/lib/tokenizers/sentencepiece-js-bundle.js');

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

const instanceCache = new Map();

async function getInstance(model) {
    if (instanceCache.has(model)) return instanceCache.get(model);
    const promise = (async () => {
        const url = MODEL_URLS[model];
        if (!url) throw new Error(`No sentencepiece model URL for "${model}"`);
        // Sentencepiece-js's .load() calls fs.readFileSync(url) synchronously
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
    instanceCache.set(model, promise);
    promise.catch(() => instanceCache.delete(model));
    return promise;
}

export async function countMessages(model, messages) {
    const sp = await getInstance(model);
    const text = messages.flatMap(x => Object.values(x)).join('\n\n');
    const ids = sp.encodeIds(String(text ?? ''));
    return ids.length;
}

export async function encode(model, text) {
    const sp = await getInstance(model);
    return Array.from(sp.encodeIds(String(text ?? '')));
}

export async function decode(model, ids) {
    const sp = await getInstance(model);
    return sp.decodeIds(Array.from(ids));
}

export function supports(model) {
    return Object.hasOwn(MODEL_URLS, model);
}
