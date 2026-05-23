// public/scripts/client-tokenizers/umd-loader.js
//
// Loads a UMD <script> from `url`, then resolves with `globalThis[globalName]`.
// Caches per URL so concurrent or repeat calls share one network fetch.

const inflight = new Map();

export function loadUmdScript(url, globalName) {
    if (typeof globalThis[globalName] !== 'undefined') {
        return Promise.resolve(globalThis[globalName]);
    }
    if (inflight.has(url)) return inflight.get(url);

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => {
            const exported = globalThis[globalName];
            if (typeof exported === 'undefined') {
                reject(new Error(`UMD script ${url} loaded but did not expose globalThis.${globalName}`));
            } else {
                resolve(exported);
            }
        };
        script.onerror = () => reject(new Error(`Failed to load UMD script: ${url}`));
        document.head.appendChild(script);
    });
    inflight.set(url, promise);
    return promise;
}
