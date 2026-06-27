// Classic web-worker that runs @agnai/web-tokenizers off the main thread.
//
// Why classic, not module: the UMD bundle (~4MB) needs importScripts(), which
// is unavailable in module workers. The lib is the same one main-thread used
// via UMD loader; this just moves the WASM call out of the renderer.
//
// Wire protocol:
//   in:  { id, op: 'countMessages', model, messages }
//        { id, op: 'encode',        model, text }
//        { id, op: 'decode',        model, ids }
//   out: { id, ok: true, result }  or  { id, ok: false, error }

importScripts('/lib/tokenizers/web-tokenizers/index.js');
// UMD bundle assigns to `self.tokenizers` in workers (no `window`/`global`).
const tokenizersNs = self.tokenizers;
if (!tokenizersNs || !tokenizersNs.Tokenizer) {
    throw new Error('web-tokenizers UMD did not expose self.tokenizers.Tokenizer');
}

// Mirrors web-tokenizer-adapter.js — kept in sync there.
const TOKENIZER_URLS = {
    claude: '/tokenizers/claude.json',
    llama3: '/tokenizers/llama3.json',
    'llama-3': '/tokenizers/llama3.json',
    qwen2: '/tokenizers/qwen2.json',
    'command-r': '/tokenizers/command-r.json',
    'command-a': '/tokenizers/command-a.json',
    nemo: '/tokenizers/nemo.json',
    deepseek: '/tokenizers/deepseek.json',
};

const instanceCache = new Map();

async function fetchTokenizerJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tokenizer fetch failed: ${url} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
}

function getInstance(model) {
    if (instanceCache.has(model)) return instanceCache.get(model);
    const promise = (async () => {
        const url = TOKENIZER_URLS[model];
        if (!url) throw new Error(`No web-tokenizer URL for model "${model}"`);
        const buf = await fetchTokenizerJson(url);
        return tokenizersNs.Tokenizer.fromJSON(buf);
    })();
    instanceCache.set(model, promise);
    promise.catch(() => instanceCache.delete(model));
    return promise;
}

// Mirrors convertClaudePromptForCount in web-tokenizer-adapter.js — same
// specialization of src/prompt-converters.js convertClaudePrompt(..., false x6).
function convertClaudePromptForCount(messages) {
    if (messages.length > 0) {
        messages.forEach((m) => {
            if (!m.content) m.content = '';
            if (m.tool_calls) m.content += JSON.stringify(m.tool_calls);
        });
        messages[0].role = 'system';
        const firstAssistantIndex = messages.findIndex((message, i) => message.role === 'assistant' && i > 0);
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

async function handleCountMessages(model, messages) {
    const tok = await getInstance(model);
    const copy = messages.map(m => ({ ...m }));
    const prompt = convertClaudePromptForCount(copy);
    const out = tok.encode(prompt);
    if (typeof out?.length === 'number') return out.length;
    return out?.ids?.length ?? 0;
}

async function handleEncode(model, text) {
    const tok = await getInstance(model);
    const out = tok.encode(String(text ?? ''));
    if (typeof out?.length === 'number') return Array.from(out);
    return Array.from(out?.ids ?? []);
}

async function handleDecode(model, ids) {
    const tok = await getInstance(model);
    return tok.decode(Array.from(ids));
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
                throw new Error(`Unknown tokenizer-worker op: ${data?.op}`);
        }
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
});
