// Module worker that runs @agnai/sentencepiece-js off the main thread.
//
// Lives alongside the classic tokenizer-worker.js — separate file because
// the sentencepiece bundle is ESM (synthesized at
// /lib/tokenizers/sentencepiece-js-bundle.js by src/server-main.js:439)
// and module workers cannot use importScripts(). Module-worker precedent in
// this repo: public/scripts/extensions/tts/kokoro.js:91.
//
// Wire protocol matches tokenizer-worker.js:
//   in:  { id, op: 'countMessages', model, messages }
//        { id, op: 'encode',        model, text }
//        { id, op: 'decode',        model, ids }
//   out: { id, ok: true, result }  or  { id, ok: false, error }

const libPromise = () => import('/lib/tokenizers/sentencepiece-js-bundle.js');

// Mirrors MODEL_URLS in client-tokenizers/sentencepiece-adapter.js — keep in sync.
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

function getInstance(model) {
    if (instanceCache.has(model)) return instanceCache.get(model);
    const promise = (async () => {
        const url = MODEL_URLS[model];
        if (!url) throw new Error(`No sentencepiece model URL for "${model}"`);
        // sentencepiece-js's .load() calls fs.readFileSync(url) synchronously
        // inside the wasm init. The bundle wrapper's fs shim (synthesized at
        // src/server-main.js:413-435) reads from a shared Map; prefetch the
        // bytes and stash them before sp.load runs. The `finally` cleanup
        // must stay AFTER `await sp.load`: readFileSync is sync so it always
        // completes before the await resolves — do NOT move the delete into
        // an early-cleanup hook.
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

async function handleCountMessages(model, messages) {
    const sp = await getInstance(model);
    const text = messages.flatMap(x => Object.values(x)).join('\n\n');
    return sp.encodeIds(String(text ?? '')).length;
}

async function handleEncode(model, text) {
    const sp = await getInstance(model);
    return Array.from(sp.encodeIds(String(text ?? '')));
}

async function handleDecode(model, ids) {
    const sp = await getInstance(model);
    return sp.decodeIds(Array.from(ids));
}

self.addEventListener('message', async (event) => {
    const data = event?.data;
    const id = Number(data?.id);
    if (!Number.isInteger(id)) return;

    try {
        let result;
        switch (data?.op) {
            case 'countMessages':
                result = await handleCountMessages(data.model, data.messages || []);
                break;
            case 'encode':
                result = await handleEncode(data.model, data.text);
                break;
            case 'decode':
                result = await handleDecode(data.model, data.ids);
                break;
            default:
                throw new Error(`Unknown sentencepiece-worker op: ${data?.op}`);
        }
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
});
