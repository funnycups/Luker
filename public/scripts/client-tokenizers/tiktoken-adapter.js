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

const tiktokenLib = () => import('/lib/tokenizers/js-tiktoken-bundle.js');
const rankModule = encodingName => import(`/lib/tokenizers/js-tiktoken/ranks/${encodingName}.js`);

// Map an OpenAI-ish model name to the encoding it uses.
function modelToEncoding(model) {
    if (!model) return 'cl100k_base';
    if (model.startsWith('gpt-4o') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-5')) return 'o200k_base';
    if (model.startsWith('gpt-4') || model.startsWith('gpt-3.5')) return 'cl100k_base';
    if (model.startsWith('text-davinci') || model.startsWith('code-')) return 'p50k_base';
    return 'cl100k_base';
}

const encoderCache = new Map();      // encodingName -> Promise<Tiktoken>

async function getEncoder(encodingName) {
    if (encoderCache.has(encodingName)) return encoderCache.get(encodingName);
    const promise = (async () => {
        const [{ Tiktoken }, rankMod] = await Promise.all([
            tiktokenLib(),
            rankModule(encodingName),
        ]);
        return new Tiktoken(rankMod.default);
    })();
    encoderCache.set(encodingName, promise);
    return promise;
}

export async function countMessages(model, messages) {
    const enc = await getEncoder(modelToEncoding(model));
    // Mirror src/endpoints/tokenizers.js:984-1010 — including the gpt-3.5-turbo-0301 quirks
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

export async function encode(model, text) {
    const enc = await getEncoder(modelToEncoding(model));
    return enc.encode(String(text ?? ''));
}

export async function decode(model, ids) {
    const enc = await getEncoder(modelToEncoding(model));
    return enc.decode(ids);
}

export function supports(model) {
    return typeof model === 'string' && (
        model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') ||
        model.startsWith('o4')   || model.startsWith('text-davinci') || model.startsWith('code-')
    );
}
