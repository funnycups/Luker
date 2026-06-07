// public/scripts/client-tokenizers/normalize-model.js
//
// Mirror of src/endpoints/tokenizers.js:getTokenizerModel — boundary
// normalizer that maps an arbitrary model name (custom_model, OpenAI source
// raw model id, OpenRouter id, etc.) to the canonical tokenizer key used
// by adapters' MODEL_URLS / TOKENIZER_URLS maps. Order matters: more
// specific includes() checks must come before broader ones (llama3 before
// llama, command-a before command-r is encoded by both rules being matched
// independently against the input string).
//
// PAIRED with src/endpoints/tokenizers.js:getTokenizerModel — edit both
// together. Returning the input unchanged on no-match lets adapters'
// supports() reject it and the network fallback kick in.

export function normalizeTokenizerModel(model) {
    if (typeof model !== 'string' || !model) return model;

    if (model === 'o1' || model.includes('o1-preview') || model.includes('o1-mini') || model.includes('o3-mini')) return 'o1';
    if (model.includes('gpt-5') || model.includes('o3') || model.includes('o4-mini')) return 'o1';
    if (model.includes('gpt-4o') || model.includes('chatgpt-4o-latest')) return 'gpt-4o';
    if (model.includes('gpt-4.1') || model.includes('gpt-4.5')) return 'gpt-4o';
    if (model.includes('gpt-4-32k')) return 'gpt-4-32k';
    if (model.includes('gpt-4')) return 'gpt-4';
    if (model.includes('gpt-3.5-turbo-0301')) return 'gpt-3.5-turbo-0301';
    if (model.includes('gpt-3.5-turbo')) return 'gpt-3.5-turbo';

    if (model.includes('claude')) return 'claude';
    if (model.includes('llama3') || model.includes('llama-3')) return 'llama3';
    if (model.includes('llama')) return 'llama';
    if (model.includes('mistral')) return 'mistral';
    if (model.includes('yi')) return 'yi';
    if (model.includes('deepseek')) return 'deepseek';
    if (model.includes('gemma') || model.includes('gemini') || model.includes('learnlm')) return 'gemma';
    if (model.includes('jamba')) return 'jamba';
    if (model.includes('qwen2')) return 'qwen2';
    if (model.includes('command-a')) return 'command-a';
    if (model.includes('command-r')) return 'command-r';
    if (model.includes('nemo')) return 'nemo';

    return model;
}
