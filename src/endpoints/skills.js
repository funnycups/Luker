import express from 'express';
import { decodeScopePath } from '../skills/scope.js';
import {
    packEmbedPayload,
    parseEmbedPayload,
    materializeFromEmbed,
    computeEmbedItemHash,
} from '../skills/embed.js';
import { importBundledSkills, buildBundledManifest } from '../skills/bundled.js';
import { importFromUrl } from '../skills/url-import.js';

/**
 * REST router for Skill management.
 *
 * URL scheme:
 *   GET    /api/skills?scope=<global|preset/api/name|character/file|all>
 *   GET    /api/skills/<scope>/<name>/file?path=...&offset=...&limit=...
 *   GET    /api/skills/<scope>/<name>/files
 *   POST   /api/skills/<scope>                              (install)
 *   DELETE /api/skills/<scope>/<name>
 *   DELETE /api/skills/<scope>/<name>/file?path=...
 *   POST   /api/skills/<scope>/<name>/rename
 *   POST   /api/skills/<scope>/<name>/move-scope
 *   POST   /api/skills/<scope>/<name>/file/write
 *   POST   /api/skills/<scope>/<name>/file/edit
 *   GET    /api/skills/<scope>/<name>/search?q=...&path=...&limit=...&context_lines=...
 *   POST   /api/skills/pack-for-embed
 *   POST   /api/skills/extract-embed/preview
 *   POST   /api/skills/extract-embed/execute
 *   POST   /api/skills/import-bundled
 *   GET    /api/skills/bundled-manifest
 *   POST   /api/skills/import-from-url
 *
 * The `<scope>` segment must be URL-encoded by callers (preset/character
 * scopes contain slashes; encodeURIComponent collapses them into a single
 * Express path parameter that decodeScopePath can parse back).
 *
 * Repository resolution is injected per-request via getRepository(req) so the
 * server can scope skills to the authenticated user's data directory, while
 * tests can substitute a fixed-root repo for isolation.
 *
 * @param {object} options
 * @param {(req:import('express').Request) => object} options.getRepository
 *        Called per-request to resolve the per-user SkillRepository.
 * @param {(req:import('express').Request) => (object|null)} [options.getMemoryIndex]
 *        Optional per-request resolver for a memory index whose
 *        `invalidate()` is called after writes. Returning `null` (or omitting
 *        the option entirely) is treated as no-op. The resolver runs once per
 *        write handler so each user's index can be looked up from the
 *        authenticated request rather than sharing one global instance —
 *        without this indirection a write by user A would either invalidate
 *        nothing or invalidate every user's cache.
 * @returns {import('express').Router}
 */
// Factory export (not `export const router = ...`) because each request needs
// the per-user SkillRepository — resolved through `getRepository(req)` — and
// optionally a per-user memory-index handle for write-side invalidation
// (resolved through `getMemoryIndex(req)`). Both dependencies are injected at
// construction time so server.js can wire the real auth/data path while tests
// substitute fixed-root fakes via supertest.
export function createSkillsRouter({ getRepository, getMemoryIndex }) {
    const router = express.Router();

    // Express auto-decodes %2F in path params, so req.params.scope arrives
    // as the original `preset/openai/foo` string. decodeScopePath does the
    // structural validation.
    function parseScope(scopeParam) {
        return decodeScopePath(scopeParam);
    }

    // Map repository / scope errors to HTTP status codes. Repository throws
    // plain Errors with descriptive messages; we pattern-match those messages
    // here rather than introducing a typed error hierarchy that would
    // duplicate the same information. Order matters: more specific patterns
    // come first because a single message can match multiple buckets
    // ("rename collision: target xxx exists" matches both 404-flavored
    // wording and 409-flavored "exists/collision" — collision wins).
    function httpStatusForError(err) {
        const msg = String(err && err.message || '');

        // 413 Payload Too Large: explicit size/count violations.
        // 'total skill size' matches repository.validatePayloadFiles when the
        // sum of all file sizes exceeds LIMITS.perSkill.
        if (/size limit|exceeds|too many|too large|exceeded|total skill size/i.test(msg)) return 413;

        // 409 Conflict: existing target blocks the write. (`already_installed`
        // is a SUCCESS action surfaced as r.action, never a thrown message,
        // so it isn't part of this pattern.)
        if (/collision|already has|exists with|exists.*content|already installed|destination already exists/i.test(msg)) return 409;

        // 404 Not Found: source resource missing (read or write).
        // Includes ENOENT wrapped by readFile ("cannot read X: ENOENT...").
        if (/not found|file not found|source not found|cannot read.*ENOENT|cannot read.*no such/i.test(msg)) return 404;

        // 400 Bad Request: every other validation failure. The `must (?:include|start|be)`
        // alternation covers frontmatter-parser messages
        // ("SKILL.md must start with...", "must include name", "must include description").
        // `frontmatter` and `file is binary` cover the same parser + readFile
        // user-input failures that previously fell through to 500.
        if (/illegal|invalid|path traversal|unknown scope|unsupported|missing|must (?:include|start|be)|required|frontmatter|file is binary|no sub-path|scope path|sha256 mismatch|only https|did not return|no YAML|name mismatch|oldString not found|multiple matches|empty|not.*frontmatter|has no files|fetch failed|cannot (?:delete|rename|overwrite) SKILL\.md/i.test(msg)) return 400;

        return 500;
    }

    function handleError(err, res) {
        const status = httpStatusForError(err);
        res.status(status).json({ error: err.message });
    }

    async function invalidateIndex(req) {
        if (!getMemoryIndex) return;
        const idx = getMemoryIndex(req);
        if (idx && typeof idx.invalidate === 'function') {
            await idx.invalidate();
        }
    }

    // ─────────────── pack-for-embed / extract / bundled / url-import ───────────────
    // These literal-prefix routes must register BEFORE the `:scope` routes
    // below; otherwise Express greedily matches `pack-for-embed` as a scope
    // segment and fails decodeScopePath with "unknown scope kind".

    router.post('/pack-for-embed', async (req, res) => {
        try {
            const repo = getRepository(req);
            const { scope, names, mode } = req.body || {};
            const payload = await packEmbedPayload({ repository: repo, scope, names, mode: mode || 'auto' });
            res.json(payload);
        } catch (e) { handleError(e, res); }
    });

    router.post('/extract-embed/preview', async (req, res) => {
        try {
            const repo = getRepository(req);
            const { payload, targetScope } = req.body || {};
            const items = await parseEmbedPayload(payload);
            const out = [];
            for (const item of items) {
                const name = item && item.name;
                if (!name) {
                    out.push({ name: null, conflict: 'invalid' });
                    continue;
                }
                const existing = await repo.get(name, targetScope);
                let conflict;
                if (!existing) {
                    conflict = 'new';
                } else {
                    // Compare by computed install-hash so 'same' verdict here
                    // round-trips to repository.install's `already_installed`
                    // action on execute. See computeEmbedItemHash in embed.js
                    // for the hash algorithm contract.
                    const incomingHash = await computeEmbedItemHash(item);
                    conflict = existing.installedHash === incomingHash ? 'same' : 'different';
                }
                out.push({ name, conflict });
            }
            res.json({ items: out });
        } catch (e) { handleError(e, res); }
    });

    router.post('/extract-embed/execute', async (req, res) => {
        try {
            const repo = getRepository(req);
            const { payload, targetScope, conflictStrategies } = req.body || {};
            const result = await materializeFromEmbed({
                repository: repo, payload, targetScope, conflictStrategies,
            });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.post('/import-bundled', async (req, res) => {
        try {
            const repo = getRepository(req);
            const defaultRoot = req.app.get('lukerDefaultRoot');
            if (!defaultRoot) throw new Error('lukerDefaultRoot not configured');
            const result = await importBundledSkills({ defaultRoot, repository: repo });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    // Manifest of what's available in default/skills/global/, including the
    // install hash each skill would produce — read-only. The "Browse bundled"
    // tab uses this to mark each row installed_match / installed_differ /
    // not_installed by comparing against the live skill index.
    router.get('/bundled-manifest', async (req, res) => {
        try {
            const defaultRoot = req.app.get('lukerDefaultRoot');
            if (!defaultRoot) throw new Error('lukerDefaultRoot not configured');
            const manifest = await buildBundledManifest({ defaultRoot });
            res.json(manifest);
        } catch (e) { handleError(e, res); }
    });

    router.post('/import-from-url', async (req, res) => {
        try {
            const repo = getRepository(req);
            const { url, targetScope } = req.body || {};
            const result = await importFromUrl({ url, targetScope, repository: repo });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    // ────────────────────────────── list ──────────────────────────────

    router.get('/', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scopeParam = String(req.query.scope || 'all');
            const scope = scopeParam === 'all' ? 'all' : decodeScopePath(scopeParam);
            const entries = await repo.list({ scope });
            res.json(entries);
        } catch (e) { handleError(e, res); }
    });

    // ─────────────────────── scoped operations ────────────────────────

    router.get('/:scope/:name/file', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const { path: filePath, offset, limit } = req.query;
            const result = await repo.readFile({
                scope,
                name: req.params.name,
                path: filePath || 'SKILL.md',
                offset: offset !== undefined ? Number(offset) : undefined,
                limit: limit !== undefined ? Number(limit) : undefined,
            });
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    // List file metadata for the skill editor. Returns `{ files: [{path,
    // size, isBinary}] }` rather than reusing the internal listFiles
    // (which returns full buffers used by the embed packer) — the browser
    // doesn't need contents, only a directory listing for the file tree.
    // Sort SKILL.md to the top because it's the skill's root manifest;
    // the rest follow in localeCompare order from the repository.
    router.get('/:scope/:name/files', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const entries = await repo.listFiles({ scope, name: req.params.name });
            const files = entries.map(e => ({
                path: e.path,
                size: e.buffer ? e.buffer.length : 0,
                isBinary: Boolean(e.isBinary),
            }));
            files.sort((a, b) => {
                if (a.path === 'SKILL.md') return -1;
                if (b.path === 'SKILL.md') return 1;
                return a.path.localeCompare(b.path);
            });
            res.json({ files });
        } catch (e) { handleError(e, res); }
    });

    // Per-file delete used by the inline skill editor. SKILL.md cannot be
    // deleted (the repository enforces this); deleting the whole skill
    // goes through the existing DELETE /:scope/:name route.
    router.delete('/:scope/:name/file', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const filePath = String(req.query.path || '');
            await repo.deleteFile({ scope, name: req.params.name, path: filePath });
            await invalidateIndex(req);
            res.status(204).end();
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope/:name/file/rename', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const { fromPath, toPath } = req.body || {};
            const result = await repo.renameFile({
                scope,
                name: req.params.name,
                fromPath,
                toPath,
            });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.get('/:scope/:name/search', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const result = await repo.search({
                scope,
                name: req.params.name,
                query: String(req.query.q || ''),
                path: req.query.path,
                limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
                contextLines: req.query.context_lines !== undefined ? Number(req.query.context_lines) : undefined,
            });
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope/:name/rename', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            await repo.rename({
                scope,
                fromName: req.params.name,
                toName: req.body && req.body.toName,
            });
            await invalidateIndex(req);
            res.json({ ok: true });
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope/:name/move-scope', async (req, res) => {
        try {
            const repo = getRepository(req);
            const fromScope = parseScope(req.params.scope);
            await repo.moveScope({
                name: req.params.name,
                fromScope,
                toScope: req.body && req.body.toScope,
            });
            await invalidateIndex(req);
            res.json({ ok: true });
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope/:name/file/write', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const { path, content, expectedSha256 } = req.body || {};
            const result = await repo.writeFile({
                scope,
                name: req.params.name,
                path,
                content,
                expectedSha256,
            });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope/:name/file/edit', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const { path, oldString, newString, replaceAll } = req.body || {};
            const result = await repo.editFile({
                scope,
                name: req.params.name,
                path,
                oldString,
                newString,
                replaceAll,
            });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.post('/:scope', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            const { payload, conflictStrategy } = req.body || {};
            const result = await repo.install({ scope, payload, conflictStrategy });
            await invalidateIndex(req);
            res.json(result);
        } catch (e) { handleError(e, res); }
    });

    router.delete('/:scope/:name', async (req, res) => {
        try {
            const repo = getRepository(req);
            const scope = parseScope(req.params.scope);
            await repo.delete(req.params.name, scope);
            await invalidateIndex(req);
            res.status(204).end();
        } catch (e) { handleError(e, res); }
    });

    return router;
}
