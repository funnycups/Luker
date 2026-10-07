// Runtime capability probe. HarmonyOS NEXT enforces W^X + code-signing, so
// V8 cannot allocate executable memory and Node must run with --jitless.
// --jitless removes the WebAssembly global; modules that depend on it branch
// on HAS_WASM instead of shipping a separate build. LUKER_FORCE_JITLESS=1
// forces the jitless branch under a normal Node for tests.
export const HAS_WASM = typeof WebAssembly !== 'undefined'
    && typeof WebAssembly.Module === 'function'
    && process.env.LUKER_FORCE_JITLESS !== '1';
