import { createRequire } from 'node:module';
import { HAS_WASM } from './runtime-capabilities.js';

const require = createRequire(import.meta.url);

// tiktoken's native binding touches the WebAssembly global during module
// init, so importing it under --jitless throws before any tokenizer exists.
// Require it only when WebAssembly is present; otherwise use the pure-JS
// port, which covers the same OpenAI model ids. js-tiktoken's decode()
// returns a string, so the adapter re-encodes to bytes to match the native
// decode() contract the call sites rely on.
const nativeTiktoken = HAS_WASM ? require('tiktoken') : null;
const jsTiktoken = HAS_WASM ? null : require('js-tiktoken');

/**
 * Creates a tokenizer with the native tiktoken API surface: encode() yields
 * token ids, decode() yields UTF-8 bytes.
 * @param {string} model tiktoken model id
 * @returns {{ encode: (text: string) => ArrayLike<number>, decode: (tokens: ArrayLike<number>) => Uint8Array }}
 */
export function createTiktokenTokenizer(model) {
    if (HAS_WASM) {
        return nativeTiktoken.encoding_for_model(model);
    }
    const encoding = jsTiktoken.encodingForModel(model);
    const encoder = new TextEncoder();
    // js-tiktoken's decode() returns a string, so this re-encode is
    // byte-shape-compatible but not byte-value-exact for a token that splits
    // a multibyte character; consumers immediately TextDecoder-decode.
    return {
        encode: (text) => encoding.encode(text),
        decode: (tokens) => encoder.encode(encoding.decode(Array.from(tokens))),
    };
}
