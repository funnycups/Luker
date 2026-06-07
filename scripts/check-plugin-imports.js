#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Boundary linter for Luker-new plugins.
 *
 * Contract: a Luker-new plugin in `public/scripts/extensions/<plugin>/**`
 * MUST consume core capabilities through `SillyTavern.getContext()` / the
 * three-layer API, never via cross-boundary import. Cross-plugin coupling
 * (Luker-new plugin → another Luker-new plugin) is also disallowed —
 * sibling plugins talk over the published `getExtensionApi(name)` registry
 * (see `docs/development/extension-api/*`). Reverse coupling (core
 * importing a plugin) is the third banned direction. Upstream-shipped
 * extensions (regex, quick-reply, connection-manager, …) are out of scope.
 *
 * Detection
 * ---------
 * For each Luker-new plugin path, scan every `.js` for `import ... from
 * '<path>'` statements (static + dynamic). Any specifier resolving to:
 *   1. A core file (escapes `extensions/` and is not Luker platform), or
 *   2. A sibling Luker-new plugin directory
 * is a violation. Luker self-platform layer (`iteration-library/`,
 * `skills/`, `lib/edits/`, `vendor/`) is the only whitelisted escape.
 *
 * For the reverse direction, scan `public/script.js` plus every
 * `public/scripts/*.js` (non-extensions) plus `src/**\/*.js`, and flag
 * any import whose specifier resolves into a Luker-new plugin directory.
 *
 * Output is grouped by plugin; exit code is non-zero when any violation
 * is detected so CI can fail the run.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXT_DIR = resolve(REPO_ROOT, 'public/scripts/extensions');

const LUKER_PLUGIN_DIRS = new Set([
    'card-app',
    'character-editor-assistant',
    'completion-preset-assistant',
    'memory-graph',
    'orchestrator',
    'search-tools',
]);

const LUKER_PLATFORM_DIRS = new Set([
    'iteration-library',
    'skills',
    'lib',
    'vendor',
]);

const IMPORT_RE = /(?:^|[\s;])import(?:\s+(?:[^'"]+from\s+)?)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /\/\/[^\n]*/g;

function maskComments(source) {
    // Replace comments with same-length whitespace so offsets stay valid.
    return source
        .replace(BLOCK_COMMENT_RE, m => m.replace(/[^\n]/g, ' '))
        .replace(LINE_COMMENT_RE, m => m.replace(/[^\n]/g, ' '));
}

function listJsFilesRecursive(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...listJsFilesRecursive(full));
        } else if (name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

function listJsFilesShallow(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.js')) continue;
        const full = join(dir, name);
        if (statSync(full).isFile()) out.push(full);
    }
    return out;
}

function extractSpecifiers(source) {
    const out = [];
    const masked = maskComments(source);
    IMPORT_RE.lastIndex = 0;
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(masked)) !== null) {
        out.push({ spec: m[1], offset: m.index });
    }
    while ((m = DYNAMIC_IMPORT_RE.exec(masked)) !== null) {
        out.push({ spec: m[1], offset: m.index });
    }
    return out;
}

function offsetToLine(source, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < source.length; i++) {
        if (source[i] === '\n') line++;
    }
    return line;
}

function classifyForPlugin(specifier, fromFile, pluginDir) {
    if (!specifier.startsWith('.')) return null;
    const resolved = resolve(fromFile, '..', specifier);
    const relFromExt = relative(EXT_DIR, resolved).split(sep);

    if (relFromExt[0] === '..') {
        // Escapes extensions/. Either core or Luker platform layer.
        const rel = relative(resolve(EXT_DIR, '..'), resolved).split(sep);
        if (rel[0] === '..') return { kind: 'core', target: relative(REPO_ROOT, resolved) };
        if (LUKER_PLATFORM_DIRS.has(rel[0])) return null;
        return { kind: 'core', target: relative(REPO_ROOT, resolved) };
    }

    if (relFromExt[0] === pluginDir) return null;

    if (LUKER_PLUGIN_DIRS.has(relFromExt[0])) {
        return { kind: 'plugin', target: relative(REPO_ROOT, resolved), peer: relFromExt[0] };
    }

    return null;
}

function findPluginViolations() {
    const coreViolations = new Map();
    const pluginViolations = new Map();
    for (const pluginDir of LUKER_PLUGIN_DIRS) {
        const pluginRoot = join(EXT_DIR, pluginDir);
        try { statSync(pluginRoot); } catch { continue; }
        const files = listJsFilesRecursive(pluginRoot);
        const coreHits = [];
        const pluginHits = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            for (const { spec, offset } of extractSpecifiers(source)) {
                const verdict = classifyForPlugin(spec, file, pluginDir);
                if (!verdict) continue;
                const hit = {
                    file: relative(REPO_ROOT, file),
                    line: offsetToLine(source, offset),
                    spec,
                    target: verdict.target,
                };
                if (verdict.kind === 'core') {
                    coreHits.push(hit);
                } else if (verdict.kind === 'plugin') {
                    pluginHits.push({ ...hit, peer: verdict.peer });
                }
            }
        }
        if (coreHits.length > 0) coreViolations.set(pluginDir, coreHits);
        if (pluginHits.length > 0) pluginViolations.set(pluginDir, pluginHits);
    }
    return { coreViolations, pluginViolations };
}

function findReverseViolations() {
    const sources = [];
    sources.push(resolve(REPO_ROOT, 'public/script.js'));
    sources.push(...listJsFilesShallow(resolve(REPO_ROOT, 'public/scripts')));

    const srcDir = resolve(REPO_ROOT, 'src');
    try {
        statSync(srcDir);
        sources.push(...listJsFilesRecursive(srcDir));
    } catch { /* src missing — skip */ }

    const hits = [];
    for (const file of sources) {
        let source;
        try { source = readFileSync(file, 'utf8'); } catch { continue; }
        for (const { spec, offset } of extractSpecifiers(source)) {
            if (!spec.startsWith('.')) continue;
            const resolved = resolve(file, '..', spec);
            const relFromExt = relative(EXT_DIR, resolved).split(sep);
            if (relFromExt[0] === '..' || relFromExt[0] === '') continue;
            if (LUKER_PLUGIN_DIRS.has(relFromExt[0])) {
                hits.push({
                    file: relative(REPO_ROOT, file),
                    line: offsetToLine(source, offset),
                    spec,
                    target: relative(REPO_ROOT, resolved),
                });
            }
        }
    }
    return hits;
}

function main() {
    const { coreViolations, pluginViolations } = findPluginViolations();
    const reverseViolations = findReverseViolations();

    let total = 0;
    if (coreViolations.size > 0) {
        console.log('Plugin → core violations:');
        for (const [plugin, hits] of coreViolations) {
            console.log(`  ${plugin}/`);
            for (const h of hits) {
                console.log(`    ${h.file}:${h.line}  import '${h.spec}'  →  ${h.target}`);
                total++;
            }
        }
    }

    if (pluginViolations.size > 0) {
        console.log('Plugin → plugin violations:');
        for (const [plugin, hits] of pluginViolations) {
            console.log(`  ${plugin}/`);
            for (const h of hits) {
                console.log(`    ${h.file}:${h.line}  import '${h.spec}'  →  ${h.target}   (peer: ${h.peer})`);
                total++;
            }
        }
    }

    if (reverseViolations.length > 0) {
        console.log('Core → plugin violations:');
        for (const h of reverseViolations) {
            console.log(`  ${h.file}:${h.line}  import '${h.spec}'  →  ${h.target}`);
            total++;
        }
    }

    if (total === 0) {
        console.log('No plugin boundary violations.');
        process.exit(0);
    }

    console.error(`\n${total} violation(s) found.`);
    console.error('Fix:');
    console.error('  - plugin → core:    consume via SillyTavern.getContext().');
    console.error('  - plugin → plugin:  consume via SillyTavern.getContext().getExtensionApi(name); provider publishes via registerExtensionApi(name, api).');
    console.error('  - core → plugin:    move the symbol the other way; core never imports from extensions/<luker-plugin>/.');
    process.exit(1);
}

main();
