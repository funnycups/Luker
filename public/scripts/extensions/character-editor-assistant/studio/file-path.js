/** Encode a filename as a lodash-compatible bracket path without changing it. */
export function cardAppFileEditPath(filePath) {
    return `files[${JSON.stringify(String(filePath))}]`;
}

export function parseCardAppFilePath(opPath) {
    const path = String(opPath || '');
    if (path.startsWith('files[') && path.endsWith(']')) {
        const decoded = JSON.parse(path.slice(6, -1));
        if (typeof decoded !== 'string') {
            throw new Error(`Invalid CardApp file edit path: ${path}`);
        }
        return decoded;
    }
    return path;
}
