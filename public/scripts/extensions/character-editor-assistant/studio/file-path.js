/** Encode a filename as a lodash-compatible bracket path without changing it. */
export function cardAppFileEditPath(filePath) {
    return `files[${JSON.stringify(String(filePath))}]`;
}

export function parseCardAppFilePath(opPath) {
    const path = String(opPath || '');
    if (path.startsWith('files[') && path.endsWith(']')) {
        try {
            const decoded = JSON.parse(path.slice(6, -1));
            if (typeof decoded === 'string') return decoded;
        } catch { /* Accept old unquoted paths below. */ }
    }
    const legacy = /^files\["?([^"\]]+)"?\]$/.exec(path);
    return legacy ? legacy[1] : path;
}
