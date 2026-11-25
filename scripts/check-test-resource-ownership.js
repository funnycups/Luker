#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * AST and import-boundary guard for test resource ownership.
 *
 * Prevents new tests outside `tests/harness/**` from introducing unregistered:
 *   - root temp directory allocations (`mkdtemp`/`mkdtempSync`, `os.tmpdir()`, `.e2e-scratch`)
 *   - raw subprocess allocations (`node:child_process` / `child_process`)
 *   - raw external database clients or containers (`mysql2`, `pg`, `testcontainers`)
 *   - Proxy-based global/runtime stubs (`new Proxy(...)`)
 *   - `--forceExit` flags in `tests/package.json`
 *
 * Ordinary fixture reads and writes inside managed directories (`fs.mkdirSync`,
 * `fs.writeFileSync`, `fs.readFileSync`, `fs.copyFileSync`, `fs.renameSync`)
 * remain allowed. No comment-based suppressions or formatting heuristics exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE_PATH = path.join(REPO_ROOT, 'scripts/test-resource-ownership-baseline.json');

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const OS_MODULES = new Set(['os', 'node:os']);
const CP_MODULES = new Set(['child_process', 'node:child_process']);
const DB_MODULES = new Set(['mysql2', 'mysql2/promise', 'pg', 'testcontainers']);
const MKDTEMP_NAMES = new Set(['mkdtemp', 'mkdtempSync']);
const CP_CALL_NAMES = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const DB_CALL_NAMES = new Set(['createPool', 'createConnection']);
const DB_CONSTRUCTORS = new Set(['Client', 'Pool', 'GenericContainer']);

function listTestFiles(testsDir) {
    const out = [];
    if (!fs.existsSync(testsDir)) return out;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const rel = path.relative(testsDir, full).replace(/\\/g, '/');
                if (rel === 'harness' || rel.startsWith('harness/')) continue;
                walk(full);
            } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
                out.push(full);
            }
        }
    };
    walk(testsDir);
    out.sort();
    return out;
}

function parseAst(source, filePath) {
    const isCjs = filePath.endsWith('.cjs');
    try {
        return acorn.parse(source, {
            ecmaVersion: 'latest',
            sourceType: isCjs ? 'script' : 'module',
            locations: true,
            allowHashBang: true,
        });
    } catch (moduleError) {
        if (isCjs) throw moduleError;
        return acorn.parse(source, {
            ecmaVersion: 'latest',
            sourceType: 'script',
            locations: true,
            allowHashBang: true,
        });
    }
}

function walkAst(node, visitors, ancestors = []) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) walkAst(item, visitors, ancestors);
        return;
    }
    if (typeof node.type !== 'string') return;
    const handler = visitors[node.type];
    if (handler) handler(node, ancestors);
    ancestors.push(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
        if (value && typeof value === 'object') walkAst(value, visitors, ancestors);
    }
    ancestors.pop();
}

function staticStringValue(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
        return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
    }
    return null;
}

function memberPropertyName(member) {
    if (!member || member.type !== 'MemberExpression') return null;
    if (!member.computed && member.property.type === 'Identifier') return member.property.name;
    return staticStringValue(member.property);
}

function isPlaywrightIgnoreGlob(ancestors) {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const parent = ancestors[i];
        if (parent.type === 'Property') {
            const key = parent.key?.type === 'Identifier' ? parent.key.name : staticStringValue(parent.key);
            if (key === 'testIgnore') return true;
        }
    }
    return false;
}

function analyzeFile(absPath, relPath) {
    const source = fs.readFileSync(absPath, 'utf8');
    const ast = parseAst(source, absPath);
    const findings = [];

    const fsNamespaces = new Set();
    const fsDirectMkdtemp = new Set();
    const osNamespaces = new Set();
    const osDirectTmpdir = new Set();
    const cpNamespaces = new Set();
    const cpDirectCalls = new Set();
    const dbNamespaces = new Set();
    const dbDirectCalls = new Set();
    const dbDirectConstructors = new Set();

    const record = (node, category, message) => {
        findings.push({
            file: relPath,
            line: node.loc?.start?.line ?? 1,
            category,
            message,
        });
    };

    // Pass 1: collect lexical module bindings from static imports and CommonJS requires.
    walkAst(ast, {
        ImportDeclaration(node) {
            const mod = staticStringValue(node.source);
            if (!mod) return;
            if (CP_MODULES.has(mod)) {
                record(node, 'unregistered-process', `Direct import from '${mod}' outside tests/harness/`);
            }
            if (DB_MODULES.has(mod)) {
                record(node, 'unregistered-database', `Direct import from '${mod}' outside tests/harness/`);
            }
            for (const spec of node.specifiers) {
                const local = spec.local?.name;
                if (!local) continue;
                if (FS_MODULES.has(mod)) {
                    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
                        fsNamespaces.add(local);
                    } else if (spec.type === 'ImportSpecifier' && MKDTEMP_NAMES.has(spec.imported.name)) {
                        fsDirectMkdtemp.add(local);
                    }
                } else if (OS_MODULES.has(mod)) {
                    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
                        osNamespaces.add(local);
                    } else if (spec.type === 'ImportSpecifier' && spec.imported.name === 'tmpdir') {
                        osDirectTmpdir.add(local);
                    }
                } else if (CP_MODULES.has(mod)) {
                    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
                        cpNamespaces.add(local);
                    } else if (spec.type === 'ImportSpecifier' && CP_CALL_NAMES.has(spec.imported.name)) {
                        cpDirectCalls.add(local);
                    }
                } else if (DB_MODULES.has(mod)) {
                    if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
                        dbNamespaces.add(local);
                    } else if (spec.type === 'ImportSpecifier') {
                        if (DB_CALL_NAMES.has(spec.imported.name)) dbDirectCalls.add(local);
                        if (DB_CONSTRUCTORS.has(spec.imported.name)) dbDirectConstructors.add(local);
                    }
                }
            }
        },
        VariableDeclarator(node) {
            const init = node.init?.type === 'AwaitExpression' ? node.init.argument : node.init;
            if (!init) return;
            let mod = null;
            if (init.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === 'require') {
                mod = staticStringValue(init.arguments[0]);
            } else if (init.type === 'ImportExpression') {
                mod = staticStringValue(init.source);
            }
            if (!mod) return;
            const bindId = (idName, importedName) => {
                if (FS_MODULES.has(mod)) {
                    if (!importedName) fsNamespaces.add(idName);
                    else if (MKDTEMP_NAMES.has(importedName)) fsDirectMkdtemp.add(idName);
                } else if (OS_MODULES.has(mod)) {
                    if (!importedName) osNamespaces.add(idName);
                    else if (importedName === 'tmpdir') osDirectTmpdir.add(idName);
                } else if (CP_MODULES.has(mod)) {
                    if (!importedName) cpNamespaces.add(idName);
                    else if (CP_CALL_NAMES.has(importedName)) cpDirectCalls.add(idName);
                } else if (DB_MODULES.has(mod)) {
                    if (!importedName) dbNamespaces.add(idName);
                    else {
                        if (DB_CALL_NAMES.has(importedName)) dbDirectCalls.add(idName);
                        if (DB_CONSTRUCTORS.has(importedName)) dbDirectConstructors.add(idName);
                    }
                }
            };
            if (node.id.type === 'Identifier') {
                bindId(node.id.name, null);
            } else if (node.id.type === 'ObjectPattern') {
                for (const prop of node.id.properties) {
                    if (prop.type === 'Property' && prop.value.type === 'Identifier') {
                        const keyName = prop.key.type === 'Identifier' ? prop.key.name : staticStringValue(prop.key);
                        if (keyName) bindId(prop.value.name, keyName);
                    }
                }
            }
        },
    });

    // Pass 2: detect actual allocations, dynamic imports, require calls, and Proxy stubs.
    walkAst(ast, {
        ImportExpression(node) {
            const mod = staticStringValue(node.source);
            if (!mod) return;
            if (CP_MODULES.has(mod)) {
                record(node, 'unregistered-process', `Dynamic import('${mod}') outside tests/harness/`);
            } else if (DB_MODULES.has(mod)) {
                record(node, 'unregistered-database', `Dynamic import('${mod}') outside tests/harness/`);
            }
        },
        CallExpression(node, ancestors) {
            if (node.callee.type === 'Identifier') {
                const name = node.callee.name;
                if (name === 'require') {
                    const mod = staticStringValue(node.arguments[0]);
                    if (mod && CP_MODULES.has(mod)) {
                        record(node, 'unregistered-process', `Direct require('${mod}') outside tests/harness/`);
                    } else if (mod && DB_MODULES.has(mod)) {
                        record(node, 'unregistered-database', `Direct require('${mod}') outside tests/harness/`);
                    }
                    return;
                }
                if (fsDirectMkdtemp.has(name)) {
                    record(node, 'unregistered-root-directory', `Unregistered temporary directory allocation via ${name}()`);
                } else if (osDirectTmpdir.has(name)) {
                    record(node, 'unregistered-root-directory', `Unregistered OS temp root lookup via ${name}()`);
                } else if (cpDirectCalls.has(name)) {
                    record(node, 'unregistered-process', `Unregistered subprocess call via ${name}()`);
                } else if (dbDirectCalls.has(name)) {
                    record(node, 'unregistered-database', `Unregistered database call via ${name}()`);
                }
            } else if (node.callee.type === 'MemberExpression') {
                const prop = memberPropertyName(node.callee);
                const obj = node.callee.object;
                const objName = obj.type === 'Identifier'
                    ? obj.name
                    : obj.type === 'MemberExpression' && obj.object.type === 'Identifier' && memberPropertyName(obj) === 'promises'
                        ? obj.object.name
                        : null;
                if (prop && MKDTEMP_NAMES.has(prop) && objName && fsNamespaces.has(objName)) {
                    record(node, 'unregistered-root-directory', `Unregistered temporary directory allocation via ${objName}.${prop}()`);
                } else if (prop === 'tmpdir' && objName && osNamespaces.has(objName)) {
                    record(node, 'unregistered-root-directory', `Unregistered OS temp root lookup via ${objName}.tmpdir()`);
                } else if (prop && CP_CALL_NAMES.has(prop) && objName && cpNamespaces.has(objName)) {
                    record(node, 'unregistered-process', `Unregistered subprocess call via ${objName}.${prop}()`);
                } else if (prop && DB_CALL_NAMES.has(prop) && objName && dbNamespaces.has(objName)) {
                    record(node, 'unregistered-database', `Unregistered database call via ${objName}.${prop}()`);
                }
            }

            // Detect explicit path joins/resolves constructing `.e2e-scratch` paths.
            if (node.callee.type === 'MemberExpression') {
                const prop = memberPropertyName(node.callee);
                if (prop === 'join' || prop === 'resolve') {
                    for (const arg of node.arguments) {
                        const value = staticStringValue(arg);
                        if (value && value.includes('.e2e-scratch') && !isPlaywrightIgnoreGlob(ancestors)) {
                            record(node, 'unregistered-root-directory', 'Path construction targeting legacy .e2e-scratch root');
                        }
                    }
                }
            }
        },
        NewExpression(node) {
            if (node.callee.type === 'Identifier') {
                if (node.callee.name === 'Proxy') {
                    record(node, 'unregistered-proxy-stub', 'Unregistered Proxy stub outside managed harness');
                } else if (dbDirectConstructors.has(node.callee.name)) {
                    record(node, 'unregistered-database', `Unregistered database client via new ${node.callee.name}()`);
                }
            } else if (node.callee.type === 'MemberExpression') {
                const prop = memberPropertyName(node.callee);
                const objName = node.callee.object.type === 'Identifier' ? node.callee.object.name : null;
                if (prop && DB_CONSTRUCTORS.has(prop) && objName && dbNamespaces.has(objName)) {
                    record(node, 'unregistered-database', `Unregistered database client via new ${objName}.${prop}()`);
                }
            }
        },
    });

    return findings;
}

function checkTestsPackageJson(repoRoot) {
    const pkgPath = path.join(repoRoot, 'tests/package.json');
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const findings = [];
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (typeof script === 'string' && /--forceExit\b/.test(script)) {
            findings.push({
                file: 'tests/package.json',
                line: 1,
                category: 'force-exit-command',
                message: `Script "${name}" uses --forceExit`,
            });
        }
    }
    return findings;
}

export function scanTestResourceOwnership(repoRoot = REPO_ROOT, options = {}) {
    const testsDir = path.join(repoRoot, 'tests');
    const files = listTestFiles(testsDir);
    const allFindings = [...checkTestsPackageJson(repoRoot)];

    for (const absPath of files) {
        const relPath = path.relative(repoRoot, absPath).replace(/\\/g, '/');
        allFindings.push(...analyzeFile(absPath, relPath));
    }

    let baseline = options.baseline;
    if (baseline === undefined) {
        const baselinePath = options.baselinePath ?? path.join(repoRoot, 'scripts/test-resource-ownership-baseline.json');
        baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
    }

    if (!baseline) {
        return {
            findings: allFindings,
            violations: allFindings,
            staleBaseline: [],
        };
    }

    const countsByFile = new Map();
    for (const finding of allFindings) {
        let perCategory = countsByFile.get(finding.file);
        if (!perCategory) {
            perCategory = new Map();
            countsByFile.set(finding.file, perCategory);
        }
        perCategory.set(finding.category, (perCategory.get(finding.category) ?? 0) + 1);
    }

    const allowedRemaining = new Map();
    for (const [file, cats] of Object.entries(baseline.files ?? {})) {
        allowedRemaining.set(file, new Map(Object.entries(cats)));
    }

    const violations = [];
    for (const finding of allFindings) {
        if (finding.category === 'force-exit-command') {
            violations.push(finding);
            continue;
        }
        const fileBudget = allowedRemaining.get(finding.file);
        const remaining = fileBudget?.get(finding.category) ?? 0;
        if (remaining > 0) {
            fileBudget.set(finding.category, remaining - 1);
        } else {
            violations.push(finding);
        }
    }

    const staleBaseline = [];
    for (const [file, cats] of Object.entries(baseline.files ?? {})) {
        const observed = countsByFile.get(file);
        for (const [category, count] of Object.entries(cats)) {
            const actual = observed?.get(category) ?? 0;
            if (actual < count) {
                staleBaseline.push({ file, category, baselined: count, actual });
            }
        }
    }

    return { findings: allFindings, violations, staleBaseline };
}

function buildBaselineSnapshot(findings) {
    const files = {};
    for (const finding of findings) {
        if (finding.category === 'force-exit-command') continue;
        files[finding.file] ??= {};
        files[finding.file][finding.category] = (files[finding.file][finding.category] ?? 0) + 1;
    }
    const sortedFiles = {};
    for (const key of Object.keys(files).sort()) {
        const sortedCats = {};
        for (const cat of Object.keys(files[key]).sort()) {
            sortedCats[cat] = files[key][cat];
        }
        sortedFiles[key] = sortedCats;
    }
    return {
        format: 'test-resource-ownership-baseline-v1',
        files: sortedFiles,
    };
}

function main() {
    const args = process.argv.slice(2);
    const repoRoot = process.env.LUKER_LINT_ROOT ? path.resolve(process.env.LUKER_LINT_ROOT) : REPO_ROOT;
    if (args.includes('--write-baseline')) {
        const { findings } = scanTestResourceOwnership(repoRoot, { baseline: null });
        const snapshot = buildBaselineSnapshot(findings);
        fs.writeFileSync(DEFAULT_BASELINE_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
        console.log(`Wrote baseline with ${Object.keys(snapshot.files).length} legacy test file(s).`);
        process.exit(0);
    }

    const { violations, staleBaseline } = scanTestResourceOwnership(repoRoot);
    if (violations.length === 0 && staleBaseline.length === 0) {
        console.log('No test resource ownership violations.');
        process.exit(0);
    }
    if (violations.length > 0) {
        console.error('Test resource ownership violations:');
        for (const v of violations) {
            console.error(`  ${v.file}:${v.line} [${v.category}] ${v.message}`);
        }
    }
    if (staleBaseline.length > 0) {
        console.error('Stale entries in scripts/test-resource-ownership-baseline.json (shrink baseline):');
        for (const s of staleBaseline) {
            console.error(`  ${s.file} [${s.category}] baselined=${s.baselined} actual=${s.actual}`);
        }
    }
    process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
