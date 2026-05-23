// public/scripts/client-tokenizers/web-tokenizer-adapter.js
//
// Wraps @agnai/web-tokenizers (Emscripten UMD bundle, 4MB). Mirrors
// src/endpoints/tokenizers.js:547 countWebTokenizerTokens:
//   const convertedPrompt = convertClaudePrompt(messages, false, '', false, false, '', false);
//   const count = tokenizer.encode(convertedPrompt).length;
// `convertClaudePrompt` is ported below from src/prompt-converters.js:115 —
// only the subset reachable with the all-false call args is needed.

import { loadUmdScript } from './umd-loader.js';

const LIB_URL = '/lib/tokenizers/web-tokenizers/index.js';

// Model name -> tokenizer.json URL on our static mount.
// Matches dispatch in src/endpoints/tokenizers.js:920-982.
const TOKENIZER_URLS = {
    claude:      '/tokenizers/claude.json',
    llama3:      '/tokenizers/llama3.json',
    'llama-3':   '/tokenizers/llama3.json',
    // Remote-hosted upstream — proxied through ST server (/tokenizers-remote/*)
    // to avoid CORS on browser direct-fetch from GitHub raw.
    qwen2:       '/tokenizers-remote/qwen2.json.gz',
    'command-r': '/tokenizers-remote/command-r.json.gz',
    'command-a': '/tokenizers-remote/command-a.json.gz',
    nemo:        '/tokenizers-remote/nemo.json.gz',
    deepseek:    '/tokenizers-remote/deepseek.json.gz',
};

const instanceCache = new Map();

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

async function getInstance(model) {
    if (instanceCache.has(model)) return instanceCache.get(model);
    const promise = (async () => {
        const ns = await loadUmdScript(LIB_URL, 'tokenizers');
        const url = TOKENIZER_URLS[model];
        if (!url) throw new Error(`No web-tokenizer URL for model "${model}"`);
        const buf = await fetchTokenizerJson(url);
        return ns.Tokenizer.fromJSON(buf);
    })();
    // Cache the promise so concurrent callers share it. If it rejects, evict
    // so a later call can retry instead of permanently failing.
    instanceCache.set(model, promise);
    promise.catch(() => instanceCache.delete(model));
    return promise;
}

// Port of src/prompt-converters.js:115 `convertClaudePrompt`, specialized for
// the call shape used at src/endpoints/tokenizers.js:549:
//   convertClaudePrompt(messages, false, '', false, false, '', false)
// With all flags off, only these branches execute. Mutates the messages array
// (matching server behavior); callers pass throwaway copies.
function convertClaudePromptForCount(messages) {
    if (messages.length > 0) {
        messages.forEach((m) => {
            if (!m.content) m.content = '';
            if (m.tool_calls) m.content += JSON.stringify(m.tool_calls);
        });
        messages[0].role = 'system';
        let hasUser = false;
        const firstAssistantIndex = messages.findIndex((message, i) => {
            if (i >= 0 && (message.role === 'user' || message.content.includes('\n\nHuman: '))) {
                hasUser = true;
            }
            return message.role === 'assistant' && i > 0;
        });
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

export async function countMessages(model, messages) {
    const tok = await getInstance(model);
    const copy = messages.map(m => ({ ...m }));
    const prompt = convertClaudePromptForCount(copy);
    const out = tok.encode(prompt);
    // out may be a typed array, plain Array, or { ids: [...] } depending on lib version
    if (typeof out?.length === 'number') return out.length;
    return out?.ids?.length ?? 0;
}

export async function encode(model, text) {
    const tok = await getInstance(model);
    const out = tok.encode(String(text ?? ''));
    if (typeof out?.length === 'number') return Array.from(out);
    return Array.from(out?.ids ?? []);
}

export async function decode(model, ids) {
    const tok = await getInstance(model);
    return tok.decode(Array.from(ids));
}

export function supports(model) {
    return Object.hasOwn(TOKENIZER_URLS, model);
}
