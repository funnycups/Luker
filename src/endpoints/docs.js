import path from 'node:path';
import fs from 'node:fs';

import express from 'express';

import { serverDirectory } from '../server-directory.js';
import { resolvePathWithinParent } from '../util.js';

export const router = express.Router();

const DOCS_ROOT = path.join(serverDirectory, 'docs');
const SKIP_DIRS = new Set(['node_modules', '.vitepress', 'dist', 'cache']);
const MAX_FILE_BYTES = 1024 * 1024;

function listMarkdownFiles(rootDir) {
    const results = [];
    if (!fs.existsSync(rootDir)) return results;

    const walk = (dir, relPrefix) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const name = entry.name;
            if (name.startsWith('.') && name !== '.vitepress') continue;
            const absPath = path.join(dir, name);
            const relPath = relPrefix ? `${relPrefix}/${name}` : name;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(name)) continue;
                walk(absPath, relPath);
            } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
                let size = 0;
                try { size = fs.statSync(absPath).size; } catch { /* ignore */ }
                results.push({ path: relPath, size });
            }
        }
    };

    walk(rootDir, '');
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
}

router.get('/list', (request, response) => {
    try {
        const files = listMarkdownFiles(DOCS_ROOT);
        return response.send({ root: 'docs', count: files.length, files });
    } catch (error) {
        console.error('[docs] /list failed:', error);
        return response.status(500).send({ error: 'Failed to list docs' });
    }
});

router.get('/file', (request, response) => {
    try {
        const requested = String(request.query.path || '').trim();
        if (!requested) {
            return response.status(400).send({ error: 'path query parameter is required' });
        }
        if (!/\.md$/i.test(requested)) {
            return response.status(400).send({ error: 'Only .md files are accessible via this endpoint' });
        }

        const resolved = resolvePathWithinParent(DOCS_ROOT, requested);
        if (!resolved) {
            return response.status(400).send({ error: 'Invalid or unsafe path' });
        }

        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
            return response.status(404).send({ error: 'File not found' });
        }

        const stat = fs.statSync(resolved);
        if (stat.size > MAX_FILE_BYTES) {
            return response.status(413).send({ error: `File exceeds ${MAX_FILE_BYTES} bytes` });
        }

        const content = fs.readFileSync(resolved, 'utf-8');
        return response.send({
            path: requested.replace(/\\/g, '/'),
            size: stat.size,
            content,
        });
    } catch (error) {
        console.error('[docs] /file failed:', error);
        return response.status(500).send({ error: 'Failed to read doc' });
    }
});
