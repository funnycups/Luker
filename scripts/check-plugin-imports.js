#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Boundary linter for Luker-new plugins.
 *
 * Contract: a Luker-new plugin in `public/scripts/extensions/<plugin>/**`
 * MUST consume core capabilities through `Luker.getContext()` / the
 * three-layer API, never via cross-boundary import. Cross-plugin coupling
 * (Luker-new plugin → another Luker-new plugin or banned peer) is also
 * disallowed — sibling plugins talk over the published `getExtensionApi(name)`
 * registry (see `docs/development/extension-api/*`). Reverse coupling (core or
 * the Luker platform layer importing a plugin) is banned as well.
 *
 * Detection
 * ---------
 * Every `import ... from '<spec>'`, `export ... from '<spec>'`, and dynamic
 * `import('<spec>')` is resolved to a repo path: relative specifiers against
 * the importing file, absolute `/scripts/...` or `/script.js` specifiers
 * against `public/`. Other specifiers (bare packages, non-`/scripts/` absolute
 * bundles) are ignored.
 *
 *   1. Plugin files: a target outside `extensions/` that is not in the Luker
 *      platform layer (`iteration-library/`, `lens-shared/`, `run-panel/`,
 *      `workbench/`, `skills/`, `lib/`, `vendor/`) is a plugin → core
 *      violation; a target in a sibling banned extension directory is a
 *      plugin → plugin violation.
 *   2. Platform-layer files (`workbench/`, `lens-shared/`, `run-panel/` ban
 *      any `extensions/*` import; all `LUKER_PLATFORM_DIRS` ban any Luker-new
 *      plugin import).
 *   3. Core files (`public/script.js`, `public/scripts/*.js`, `src/**`):
 *      a target inside any Luker-new plugin directory is a core → plugin
 *      violation.
 *
 * Output is grouped by direction; exit code is non-zero when any violation
 * is detected so CI can fail the run.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.LUKER_LINT_ROOT
    ? resolve(process.env.LUKER_LINT_ROOT)
    : resolve(fileURLToPath(new URL('..', import.meta.url)));

export const LUKER_PLUGIN_DIRS = new Set([
    'card-app',
    'character-editor-assistant',
    'completion-preset-assistant',
    'memory-graph',
    'orchestrator',
    'search-tools',
]);

export const BANNED_EXTENSION_PEERS = new Set([
    ...LUKER_PLUGIN_DIRS,
    'regex',
]);

export const LUKER_PLATFORM_DIRS = new Set([
    'iteration-library',
    'lens-shared',
    'run-panel',
    'skills',
    'lib',
    'vendor',
    'workbench',
]);

export const PLATFORM_REVERSE_SCAN_DIRS = [
    'workbench',
    'lens-shared',
    'run-panel',
];

const IMPORT_RE = /(?:^|[\s;])import(?:\s+(?:[^'"]+from\s+)?)?['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|[\s;])export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
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
    let names;
    try {
        names = readdirSync(dir);
    } catch (err) {
        if (err?.code === 'ENOENT') return out;
        throw err;
    }
    for (const name of names) {
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
    let names;
    try {
        names = readdirSync(dir);
    } catch (err) {
        if (err?.code === 'ENOENT') return out;
        throw err;
    }
    for (const name of names) {
        if (!name.endsWith('.js')) continue;
        const full = join(dir, name);
        if (statSync(full).isFile()) out.push(full);
    }
    return out;
}

function extractSpecifiers(source) {
    const out = [];
    const masked = maskComments(source);
    for (const re of [IMPORT_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(masked)) !== null) {
            // The leading `(?:^|[\s;])` group may consume the preceding
            // newline; anchor the reported offset on the keyword itself.
            out.push({ spec: m[1], offset: m.index + Math.max(0, m[0].search(/\b(?:import|export)\b/)) });
        }
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

/**
 * Resolve an import specifier to an absolute filesystem path, or null when
 * the specifier is out of scope (bare package, non-`/scripts/` absolute).
 */
function resolveSpecifier(specifier, fromFile, repoRoot = REPO_ROOT) {
    if (specifier.startsWith('.')) {
        return resolve(fromFile, '..', specifier);
    }
    if (specifier.startsWith('/scripts/') || specifier === '/script.js') {
        return resolve(repoRoot, 'public', specifier.slice(1));
    }
    return null;
}

export function classifyForPlugin(specifier, fromFile, pluginDir, repoRoot = REPO_ROOT) {
    const resolved = resolveSpecifier(specifier, fromFile, repoRoot);
    if (!resolved) return null;
    const extDir = resolve(repoRoot, 'public/scripts/extensions');
    const relFromExt = relative(extDir, resolved).split(sep);

    if (relFromExt[0] === '..') {
        // Escapes extensions/. Either core or Luker platform layer.
        const rel = relative(resolve(extDir, '..'), resolved).split(sep);
        if (rel[0] === '..') return { kind: 'core', target: relative(repoRoot, resolved) };
        if (LUKER_PLATFORM_DIRS.has(rel[0])) return null;
        return { kind: 'core', target: relative(repoRoot, resolved) };
    }

    if (relFromExt[0] === pluginDir) return null;

    if (BANNED_EXTENSION_PEERS.has(relFromExt[0])) {
        return { kind: 'plugin', target: relative(repoRoot, resolved), peer: relFromExt[0] };
    }

    return null;
}

export function findPluginViolations(repoRoot = REPO_ROOT) {
    const extDir = resolve(repoRoot, 'public/scripts/extensions');
    const coreViolations = new Map();
    const pluginViolations = new Map();
    for (const pluginDir of LUKER_PLUGIN_DIRS) {
        const pluginRoot = join(extDir, pluginDir);
        try {
            statSync(pluginRoot);
        } catch (err) {
            if (err?.code === 'ENOENT') continue;
            throw err;
        }
        const files = listJsFilesRecursive(pluginRoot);
        const coreHits = [];
        const pluginHits = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            for (const { spec, offset } of extractSpecifiers(source)) {
                const verdict = classifyForPlugin(spec, file, pluginDir, repoRoot);
                if (!verdict) continue;
                const hit = {
                    file: relative(repoRoot, file),
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

export function findPlatformViolations(repoRoot = REPO_ROOT) {
    const extDir = resolve(repoRoot, 'public/scripts/extensions');
    const strictDirs = new Set(PLATFORM_REVERSE_SCAN_DIRS);
    const hits = [];
    for (const platformDir of LUKER_PLATFORM_DIRS) {
        const dirPath = resolve(repoRoot, 'public/scripts', platformDir);
        const banAllExtensions = strictDirs.has(platformDir);
        for (const file of listJsFilesRecursive(dirPath)) {
            let source;
            try {
                source = readFileSync(file, 'utf8');
            } catch (err) {
                if (err?.code === 'ENOENT') continue;
                throw err;
            }
            for (const { spec, offset } of extractSpecifiers(source)) {
                const resolved = resolveSpecifier(spec, file, repoRoot);
                if (!resolved) continue;
                const relFromExt = relative(extDir, resolved).split(sep);
                if (relFromExt[0] === '..' || relFromExt[0] === '') continue;
                if (banAllExtensions || LUKER_PLUGIN_DIRS.has(relFromExt[0])) {
                    hits.push({
                        file: relative(repoRoot, file),
                        line: offsetToLine(source, offset),
                        spec,
                        target: relative(repoRoot, resolved),
                    });
                }
            }
        }
    }
    return hits;
}

export function findReverseViolations(repoRoot = REPO_ROOT) {
    const extDir = resolve(repoRoot, 'public/scripts/extensions');
    const sources = [];
    sources.push({ file: resolve(repoRoot, 'public/script.js'), banAllExtensions: false });

    const scriptsDir = resolve(repoRoot, 'public/scripts');
    for (const file of listJsFilesShallow(scriptsDir)) {
        sources.push({ file, banAllExtensions: false });
    }

    for (const platformDir of PLATFORM_REVERSE_SCAN_DIRS) {
        const dirPath = resolve(repoRoot, 'public/scripts', platformDir);
        for (const file of listJsFilesRecursive(dirPath)) {
            sources.push({ file, banAllExtensions: true });
        }
    }

    const srcDir = resolve(repoRoot, 'src');
    for (const file of listJsFilesRecursive(srcDir)) {
        sources.push({ file, banAllExtensions: false });
    }

    const hits = [];
    for (const { file, banAllExtensions } of sources) {
        let source;
        try {
            source = readFileSync(file, 'utf8');
        } catch (err) {
            if (err?.code === 'ENOENT') continue;
            throw err;
        }
        for (const { spec, offset } of extractSpecifiers(source)) {
            const resolved = resolveSpecifier(spec, file, repoRoot);
            if (!resolved) continue;
            const relFromExt = relative(extDir, resolved).split(sep);
            if (relFromExt[0] === '..' || relFromExt[0] === '') continue;
            if (banAllExtensions || LUKER_PLUGIN_DIRS.has(relFromExt[0])) {
                hits.push({
                    file: relative(repoRoot, file),
                    line: offsetToLine(source, offset),
                    spec,
                    target: relative(repoRoot, resolved),
                });
            }
        }
    }
    return hits;
}

function main() {
    const { coreViolations, pluginViolations } = findPluginViolations();
    const platformViolations = findPlatformViolations();
    const platformFiles = new Set(platformViolations.map(h => `${h.file}:${h.line}:${h.spec}`));
    const reverseViolations = findReverseViolations().filter(h => !platformFiles.has(`${h.file}:${h.line}:${h.spec}`));

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

    if (platformViolations.length > 0) {
        console.log('Platform → plugin violations:');
        for (const h of platformViolations) {
            console.log(`  ${h.file}:${h.line}  import '${h.spec}'  →  ${h.target}`);
            total++;
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
    console.error('  - plugin → core:      consume via Luker.getContext(), or move an import-free leaf module into public/scripts/lib/.');
    console.error('  - plugin → plugin:    consume via Luker.getContext().getExtensionApi(name); provider publishes via registerExtensionApi(name, api).');
    console.error('  - platform → plugin:  move the symbol into the platform layer; platform modules never import a plugin.');
    console.error('  - core → plugin:      move the symbol the other way; core never imports from extensions/<luker-plugin>/.');
    process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
