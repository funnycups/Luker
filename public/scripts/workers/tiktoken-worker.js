// Module worker that runs js-tiktoken off the main thread.
//
// Companion to tokenizer-worker.js (web-tokenizers, classic worker via
// importScripts) and sentencepiece-worker.js (module worker). js-tiktoken's
// server-synthesized bundle at /lib/tokenizers/js-tiktoken-bundle.js is pure
// ESM (see src/server-main.js:409), so this worker is module-type and pulls
// it in via dynamic import.
//
// Why this exists: `bytePairMerge` inside js-tiktoken is a pure-JS O(token^2)
// pass. Mobile traces of a long-chat prompt showed a single PromptManager
// idle-callback pinning the renderer for 34s doing nothing but tiktoken
// encode; the sibling countMessages helpers were already off-thread and this
// one wasn't. Moving it here matches the other two adapters.
//
// Wire protocol mirrors tokenizer-worker.js / sentencepiece-worker.js:
//   in:  { id, op: 'countMessages', model, messages }
//        { id, op: 'encode',        model, text }
//        { id, op: 'decode',        model, ids }
//   out: { id, ok: true, result }  or  { id, ok: false, error }

const tiktokenLib = () => import('/lib/tokenizers/js-tiktoken-bundle.js');
const rankModule = encodingName => import(`/lib/tokenizers/js-tiktoken/ranks/${encodingName}.js`);

// Mirrors modelToEncoding in client-tokenizers/tiktoken-adapter.js — keep in sync.
function modelToEncoding(model) {
    if (!model) return 'cl100k_base';
    if (model.startsWith('gpt-4o') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-5')) return 'o200k_base';
    if (model.startsWith('gpt-4') || model.startsWith('gpt-3.5')) return 'cl100k_base';
    if (model.startsWith('text-davinci') || model.startsWith('code-')) return 'p50k_base';
    return 'cl100k_base';
}

const encoderCache = new Map(); // encodingName -> Promise<Tiktoken>

function getEncoder(encodingName) {
    if (encoderCache.has(encodingName)) return encoderCache.get(encodingName);
    const promise = (async () => {
        const [{ Tiktoken }, rankMod] = await Promise.all([
            tiktokenLib(),
            rankModule(encodingName),
        ]);
        return new Tiktoken(rankMod.default);
    })();
    encoderCache.set(encodingName, promise);
    promise.catch(() => encoderCache.delete(encodingName));
    return promise;
}

// Mirrors countMessages in client-tokenizers/tiktoken-adapter.js — same
// wrapping arithmetic as src/endpoints/tokenizers.js:984-1010.
async function handleCountMessages(model, messages) {
    const enc = await getEncoder(modelToEncoding(model));
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

async function handleEncode(model, text) {
    const enc = await getEncoder(modelToEncoding(model));
    return enc.encode(String(text ?? ''));
}

async function handleDecode(model, ids) {
    const enc = await getEncoder(modelToEncoding(model));
    return enc.decode(ids);
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
                throw new Error(`Unknown tiktoken-worker op: ${data?.op}`);
        }
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
});
