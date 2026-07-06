import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSkillFrontmatter } from './frontmatter-parser.js';
import { encodeScopePath, scopeLabel } from './scope.js';

const SKILL_MD = 'SKILL.md';

const LIMITS = {
    perFile: 4 * 1024 * 1024,         // 4 MB
    perSkill: 16 * 1024 * 1024,       // 16 MB
    fileCount: 100,
    skillMd: 512 * 1024,              // 512 KB
};

function assertSafeSkillName(n) {
    if (typeof n !== 'string' || !/^[a-z0-9_-]+$/.test(n) || n.length > 128) {
        throw new Error(`illegal skill name: ${n}`);
    }
}

function assertSafeFilePath(p) {
    if (typeof p !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(p) || p.includes('..') || p.startsWith('/')) {
        throw new Error(`illegal file path: ${p}`);
    }
}

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function isBinaryBuffer(buf, sampleSize = 512) {
    const n = Math.min(buf.length, sampleSize);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

function hashFiles(files) {
    const h = createHash('sha256');
    for (const f of files) {
        h.update(f.relPath); h.update('\0');
        h.update(f.sha256); h.update('\0');
    }
    return h.digest('hex');
}

export function createSkillRepository(dataRoot) {
    const skillsRoot = join(dataRoot, 'skills');

    async function walkSkillFiles(skillDir) {
        const out = [];
        async function recurse(rel) {
            const abs = rel ? join(skillDir, rel) : skillDir;
            const entries = await fs.readdir(abs, { withFileTypes: true });
            for (const e of entries) {
                const relPath = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) await recurse(relPath);
                else if (e.isFile()) {
                    const buf = await fs.readFile(join(abs, e.name));
                    out.push({
                        relPath,
                        sizeBytes: buf.length,
                        sha256: sha256(buf),
                        isBinary: isBinaryBuffer(buf),
                    });
                }
            }
        }
        await recurse('');
        out.sort((a, b) => a.relPath.localeCompare(b.relPath));
        return out;
    }

    async function readSkillEntry(scope, name) {
        const dir = join(skillsRoot, encodeScopePath(scope), name);
        const stat = await fs.stat(dir).catch(() => null);
        if (!stat || !stat.isDirectory()) return null;

        const skillMdPath = join(dir, SKILL_MD);
        const skillMdText = await fs.readFile(skillMdPath, 'utf8');
        const front = parseSkillFrontmatter(skillMdText);
        if (front.name !== name) {
            throw new Error(`name mismatch in ${scopeLabel(scope)}:${name} — frontmatter says ${front.name}`);
        }

        const files = await walkSkillFiles(dir);
        return {
            scope,
            name: front.name,
            description: front.description,
            license: front.license,
            metadata: front.metadata,
            installedHash: hashFiles(files),
            fileCount: files.length,
            totalBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
            hasScripts: files.some(f => f.relPath.startsWith('scripts/')),
            hasBinary: files.some(f => f.isBinary),
            installedAt: stat.mtime.toISOString(),
        };
    }

    async function listScope(scope) {
        const dir = join(skillsRoot, encodeScopePath(scope));
        let names;
        try {
            names = await fs.readdir(dir);
        } catch (e) {
            if (e.code === 'ENOENT') return [];
            throw e;
        }
        const entries = [];
        for (const name of names) {
            // Skip transient staging directories from in-flight installs.
            if (name.startsWith('.staging-')) continue;
            const entry = await readSkillEntry(scope, name).catch((e) => {
                console.warn(`skill skip ${scopeLabel(scope)}:${name}: ${e.message}`);
                return null;
            });
            if (entry) entries.push(entry);
        }
        return entries;
    }

    /**
     * Lists skill index entries for a given scope (or 'all').
     *
     * Note: if an individual skill's SKILL.md is malformed (bad YAML, name mismatch, etc.),
     * that skill is silently skipped with a console.warn and excluded from results.
     */
    async function list({ scope }) {
        if (scope === 'all') {
            const all = [];
            all.push(...(await listScope({ kind: 'global' })));
            const presetRoot = join(skillsRoot, 'preset');
            const presetNames = await fs.readdir(presetRoot).catch(() => []);
            for (const name of presetNames) {
                if (name.startsWith('.')) continue;
                all.push(...(await listScope({ kind: 'preset', name })));
            }
            const charRoot = join(skillsRoot, 'character');
            const chars = await fs.readdir(charRoot).catch(() => []);
            for (const characterFile of chars) {
                all.push(...(await listScope({ kind: 'character', characterFile })));
            }
            const orchPresetRoot = join(skillsRoot, 'orch-preset');
            const orchModes = await fs.readdir(orchPresetRoot).catch(() => []);
            for (const mode of orchModes) {
                if (mode.startsWith('.')) continue;
                const modeRoot = join(orchPresetRoot, mode);
                const orchNames = await fs.readdir(modeRoot).catch(() => []);
                for (const name of orchNames) {
                    if (name.startsWith('.')) continue;
                    all.push(...(await listScope({ kind: 'orch-preset', mode, name })));
                }
            }
            return all;
        }
        return listScope(scope);
    }

    async function get(name, scope) {
        assertSafeSkillName(name);
        return await readSkillEntry(scope, name).catch(() => null);
    }

    // ──────────────────────────── install / preview ────────────────────────────

    function fileBufferFromPayload(file) {
        const enc = String(file.encoding || 'utf8').toLowerCase();
        if (enc === 'utf8' || enc === 'utf-8') return Buffer.from(file.content, 'utf8');
        if (enc === 'base64') return Buffer.from(file.content, 'base64');
        throw new Error(`unsupported file encoding: ${enc}`);
    }

    // Note: this function mutates each file in `files` by attaching a parsed
    // `_buffer` property. Done deliberately so `install` can write the same
    // buffer we already validated without re-decoding the payload twice.
    function validatePayloadFiles(files) {
        if (files.length === 0) throw new Error('payload has no files');
        if (files.length > LIMITS.fileCount) {
            throw new Error(`too many files (${files.length} > ${LIMITS.fileCount})`);
        }
        let total = 0;
        for (const f of files) {
            if (!/^[A-Za-z0-9._\-/]+$/.test(f.path)) throw new Error(`illegal file path: ${f.path}`);
            if (f.path.includes('..') || f.path.startsWith('/')) throw new Error(`path traversal: ${f.path}`);
            const buf = fileBufferFromPayload(f);
            if (buf.length > LIMITS.perFile) throw new Error(`file size limit exceeded for ${f.path}`);
            if (f.path === 'SKILL.md' && buf.length > LIMITS.skillMd) {
                throw new Error('SKILL.md size limit exceeded');
            }
            total += buf.length;
            f._buffer = buf;
        }
        if (total > LIMITS.perSkill) throw new Error(`total skill size > ${LIMITS.perSkill}`);
        if (!files.some(f => f.path === 'SKILL.md')) throw new Error('payload missing SKILL.md');
    }

    function computePayloadHash(files) {
        const h = createHash('sha256');
        const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
        for (const f of sorted) {
            h.update(f.path); h.update('\0');
            h.update(sha256(f._buffer)); h.update('\0');
        }
        return h.digest('hex');
    }

    async function previewInstall({ scope, payload }) {
        const files = (payload && payload.files) || [];
        validatePayloadFiles(files);
        const skillMd = files.find(f => f.path === 'SKILL.md');
        const front = parseSkillFrontmatter(skillMd._buffer.toString('utf8'));
        const incomingHash = computePayloadHash(files);

        const existing = await readSkillEntry(scope, front.name).catch(() => null);
        let conflict;
        if (!existing) conflict = 'new';
        else if (existing.installedHash === incomingHash) conflict = 'same';
        else conflict = 'different';

        return {
            name: front.name,
            conflict,
            incomingHash,
            existingHash: existing ? existing.installedHash : null,
        };
    }

    async function install({ scope, payload, conflictStrategy }) {
        const preview = await previewInstall({ scope, payload });
        if (preview.conflict === 'same') return { action: 'already_installed', name: preview.name };
        if (preview.conflict === 'different' && conflictStrategy !== 'replace') {
            if (conflictStrategy === 'skip') return { action: 'skipped', name: preview.name };
            throw new Error(`skill ${preview.name} exists with different content; pass conflictStrategy: 'skip' | 'replace'`);
        }

        const targetDir = join(skillsRoot, encodeScopePath(scope), preview.name);
        const stagingDir = join(
            skillsRoot,
            encodeScopePath(scope),
            `.staging-${preview.name}-${Date.now()}`,
        );

        try {
            await fs.mkdir(stagingDir, { recursive: true });
            for (const f of payload.files) {
                const abs = join(stagingDir, f.path);
                await fs.mkdir(join(abs, '..'), { recursive: true });
                await fs.writeFile(abs, f._buffer);
            }
            await fs.rm(targetDir, { recursive: true, force: true });
            await fs.rename(stagingDir, targetDir);
            return {
                action: preview.conflict === 'different' ? 'replaced' : 'installed',
                name: preview.name,
            };
        } catch (e) {
            await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            throw e;
        }
    }

    // ──────────────────────────── delete / rename / moveScope ────────────────────────────

    async function deleteSkill(name, scope) {
        assertSafeSkillName(name);
        const dir = join(skillsRoot, encodeScopePath(scope), name);
        await fs.rm(dir, { recursive: true, force: true });
    }

    async function rename({ scope, fromName, toName }) {
        assertSafeSkillName(fromName);
        assertSafeSkillName(toName);
        if (!/^[a-z0-9_-]+$/.test(toName) || toName.length > 128) {
            throw new Error(`invalid target name: ${toName}`);
        }
        const fromDir = join(skillsRoot, encodeScopePath(scope), fromName);
        const toDir = join(skillsRoot, encodeScopePath(scope), toName);
        const fromExists = await fs.stat(fromDir).then(s => s.isDirectory()).catch(() => false);
        if (!fromExists) throw new Error(`source skill not found: ${fromName}`);
        const toExists = await fs.stat(toDir).then(() => true).catch(() => false);
        if (toExists) throw new Error(`rename collision: target ${toName} exists`);

        await fs.rename(fromDir, toDir);
        const mdPath = join(toDir, SKILL_MD);
        const md = await fs.readFile(mdPath, 'utf8');
        // Match `name: ...` inside the leading frontmatter block (between the
        // first `---\n` and the closing `\n---`). The non-greedy `(?:.*\n)*?`
        // tolerates `name:` appearing on any line, including the first.
        const replaced = md.replace(
            /^(---\n(?:.*\n)*?)name:\s*[^\n]+/,
            `$1name: ${toName}`,
        );
        await fs.writeFile(mdPath, replaced);
    }

    async function moveScope({ name, fromScope, toScope }) {
        assertSafeSkillName(name);
        const fromDir = join(skillsRoot, encodeScopePath(fromScope), name);
        const toDir = join(skillsRoot, encodeScopePath(toScope), name);
        const fromExists = await fs.stat(fromDir).then(s => s.isDirectory()).catch(() => false);
        if (!fromExists) throw new Error(`source not found: ${name}`);
        const toExists = await fs.stat(toDir).then(() => true).catch(() => false);
        if (toExists) throw new Error(`destination already has skill ${name}; resolve conflict first`);
        await fs.mkdir(join(toDir, '..'), { recursive: true });
        await fs.rename(fromDir, toDir);
    }

    // ──────────────────────────── writeFile / editFile ────────────────────────────

    async function writeFile({ scope, name, path: filePath, content, expectedSha256 }) {
        assertSafeSkillName(name);
        assertSafeFilePath(filePath);
        const skillDir = join(skillsRoot, encodeScopePath(scope), name);
        const exists = await fs.stat(skillDir).then(() => true).catch(() => false);
        if (!exists) throw new Error(`skill not found: ${scopeLabel(scope)}:${name}`);
        const absFile = join(skillDir, filePath);

        if (expectedSha256) {
            const current = await fs.readFile(absFile).catch(() => null);
            const currentHash = current ? sha256(current) : null;
            if (currentHash !== expectedSha256) {
                throw new Error(`sha256 mismatch (expected ${expectedSha256}, got ${currentHash || 'missing'})`);
            }
        }

        await fs.mkdir(join(absFile, '..'), { recursive: true });
        const stagingFile = `${absFile}.staging-${Date.now()}`;
        await fs.writeFile(stagingFile, content);
        await fs.rename(stagingFile, absFile);
        return { sha256: sha256(Buffer.from(content)) };
    }

    async function editFile({ scope, name, path: filePath, oldString, newString, replaceAll = false }) {
        assertSafeSkillName(name);
        assertSafeFilePath(filePath);
        if (!oldString) throw new Error('oldString must be non-empty');
        const absFile = join(skillsRoot, encodeScopePath(scope), name, filePath);
        const current = await fs.readFile(absFile, 'utf8').catch(() => null);
        if (current === null) throw new Error(`file not found: ${filePath}`);

        const occurrences = current.split(oldString).length - 1;
        if (occurrences === 0) throw new Error(`oldString not found in ${filePath}`);
        if (occurrences > 1 && !replaceAll) {
            throw new Error(`multiple matches (${occurrences}); pass replaceAll: true to apply all`);
        }

        const next = replaceAll
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString);

        const stagingFile = `${absFile}.staging-${Date.now()}`;
        await fs.writeFile(stagingFile, next);
        await fs.rename(stagingFile, absFile);
        return {
            sha256: sha256(Buffer.from(next)),
            changesApplied: replaceAll ? occurrences : 1,
        };
    }

    /**
     * Delete a single file inside a skill. Refuses to delete SKILL.md (the
     * skill's manifest must always exist — use the skill-level `delete()`
     * to remove the whole directory). Empty parent directories are pruned
     * upward to avoid leaving stale folders behind, stopping at the skill
     * root.
     */
    async function deleteFileImpl({ scope, name, path: filePath }) {
        assertSafeSkillName(name);
        assertSafeFilePath(filePath);
        if (filePath === SKILL_MD) {
            throw new Error('cannot delete SKILL.md; delete the whole skill instead');
        }
        const skillDir = join(skillsRoot, encodeScopePath(scope), name);
        const absFile = join(skillDir, filePath);
        const exists = await fs.stat(absFile).then(() => true).catch(() => false);
        if (!exists) throw new Error(`file not found: ${filePath}`);
        await fs.unlink(absFile);

        // Prune empty ancestor directories up to (but not including) skillDir.
        // Use a separator-aware split so on POSIX `references/foo.md` →
        // ['references','foo.md'] and we walk up one level. We stop pruning
        // as soon as a non-empty directory shows up so we never touch siblings.
        const segs = filePath.split('/');
        segs.pop(); // drop the filename
        while (segs.length > 0) {
            const dir = join(skillDir, segs.join('/'));
            try {
                const entries = await fs.readdir(dir);
                if (entries.length === 0) {
                    await fs.rmdir(dir);
                    segs.pop();
                } else {
                    break;
                }
            } catch {
                // Race or missing dir — give up pruning, the file is already gone.
                break;
            }
        }
        return { ok: true };
    }

    /**
     * Rename / move a file within a skill. fromPath and toPath are both
     * skill-relative; if toPath has new parent directories they're created
     * on the fly, and empty source ancestors are pruned (mirrors deleteFile).
     * SKILL.md is excluded from both ends — renaming it would orphan the
     * manifest, and overwriting it via rename would bypass parseSkillFrontmatter.
     * Returns the destination's sha256 so the editor can update its
     * optimistic-lock cache without an extra read round-trip.
     */
    async function renameFile({ scope, name, fromPath, toPath }) {
        assertSafeSkillName(name);
        assertSafeFilePath(fromPath);
        assertSafeFilePath(toPath);
        if (fromPath === SKILL_MD) throw new Error('cannot rename SKILL.md');
        if (toPath === SKILL_MD) throw new Error('cannot overwrite SKILL.md via rename');
        if (fromPath === toPath) {
            // No-op rename — still return the current sha256 so callers can
            // refresh their lock cache.
            const skillDir = join(skillsRoot, encodeScopePath(scope), name);
            const buf = await fs.readFile(join(skillDir, fromPath));
            return { ok: true, path: toPath, sha256: sha256(buf) };
        }
        const skillDir = join(skillsRoot, encodeScopePath(scope), name);
        const fromAbs = join(skillDir, fromPath);
        const toAbs = join(skillDir, toPath);
        const fromExists = await fs.stat(fromAbs).then(s => s.isFile()).catch(() => false);
        if (!fromExists) throw new Error(`source file not found: ${fromPath}`);
        const toExists = await fs.stat(toAbs).then(() => true).catch(() => false);
        if (toExists) throw new Error(`destination already exists: ${toPath}`);

        const toParent = dirname(toAbs);
        if (toParent !== skillDir) await fs.mkdir(toParent, { recursive: true });
        await fs.rename(fromAbs, toAbs);

        // Prune empty source ancestor directories (same logic as deleteFile).
        const fromSegs = fromPath.split('/');
        fromSegs.pop();
        while (fromSegs.length > 0) {
            const dir = join(skillDir, fromSegs.join('/'));
            try {
                const entries = await fs.readdir(dir);
                if (entries.length === 0) {
                    await fs.rmdir(dir);
                    fromSegs.pop();
                } else {
                    break;
                }
            } catch {
                break;
            }
        }

        const buf = await fs.readFile(toAbs);
        return { ok: true, path: toPath, sha256: sha256(buf) };
    }

    // ──────────────────────────── listFiles ────────────────────────────

    /**
     * Returns every file in the skill directory, sorted by relative path.
     * Used by the embed packer to walk a skill's contents for packaging.
     */
    async function listFiles({ scope, name }) {
        assertSafeSkillName(name);
        const skillDir = join(skillsRoot, encodeScopePath(scope), name);
        const isDir = await fs.stat(skillDir).then(s => s.isDirectory()).catch(() => false);
        if (!isDir) throw new Error(`skill not found: ${scopeLabel(scope)}:${name}`);
        const files = await walkSkillFiles(skillDir);
        const out = [];
        for (const f of files) {
            const buf = await fs.readFile(join(skillDir, f.relPath));
            out.push({ path: f.relPath, buffer: buf, isBinary: f.isBinary });
        }
        return out;
    }

    // ──────────────────────────── search ────────────────────────────

    /**
     * Substring-search a single file inside a skill, returning matching
     * snippets with surrounding context lines. Used by REST and the
     * skill_search agent tool. Case-insensitive.
     *
     * @param {object} opts
     * @param {object} opts.scope
     * @param {string} opts.name
     * @param {string} opts.query - substring to match (non-empty)
     * @param {string} [opts.path=SKILL.md] - file within the skill to search
     * @param {number} [opts.limit=10] - max number of hits to return
     * @param {number} [opts.contextLines=2] - lines of context above/below
     * @returns {Promise<{hits: Array<{path:string, lineStart:number, lineEnd:number, snippet:string}>}>}
     */
    async function search({ scope, name, query, path: filePath = SKILL_MD, limit = 10, contextLines = 2 }) {
        assertSafeSkillName(name);
        if (filePath !== SKILL_MD) assertSafeFilePath(filePath);
        if (typeof query !== 'string' || query.length === 0) throw new Error('query required');
        const result = await readFile({ scope, name, path: filePath });
        const lines = result.content.split('\n');
        const hits = [];
        const ql = query.toLowerCase();
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(ql)) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length, i + contextLines + 1);
                hits.push({
                    path: filePath,
                    lineStart: start + 1,
                    lineEnd: end,
                    snippet: lines.slice(start, end).join('\n'),
                });
                if (hits.length >= limit) break;
            }
        }
        return { hits };
    }

    // ──────────────────────────── readFile ────────────────────────────

    async function readFile({ scope, name, path: filePath = SKILL_MD, offset, limit }) {
        assertSafeSkillName(name);
        assertSafeFilePath(filePath);
        if (Number.isInteger(offset) && offset < 1) throw new Error('offset must be ≥1');
        if (Number.isInteger(limit) && limit < 0) throw new Error('limit must be ≥0');
        const absFile = join(skillsRoot, encodeScopePath(scope), name, filePath);
        const buf = await fs.readFile(absFile).catch((e) => {
            throw new Error(`cannot read ${filePath}: ${e.message}`);
        });
        if (isBinaryBuffer(buf)) throw new Error(`file is binary: ${filePath}`);

        const text = buf.toString('utf8');
        const allLines = text.split('\n');
        const totalLines = allLines.length;

        let slice = allLines;
        if (Number.isInteger(offset) || Number.isInteger(limit)) {
            const start = Math.max(0, (offset || 1) - 1);  // 1-based to 0-based
            const end = Number.isInteger(limit) ? start + limit : allLines.length;
            slice = allLines.slice(start, end);
        }
        const content = slice.join('\n');
        return { content, totalLines };
    }

    // ──────────────────────────── scope-level ops ────────────────────────────

    async function deleteScope(scope) {
        const scopePath = encodeScopePath(scope);
        const dir = join(skillsRoot, scopePath);
        await fs.rm(dir, { recursive: true, force: true });
    }

    async function assertDirMissing(dir, errMsg) {
        try {
            await fs.access(dir);
        } catch (e) {
            if (e.code === 'ENOENT') return; // good — doesn't exist
            throw e;
        }
        throw new Error(errMsg);
    }

    async function renameScope(scope, newName) {
        let toScope;
        if (scope.kind === 'orch-preset') {
            if (!newName || typeof newName !== 'object'
                || typeof newName.mode !== 'string' || typeof newName.name !== 'string') {
                throw new Error('invalid renameScope: orch-preset requires newName={mode, name}');
            }
            if (newName.mode !== scope.mode) {
                throw new Error('unsupported cross-mode rename (mode must match)');
            }
            toScope = { kind: 'orch-preset', mode: newName.mode, name: newName.name };
        } else if (scope.kind === 'preset') {
            if (typeof newName !== 'string' || newName.length === 0) {
                throw new Error('invalid renameScope: preset newName required as string');
            }
            toScope = { kind: 'preset', name: newName };
        } else if (scope.kind === 'character') {
            if (typeof newName !== 'string' || newName.length === 0) {
                throw new Error('invalid renameScope: character newName required as string');
            }
            toScope = { kind: 'character', characterFile: newName };
        } else {
            throw new Error(`unsupported renameScope for scope kind ${scope.kind}`);
        }
        const fromDir = join(skillsRoot, encodeScopePath(scope));
        const toDir = join(skillsRoot, encodeScopePath(toScope));
        await assertDirMissing(toDir, `renameScope: destination scope already exists: ${scopeLabel(toScope)}`);
        try {
            await fs.rename(fromDir, toDir);
        } catch (e) {
            if (e.code === 'ENOENT') {
                throw new Error(`renameScope: source scope not found: ${scopeLabel(scope)}`);
            }
            throw e;
        }
    }

    async function copyScope(fromScope, toScope) {
        if (fromScope.kind !== toScope.kind) {
            throw new Error(`invalid copyScope: kind mismatch (from=${fromScope.kind}, to=${toScope.kind})`);
        }
        if (fromScope.kind === 'orch-preset' && fromScope.mode !== toScope.mode) {
            throw new Error('unsupported cross-mode copy (mode must match)');
        }
        const fromDir = join(skillsRoot, encodeScopePath(fromScope));
        const toDir = join(skillsRoot, encodeScopePath(toScope));
        try {
            await fs.access(fromDir);
        } catch (e) {
            if (e.code === 'ENOENT') {
                throw new Error(`copyScope: source scope not found: ${scopeLabel(fromScope)}`);
            }
            throw e;
        }
        await assertDirMissing(toDir, `copyScope: destination scope already exists: ${scopeLabel(toScope)}`);
        await fs.cp(fromDir, toDir, { recursive: true });
    }

    return {
        list,
        get,
        previewInstall,
        install,
        delete: deleteSkill,
        rename,
        moveScope,
        writeFile,
        editFile,
        deleteFile: deleteFileImpl,
        renameFile,
        readFile,
        listFiles,
        search,
        deleteScope,
        renameScope,
        copyScope,
    };
}
