const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function assertSafe(...segments) {
    for (const s of segments) {
        if (!s || typeof s !== 'string' || !SAFE_SEGMENT.test(s)) {
            throw new Error(`scope segment has illegal characters: ${s}`);
        }
        if (s === '.' || s === '..') {
            throw new Error(`scope segment has illegal characters: ${s}`);
        }
    }
}

export function encodeScopePath(scope) {
    if (!scope || typeof scope !== 'object') throw new Error('scope must be an object');
    switch (scope.kind) {
        case 'global':
            return 'global';
        case 'preset':
            assertSafe(scope.apiId, scope.name);
            return `preset/${scope.apiId}/${scope.name}`;
        case 'character':
            assertSafe(scope.characterFile);
            return `character/${scope.characterFile}`;
        default:
            throw new Error(`unknown scope kind: ${scope.kind}`);
    }
}

export function decodeScopePath(path) {
    const parts = String(path || '').split('/');
    // Validate all non-kind segments up-front so that traversal ("..") and
    // empty segments fail at the decode boundary regardless of path shape.
    if (parts.length > 1) assertSafe(...parts.slice(1));
    switch (parts[0]) {
        case 'global':
            if (parts.length !== 1) throw new Error('global scope has no sub-path');
            return { kind: 'global' };
        case 'preset':
            if (parts.length !== 3) throw new Error('preset scope path: preset/<api>/<name>');
            return { kind: 'preset', apiId: parts[1], name: parts[2] };
        case 'character':
            if (parts.length !== 2) throw new Error('character scope path: character/<file>');
            return { kind: 'character', characterFile: parts[1] };
        default:
            throw new Error(`unknown scope kind: ${parts[0]}`);
    }
}

export function isValidScope(scope) {
    try {
        encodeScopePath(scope);
        return true;
    } catch {
        return false;
    }
}

export function scopeLabel(scope) {
    if (!scope || typeof scope !== 'object') return 'unknown';
    switch (scope.kind) {
        case 'global': return 'global';
        case 'preset': return `preset:${scope.apiId}:${scope.name}`;
        case 'character': return `character:${scope.characterFile}`;
        default: return 'unknown';
    }
}
