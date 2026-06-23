import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import { serverDirectory } from './server-directory.js';
import { getRequestURL, isFileURL, isPathUnderParent } from './util.js';

const originalFetch = globalThis.fetch;

const ALLOWED_EXTENSIONS = [
    '.wasm',
];

// Patched fetch function that handles file URLs
globalThis.fetch = async (/** @type {string | URL | Request} */ request, /** @type {RequestInit | undefined} */ options) => {
    if (!isFileURL(request)) {
        return originalFetch(request, options);
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
