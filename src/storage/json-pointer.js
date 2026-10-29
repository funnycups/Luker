/**
 * RFC 6901 JSON Pointer parsing for server-side field reads.
 */
export function decodeJsonPointer(pointer) {
    const raw = String(pointer ?? '');
    if (raw === '') {
        return [];
    }
    if (!raw.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer: ${raw}`);
    }
    return raw.slice(1).split('/').map((segment) => {
        if (/~(?![01])/.test(segment)) {
            throw new Error(`Invalid JSON Pointer escape: ${raw}`);
        }
        return segment.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}
