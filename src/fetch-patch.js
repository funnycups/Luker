import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import nodeFetch from 'node-fetch';
import { serverDirectory } from './server-directory.js';
import { getRequestURL, isFileURL, isPathUnderParent } from './util.js';
import { HAS_WASM } from './runtime-capabilities.js';

const originalFetch = globalThis.fetch;
// undici's global fetch parses HTTP/1.1 with a WASM llhttp; --jitless removes
// WebAssembly, so global fetch call sites fail. Many LLM/vector paths import
// node-fetch directly and are unaffected. Fall back to node-fetch, which is
// pure JS. luker-dispatch/response-stream.js already handles both the Node
// Readable body node-fetch produces and the WHATWG stream undici produces.
const baseFetch = HAS_WASM ? originalFetch : nodeFetch;

const ALLOWED_EXTENSIONS = [
    '.wasm',
];

// Patched fetch function that handles file URLs
globalThis.fetch = async (/** @type {string | URL | Request} */ request, /** @type {RequestInit | undefined} */ options) => {
    if (!isFileURL(request)) {
        // node-fetch v3 rejects a foreign (undici) Request object; this patch
        // forwards `request` as-is, and src/ has no `fetch(new Request(...))`
        // caller today.
        return baseFetch(request, options);
    }
    const url = getRequestURL(request);
    const filePath = path.resolve(fileURLToPath(url));
    const isUnderServerDirectory = isPathUnderParent(serverDirectory, filePath);
    // npm dependencies (e.g. @jsquash/* squoosh WASM codecs loaded by jimp)
    // resolve their WASM via package-relative file:// URLs. When the install
    // is symlinked (worktrees, pnpm hoist, manual ln -s), the realpath can
    // land outside `serverDirectory` even though the file is still part of
    // the resolved dependency graph. Trust any .wasm file whose path
    // includes a `node_modules` segment — the extension check below is the
    // backstop, and WASM bytes come from the installed package, not user
    // input.
    const segments = filePath.split(path.sep);
    const isUnderNodeModules = segments.includes('node_modules');
    if (!isUnderServerDirectory && !isUnderNodeModules) {
        throw new Error('Requested file path is outside of the server directory.');
    }
    const parsedPath = path.parse(filePath);
    if (!ALLOWED_EXTENSIONS.includes(parsedPath.ext)) {
        throw new Error('Unsupported file extension.');
    }
    const fileName = parsedPath.base;
    const buffer = await fs.promises.readFile(filePath);
    const response = new Response(buffer, {
        status: 200,
        statusText: 'OK',
        headers: {
            'Content-Type': mime.lookup(fileName) || 'application/octet-stream',
            'Content-Length': buffer.length.toString(),
        },
    });
    return response;
};
