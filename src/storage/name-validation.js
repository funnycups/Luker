// Name validation for repo-bound endpoint inputs (themes / movingUI /
// quickReplies / worldinfo / presets save+create paths). These names round-trip
// across FS files and DB rows; the WorldInfoRepo `Foo.json` → `Foo.json.json`
// failure happened because the endpoint accepted a filename-shaped name and
// every layer below assumed it was a bare name. Validate at the boundary so
// the rest of the stack can trust the input.
//
// Two entry points with different scopes:
//   - assertSafeRepoNameShape: character / suffix / sanitize-filename checks
//     only. Engine put layer uses this as defense-in-depth: refuse to write a
//     name that would be silently rewritten by sanitize-filename (would corrupt
//     the round-trip) or that looks like a filename. It does NOT enforce the
//     128-byte length limit, because legacy pre-validation data written under
//     older builds may exceed 128 bytes; internal migrations (chat renameCharDir,
//     MigrationRunner.saveRaw, append/patch) must still be able to move that
//     data through the write path.
//   - assertSafeRepoName: shape + 128-byte length. Endpoints use this on
//     fresh user input so both FS and DB engines can store the value (the
//     limit is the MySQL/Postgres VARCHAR(128) PK width).
//
// Endpoints that READ or DELETE existing data should NOT call either — old
// names that fail validation must still be reachable so users can fetch and
// rename them.

import sanitizeFilename from 'sanitize-filename';

import { InvalidArgumentError } from './errors.js';

const MAX_NAME_LEN = 128;
const FORBIDDEN_SUFFIXES = ['.json', '.jsonl'];

// Shape-only check: trims, then rejects empty / filename-shaped / character-
// unsafe names. Returns the canonical (trimmed) form. Engine put paths call
// this so pre-validation legacy names (which may exceed 128 bytes) still
// migrate/append/patch/rename, while a fresh write of `Foo/Bar` or `Foo.json`
// is still refused before it can silently corrupt storage.
export function assertSafeRepoNameShape(raw, { field = 'name' } = {}) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        throw new InvalidArgumentError(`${field} is required`);
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
        if (trimmed.toLowerCase().endsWith(suffix)) {
            throw new InvalidArgumentError(`${field} must not end with "${suffix}" (use the bare name without the extension)`);
        }
    }
    const sanitized = sanitizeFilename(trimmed);
    if (sanitized !== trimmed) {
        throw new InvalidArgumentError(`${field} contains characters that cannot appear in a stored name (sanitize-filename would rewrite to "${sanitized}")`);
    }
    return trimmed;
}

// Full check: shape + 128-byte length. Endpoint boundary uses this so a fresh
// user-supplied name fits in the MySQL/Postgres VARCHAR(128) PK on both
// engines. Do NOT push this to the engine put layer — legacy data written
// before the length limit existed must still flow through save/append/patch/
// rename without hitting a 400.
export function assertSafeRepoName(raw, { field = 'name' } = {}) {
    const trimmed = assertSafeRepoNameShape(raw, { field });
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_NAME_LEN) {
        throw new InvalidArgumentError(`${field} exceeds ${MAX_NAME_LEN} bytes`);
    }
    return trimmed;
}
