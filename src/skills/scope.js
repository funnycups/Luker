// Reject only the characters that actually break the filesystem or
// allow path traversal — everything else (CJK, spaces, hyphens,
// internal dots, etc.) is fine on the modern filesystems we target.
// Block list:
//   - empty / non-string (no segment at all)
//   - literal `.` and `..` (path traversal)
//   - control chars `\x00-\x1f` (can corrupt fs operations)
//   - `/` and `\` (path separators — would let a segment escape its dir)
//   - `<>:"|?*` (illegal in Windows filenames, prevent cross-platform breakage)
// An earlier `^[A-Za-z0-9._-]+$` allow-list rejected any preset or
// character name containing non-ASCII letters or spaces (e.g.
// `夏瑾 双鱼座 Beta 0.36-orchestrator`) — those names round-trip
// fine on disk and through Express, so the strict ASCII gate was
// causing 400s for legitimate user input.
const UNSAFE_CHARS = /[\x00-\x1f/\\<>:"|?*]/;

// Orchestrator iteration modes. Kept as a set so decodeScopePath can
// reject unknown modes at the parse boundary; encodeScopePath doesn't
// re-check because the four modes are the only producers on the write
// side (endpoints in tasks 2/5-9 validate at the API boundary).
const ORCH_PRESET_MODES = new Set(['spec', 'agenda', 'loop', 'director']);

function assertSafe(...segments) {
    for (const s of segments) {
        if (!s || typeof s !== 'string') {
            throw new Error(`scope segment has illegal characters: ${s}`);
        }
        if (s === '.' || s === '..') {
            throw new Error(`scope segment has illegal characters: ${s}`);
        }
        if (UNSAFE_CHARS.test(s)) {
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
            // Preset scope is keyed by preset name alone. The earlier
            // (apiId, name) shape forced users to bind skills to a specific
            // connection-profile + preset pair, even though a chat-completion
            // preset is decoupled from any particular connection profile in
            // Luker. Flattening means the skill follows the preset wherever
            // the user routes it.
            assertSafe(scope.name);
            return `preset/${scope.name}`;
        case 'orch-preset':
            assertSafe(scope.mode, scope.name);
            return `orch-preset/${scope.mode}/${scope.name}`;
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
            if (parts.length !== 2) throw new Error('preset scope path: preset/<name>');
            return { kind: 'preset', name: parts[1] };
        case 'orch-preset': {
            if (parts.length !== 3) throw new Error('orch-preset scope path: orch-preset/<mode>/<name>');
            const mode = parts[1];
            if (!ORCH_PRESET_MODES.has(mode)) {
                throw new Error(`unknown scope kind: orch-preset (invalid mode: ${mode})`);
            }
            return { kind: 'orch-preset', mode, name: parts[2] };
        }
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
        case 'preset': return `preset:${scope.name}`;
        case 'orch-preset': return `orch:${scope.mode}/${scope.name}`;
        case 'character': return `character:${scope.characterFile}`;
        default: return 'unknown';
    }
}
