// Name validation for repo-bound endpoint inputs (themes / movingUI /
// quickReplies / worldinfo / presets save+create paths). These names round-trip
// across FS files and DB rows; the WorldInfoRepo `Foo.json` → `Foo.json.json`
// failure happened because the endpoint accepted a filename-shaped name and
// every layer below assumed it was a bare name. Validate at the boundary so
// the rest of the stack can trust the input.

import sanitizeFilename from 'sanitize-filename';

import { InvalidArgumentError } from './errors.js';

const MAX_NAME_LEN = 128;
const FORBIDDEN_SUFFIXES = ['.json', '.jsonl'];

// Validates and returns the canonical form (trimmed) of a name passed to a
// repo save/create endpoint. Throws InvalidArgumentError on any of:
//   - empty after trim
//   - contains characters sanitize-filename would strip (slashes, NUL,
//     reserved Windows characters, control codes)
//   - looks like a filename (ends in .json / .jsonl)
//   - exceeds MAX_NAME_LEN bytes (MySQL/Postgres VARCHAR(128) PK limit)
//
// Use this in every endpoint that takes a user-supplied name and forwards it
// to a Repo save/create call. Endpoints that READ or DELETE existing data
// should NOT call this — old names that fail validation must still be
// reachable so users can fetch and rename them.
export function assertSafeRepoName(raw, { field = 'name' } = {}) {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) {
        throw new InvalidArgumentError(`${field} is required`);
    }
    for (const suffix of FORBIDDEN_SUFFIXES) {
        if (trimmed.toLowerCase().endsWith(suffix)) {
            throw new InvalidArgumentError(`${field} must not end with "${suffix}" (use the bare name without the extension)`);
        }
    }
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_NAME_LEN) {
        throw new InvalidArgumentError(`${field} exceeds ${MAX_NAME_LEN} bytes`);
    }
    const sanitized = sanitizeFilename(trimmed);
    if (sanitized !== trimmed) {
        throw new InvalidArgumentError(`${field} contains characters that cannot appear in a stored name (sanitize-filename would rewrite to "${sanitized}")`);
    }
    return trimmed;
}
