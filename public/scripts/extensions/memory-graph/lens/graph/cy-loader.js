// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads Luker's bundled Cytoscape (/lib/cytoscape.min.js) once. Some pages
// inject an AMD/CommonJS shim; the UMD wrapper would then register with it
// instead of `window`, so those globals are masked during the load.

let pending = null;

export function loadCytoscape(src = '/lib/cytoscape.min.js') {
    if (globalThis.cytoscape) return Promise.resolve(globalThis.cytoscape);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
        const saved = {};
        for (const key of ['define', 'module', 'exports']) {
            saved[key] = { had: key in window, value: window[key] };
            window[key] = undefined;
        }
        const restore = () => {
            for (const [key, { had, value }] of Object.entries(saved)) {
                if (had) window[key] = value;
                else delete window[key];
            }
        };
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.dataset.memoryLens = 'cytoscape';
        script.onload = () => {
            restore();
            if (globalThis.cytoscape) resolve(globalThis.cytoscape);
            else reject(new Error('Cytoscape loaded but window.cytoscape is missing'));
        };
        script.onerror = () => {
            restore();
            script.remove();
            reject(new Error(`Failed to load ${src}`));
        };
        document.head.appendChild(script);
    }).catch((err) => {
        pending = null;
        throw err;
    });
    return pending;
}
