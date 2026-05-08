#!/usr/bin/env node
// Pre-render d2 fence blocks into docs/public/diagrams/ via the local d2 CLI,
// using the same filename scheme as vitepress-plugin-diagrams so the plugin's
// "skip if file exists" cache hits and never calls Kroki.
//
// Token indices (positionId) must match vitepress's parser exactly, so we
// borrow vitepress's createMarkdownRenderer rather than parsing with a bare
// markdown-it (which would miss vitepress's container/anchor/etc. plugins).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMarkdownRenderer } from 'vitepress';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(SCRIPT_DIR, '..');
const DIAGRAMS_DIR = path.join(DOCS_DIR, 'public', 'diagrams');
const SUPPORTED_TYPES = new Set(['d2']);
const DRY_RUN = process.argv.includes('--dry-run');

function findMarkdownFiles(dir) {
    const out = [];
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const p = path.join(cur, entry.name);
            if (entry.isDirectory()) stack.push(p);
            else if (entry.name.endsWith('.md')) out.push(p);
        }
    }
    return out;
}

function extractDiagramId(tokens, idx) {
    const next = tokens[idx + 1];
    if (next && next.type === 'html_block') {
        const m = next.content.match(/<!--\s*diagram(?:\s+id="([^"]+)")?/);
        return m?.[1]?.trim();
    }
    return undefined;
}

function buildFilename(type, normalizedContent, id, positionId) {
    const hash = createHash('md5').update(normalizedContent).digest('hex');
    if (id) return `${type}-${id}-${hash}.svg`;
    if (positionId) return `${type}-${positionId}-${hash}.svg`;
    return `${type}-${hash}.svg`;
}

function renderD2(content, outPath) {
    const tmpFile = path.join(os.tmpdir(), `vpd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.d2`);
    fs.writeFileSync(tmpFile, content);
    try {
        execFileSync('d2', [tmpFile, outPath], { stdio: 'inherit' });
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

async function main() {
    if (!DRY_RUN) {
        fs.mkdirSync(DIAGRAMS_DIR, { recursive: true });
    }
    const md = await createMarkdownRenderer(DOCS_DIR);
    let total = 0, rendered = 0, skipped = 0;
    const dryRunRows = [];

    for (const filepath of findMarkdownFiles(DOCS_DIR)) {
        const src = fs.readFileSync(filepath, 'utf-8');
        const tokens = md.parse(src, {});
        const fileBase = path.basename(filepath, '.md');

        tokens.forEach((token, idx) => {
            if (token.type !== 'fence') return;
            const type = token.info.trim().toLowerCase();
            if (!SUPPORTED_TYPES.has(type)) return;

            total++;
            const content = token.content.trim().replaceAll('\r\n', '\n');
            const id = extractDiagramId(tokens, idx);
            const positionId = `${fileBase}-${idx}`;
            const svgName = buildFilename(type, content, id, positionId);
            const outPath = path.join(DIAGRAMS_DIR, svgName);

            if (DRY_RUN) {
                dryRunRows.push({ md: path.relative(DOCS_DIR, filepath), svgName });
                return;
            }

            if (fs.existsSync(outPath)) {
                skipped++;
                return;
            }

            console.log(`[render] ${type} ${path.relative(DOCS_DIR, filepath)} -> ${svgName}`);
            renderD2(content, outPath);
            rendered++;
        });
    }

    if (DRY_RUN) {
        for (const row of dryRunRows) {
            console.log(`${row.md}\t${row.svgName}`);
        }
        console.log(`\n[dry-run] total: ${dryRunRows.length}`);
        return;
    }

    console.log(`\n[done] total: ${total}, rendered: ${rendered}, skipped: ${skipped}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
