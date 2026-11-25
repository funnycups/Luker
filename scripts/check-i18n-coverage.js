#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

/**
 * Locale coverage checker for Luker's zh-CN / zh-TW translations.
 *
 * Contract
 * --------
 * `public/locales/*.json` forms the global translation map; upstream and
 * third-party extensions may still merge into it with `addLocaleData`.
 * Luker plugins (LUKER_PLUGINS) keep their tables private: each passes them
 * to `createPluginI18n` (or `createScopedI18n`), which reads the plugin
 * table first and falls back to the global map. Rules:
 *
 *   1. Keys rendered by the shared platform layer (`iteration-library/`,
 *      `lib/`, `run-panel/`, `skills/`) live in both JSON files.
 *   2. Luker plugins never use `addLocaleData`, never read the core
 *      `translate` / `t` from the Luker context, and never emit
 *      `data-i18n` (the global observer translates it from the global map).
 *      Their `createPluginI18n` tables argument resolves statically.
 *   3. Other extension `addLocaleData` tables never change a JSON value and
 *      never disagree with each other.
 *   4. Each table owner registers the same key set for zh-cn and zh-tw.
 *   5. The JSON files have no duplicate keys; a table never repeats a key.
 *   6. A `data-i18n` attribute never contains a known key with an
 *      unescaped `;` (splitI18nKeys would cut it into fragments).
 *   7. `addLocaleData` tables outside extensions only carry `sim.*` keys
 *      (the simulation-review namespace), and every `sim.*` key used by
 *      shared code exists in the simulation-review zh-cn and zh-tw tables.
 *
 * Detection is AST-based (acorn, shipped with webpack): translator calls
 * `t('…')`, `i18n('…')`, `translate('…')`, `tr/tf/i18nFormat/translator`
 * (bare or as a member), tagged templates t`…` (placeholders become
 * `${0}`, `${1}`, …), format wrappers whose first argument is a
 * translator (`fmt(i18n, '…')`, `formatWithI18n(i18n, '…')`),
 * a key argument that is a same-file `const` (scope-aware), `||` / `??`,
 * a ternary, or a member of a `const` object literal resolved to its
 * string values (`unresolvedSharedCalls` lists shared calls that stay
 * dynamic),
 * `data-i18n="…"` inside string/template literals and `.html` files, and
 * the `STR` constants of `iteration-library/ui/strings.js`. Tables are the
 * object literals passed to `addLocaleData(locale, {...})` (kind `global`)
 * and the `{ [locale]: {...} }` argument of `createPluginI18n` /
 * `createScopedI18n` (kind `scoped`). Translator calls of every owner are
 * recorded in `callsByOwner`.
 *
 * Usage
 * -----
 *   node scripts/check-i18n-coverage.js           # report + exit 1 on violation
 *   node scripts/check-i18n-coverage.js --json F  # also dump the inventory to F
 *
 * `collectInventory(root)` and `runChecks(inventory)` are exported for
 * migration tooling.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const acorn = require('acorn');

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const LOCALES = ['zh-cn', 'zh-tw'];
export const SHARED_DIRS = ['iteration-library', 'lens-shared', 'lib', 'run-panel', 'skills', 'workbench'];
export const LUKER_PLUGINS = ['orchestrator', 'memory-graph', 'character-editor-assistant', 'completion-preset-assistant', 'search-tools', 'card-app'];
const TRANSLATOR_NAMES = new Set(['t', 'i18n', 'translate', 'tr', 'tf', 'i18nFormat', 'tFormat', 'translator']);
const SCOPED_FACTORIES = new Set(['createPluginI18n', 'createScopedI18n']);
const CORE_TRANSLATOR_PROPS = new Set(['translate', 't']);
const CONTEXT_OBJECT_NAMES = new Set(['__ctx']);
const SIM_TABLE_OWNER = 'core:iteration-library/simulation-review';
export const CORE_LOCALE_DATA_OWNERS = new Set([
    'core:lens-shared/locale-data',
    'core:run-panel/locale-data',
    'core:workbench/locale-data',
]);
const SIM_PREFIX = 'sim.';

function toPosix(p) {
    return p.split(sep).join('/');
}

function listFiles(dir, exts, out = []) {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) listFiles(full, exts, out);
        else if (exts.some(x => name.endsWith(x))) out.push(full);
    }
    return out;
}

function parseModule(src) {
    return acorn.parse(src, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
        allowHashBang: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
    });
}

function walk(node, cb) {
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n.type !== 'string') continue;
        cb(n);
        for (const k of Object.keys(n)) {
            if (k === 'loc') continue;
            const v = n[k];
            if (Array.isArray(v)) {
                for (const c of v) if (c && typeof c.type === 'string') stack.push(c);
            } else if (v && typeof v.type === 'string') {
                stack.push(v);
            }
        }
    }
}

function propKey(p) {
    if (!p || p.type !== 'Property') return null;
    if (p.key.type === 'Literal') return String(p.key.value);
    if (p.key.type === 'Identifier' && !p.computed) return p.key.name;
    return null;
}

function stringValue(n) {
    if (!n) return null;
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
    if (n.type === 'BinaryExpression' && n.operator === '+') {
        const a = stringValue(n.left);
        const b = stringValue(n.right);
        return a != null && b != null ? a + b : null;
    }
    return null;
}

function templateKey(tpl) {
    return tpl.quasis.map((q, i) => q.value.cooked + (i < tpl.expressions.length ? '${' + i + '}' : '')).join('');
}

function calleeName(callee) {
    if (callee.type === 'Identifier') return callee.name;
    if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
    return null;
}

/** Splits a data-i18n attribute value the same way public/scripts/i18n.js does. */
export function splitI18nKeys(raw) {
    const parts = [];
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '\\' && raw[i + 1] === ';') { cur += ';'; i++; continue; }
        if (ch === ';') { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts.map(k => {
        const m = k.match(/\[(\S+)\](.+)/);
        return m ? m[2] : k;
    });
}

const DATA_I18N_RE = /data-i18n\s*=\s*(["'])([\s\S]*?)\1/g;
function dataI18nValues(text) {
    const out = [];
    DATA_I18N_RE.lastIndex = 0;
    let m;
    while ((m = DATA_I18N_RE.exec(text)) !== null) out.push(m[2]);
    return out;
}

/** Flat-object JSON scanner that keeps every occurrence (JSON.parse keeps only the last). */
export function scanJsonEntries(text) {
    const out = [];
    let i = 0;
    let line = 1;
    let depth = 0;
    let pendingKey = null;
    let keyLine = 0;
    const readString = () => {
        let raw = '';
        i++;
        while (text[i] !== '"') {
            if (text[i] === '\\') { raw += text.slice(i, i + 2); i += 2; continue; }
            if (text[i] === '\n') line++;
            raw += text[i++];
        }
        i++;
        return JSON.parse('"' + raw + '"');
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n') { line++; i++; continue; }
        if (c === '{') { depth++; i++; continue; }
        if (c === '}') { depth--; i++; continue; }
        if (c === '"') {
            const at = line;
            const s = readString();
            if (pendingKey === null) {
                pendingKey = s;
                keyLine = at;
            } else {
                if (depth === 1) out.push({ key: pendingKey, value: s, line: keyLine });
                pendingKey = null;
            }
            continue;
        }
        if (c === ',') pendingKey = null;
        i++;
    }
    return out;
}

export function ownerOfFile(rel) {
    const m = rel.match(/^public\/scripts\/extensions\/([^/]+)\//);
    if (m) return m[1];
    const s = rel.match(/^public\/scripts\/([^/]+)\//);
    if (s && SHARED_DIRS.includes(s[1])) return 'shared';
    return 'core';
}

const BLOCK_SCOPE_TYPES = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function patternNames(p, out = []) {
    if (!p) return out;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
    else if (p.type === 'ArrayPattern') for (const e of p.elements) patternNames(e, out);
    else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
    else if (p.type === 'RestElement') patternNames(p.argument, out);
    return out;
}

const bindingCache = new WeakMap();
/**
 * Every binding of the module with the span of the scope that declares it.
 * Only `const` bindings to a plain identifier carry an `init`; parameters,
 * `let`/`var`, functions, classes and catch params are recorded without one
 * so they still shadow outer names. `declInit` holds the initializer of a
 * `const` or `let` binding to a plain identifier.
 * @returns {Map<string, Array<{start:number, end:number, init:object|null, declInit:object|null, importDefault:string|null}>>}
 */
function moduleBindings(ast) {
    if (bindingCache.has(ast)) return bindingCache.get(ast);
    const bindings = new Map();
    const add = (name, scope, init = null, importDefault = null, declInit = null) => {
        if (!bindings.has(name)) bindings.set(name, []);
        bindings.get(name).push({ start: scope.start, end: scope.end, init, declInit, importDefault });
    };
    const nearest = (anc, types) => {
        for (let i = anc.length - 1; i >= 0; i--) if (types(anc[i])) return anc[i];
        return anc[0];
    };
    const anc = [];
    const visit = n => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'VariableDeclaration') {
            const scope = n.kind === 'var'
                ? nearest(anc, a => FUNCTION_TYPES.has(a.type) || a.type === 'Program')
                : nearest(anc, a => BLOCK_SCOPE_TYPES.has(a.type));
            for (const d of n.declarations) {
                const init = n.kind === 'const' && d.id.type === 'Identifier' ? d.init : null;
                const declInit = n.kind !== 'var' && d.id.type === 'Identifier' ? d.init : null;
                for (const name of patternNames(d.id)) add(name, scope, init, null, declInit);
            }
        } else if (FUNCTION_TYPES.has(n.type)) {
            if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name, nearest(anc, a => BLOCK_SCOPE_TYPES.has(a.type)));
            if (n.type === 'FunctionExpression' && n.id) add(n.id.name, n);
            for (const p of n.params) for (const name of patternNames(p)) add(name, n);
        } else if (n.type === 'ClassDeclaration' && n.id) {
            add(n.id.name, nearest(anc, a => BLOCK_SCOPE_TYPES.has(a.type)));
        } else if (n.type === 'CatchClause' && n.param) {
            for (const name of patternNames(n.param)) add(name, n);
        } else if (n.type === 'ImportDeclaration') {
            for (const s of n.specifiers) add(s.local.name, ast, null, s.type === 'ImportDefaultSpecifier' ? n.source.value : null);
        }
        anc.push(n);
        for (const k of Object.keys(n)) {
            if (k === 'loc') continue;
            const v = n[k];
            if (Array.isArray(v)) for (const c of v) visit(c);
            else if (v && typeof v.type === 'string') visit(v);
        }
        anc.pop();
    };
    visit(ast);
    bindingCache.set(ast, bindings);
    return bindings;
}

/** Innermost binding of `name` whose scope contains source offset `pos`. */
function lookupBinding(ast, name, pos) {
    let best = null;
    for (const b of moduleBindings(ast).get(name) || []) {
        if (pos < b.start || pos > b.end) continue;
        if (!best || b.end - b.start < best.end - best.start) best = b;
    }
    return best;
}

function resolveTableObject(ast, node, file) {
    if (!node) return null;
    if (node.type === 'ObjectExpression') return { obj: node, file };
    if (node.type === 'Identifier') return resolveIdentifier(ast, node.name, node.start, file);
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
        const base = resolveIdentifier(ast, node.object.name, node.start, file);
        if (!base) return null;
        const key = node.computed ? stringValue(node.property) : node.property.name;
        const p = base.obj.properties.find(pp => propKey(pp) === key);
        return p && p.value.type === 'ObjectExpression' ? { obj: p.value, file: base.file } : null;
    }
    return null;
}

function resolveIdentifier(ast, name, pos, file) {
    const b = lookupBinding(ast, name, pos);
    if (!b) return null;
    if (b.init) return resolveTableObject(ast, b.init, file);
    if (!b.importDefault || !/^\.\.?\//.test(b.importDefault)) return null;
    const target = resolve(dirname(file), b.importDefault);
    if (!existsSync(target)) return null;
    const ast2 = parseModule(readFileSync(target, 'utf8'));
    const def = ast2.body.find(s => s.type === 'ExportDefaultDeclaration');
    if (!def) return null;
    return resolveTableObject(ast2, def.declaration, target);
}

function hasInterpolatedTemplate(n) {
    if (!n) return false;
    if (n.type === 'TemplateLiteral' && n.expressions.length > 0) return true;
    if (n.type === 'LogicalExpression' && (n.operator === '||' || n.operator === '??')) {
        return hasInterpolatedTemplate(n.left) || hasInterpolatedTemplate(n.right);
    }
    if (n.type === 'ConditionalExpression') {
        return hasInterpolatedTemplate(n.consequent) || hasInterpolatedTemplate(n.alternate);
    }
    return false;
}

/**
 * Keys a translator argument can evaluate to. Follows same-file `const`
 * bindings (scope-aware), `||` / `??`, ternaries, and member access on a
 * const object literal (a non-literal computed member yields every value).
 * `unresolved` is set when some branch cannot be evaluated statically.
 */
function argumentKeys(ast, n, seen = new Set()) {
    const out = { keys: [], unresolved: false };
    const merge = r => { out.keys.push(...r.keys); out.unresolved ||= r.unresolved; };
    const s = stringValue(n);
    if (s != null) out.keys.push(s);
    else if (n.type === 'TemplateLiteral') out.keys.push(templateKey(n));
    else if (n.type === 'LogicalExpression' && (n.operator === '||' || n.operator === '??')) {
        merge(argumentKeys(ast, n.left, seen));
        merge(argumentKeys(ast, n.right, seen));
    } else if (n.type === 'ConditionalExpression') {
        merge(argumentKeys(ast, n.consequent, seen));
        merge(argumentKeys(ast, n.alternate, seen));
    } else if (n.type === 'Identifier') {
        const b = lookupBinding(ast, n.name, n.start);
        if (b?.init && !seen.has(b)) merge(argumentKeys(ast, b.init, new Set([...seen, b])));
        else out.unresolved = true;
    } else if (n.type === 'MemberExpression') {
        const obj = constObject(ast, n.object, seen);
        if (!obj) out.unresolved = true;
        else {
            const key = n.computed ? stringValue(n.property) : n.property.name;
            const props = key != null ? obj.properties.filter(p => propKey(p) === key) : obj.properties.filter(p => p.type === 'Property');
            if (props.length === 0) out.unresolved = true;
            for (const p of props) merge(argumentKeys(ast, p.value, seen));
        }
    } else {
        out.unresolved = true;
    }
    return out;
}

function constObject(ast, n, seen) {
    if (n.type === 'ObjectExpression') return n;
    if (n.type === 'Identifier') {
        const b = lookupBinding(ast, n.name, n.start);
        return b?.init && !seen.has(b) ? constObject(ast, b.init, new Set([...seen, b])) : null;
    }
    if (n.type === 'MemberExpression') {
        const base = constObject(ast, n.object, seen);
        const key = n.computed ? stringValue(n.property) : n.property.name;
        const p = base && key != null ? base.properties.find(pp => propKey(pp) === key) : null;
        return p ? constObject(ast, p.value, seen) : null;
    }
    return null;
}

/**
 * @param {string} [root]
 */
export function collectInventory(root = DEFAULT_ROOT) {
    const publicDir = resolve(root, 'public');
    const rel = p => toPosix(relative(root, p));
    const isScanned = r => !r.startsWith('public/lib/')
        && !r.startsWith('public/scripts/extensions/third-party/')
        && !r.includes('.bundle.')
        && !r.endsWith('.min.js');
    const jsFiles = listFiles(publicDir, ['.js', '.mjs']).filter(f => isScanned(rel(f)));
    const htmlFiles = listFiles(publicDir, ['.html']).filter(f => isScanned(rel(f)));

    /** @type {Array<{owner:string, locale:string, file:string, objectStart:number, objectEnd:number, startLine:number, endLine:number, entries: Map<string,{value:string,line:number,start:number,end:number,valueStart:number,valueEnd:number}>, duplicates: Array<[string, number]>}>} */
    const tables = [];
    const tableRanges = new Map();
    const parseErrors = [];
    const asts = new Map();
    /** Luker plugin addLocaleData / scoped factory calls whose table or locale is not statically resolvable: [{file, line, callee, what}] */
    const unresolvedTables = [];

    for (const f of jsFiles) {
        const r = rel(f);
        const src = readFileSync(f, 'utf8');
        let ast;
        try {
            ast = parseModule(src);
        } catch (err) {
            parseErrors.push({ file: r, message: err.message });
            continue;
        }
        asts.set(f, { ast, src });
        if (r === 'public/scripts/i18n.js') continue;
        if (!src.includes('addLocaleData') && ![...SCOPED_FACTORIES].some(name => src.includes(name))) continue;
        const owner = (() => {
            const o = ownerOfFile(r);
            if (o === 'core' || o === 'shared') return 'core:' + r.replace(/^public\/scripts\//, '').split('/').slice(0, 2).join('/').replace(/\.js$/, '').replace(/\/i18n$/, '');
            return o;
        })();
        const lukerPlugin = LUKER_PLUGINS.includes(owner);
        const pushTable = (kind, locale, resolved) => {
            const entries = new Map();
            const duplicates = [];
            for (const p of resolved.obj.properties) {
                const k = propKey(p);
                const v = stringValue(p.value);
                if (k == null || v == null) continue;
                if (entries.has(k)) duplicates.push([k, p.loc.start.line]);
                entries.set(k, { value: v, line: p.loc.start.line, start: p.start, end: p.end, valueStart: p.value.start, valueEnd: p.value.end });
            }
            tables.push({
                owner,
                kind,
                locale,
                file: rel(resolved.file),
                objectStart: resolved.obj.start,
                objectEnd: resolved.obj.end,
                startLine: resolved.obj.loc.start.line,
                endLine: resolved.obj.loc.end.line,
                entries,
                duplicates,
            });
            if (!tableRanges.has(resolved.file)) tableRanges.set(resolved.file, []);
            tableRanges.get(resolved.file).push([resolved.obj.start, resolved.obj.end]);
        };
        walk(ast, n => {
            if (n.type !== 'CallExpression') return;
            const name = calleeName(n.callee);
            if (!name) return;
            const unresolved = what => {
                if (lukerPlugin) unresolvedTables.push({ file: r, line: n.loc.start.line, callee: name, what });
            };
            if (/^_?addLocaleData$/.test(name)) {
                const locale = stringValue(n.arguments[0]);
                const resolved = locale ? resolveTableObject(ast, n.arguments[1], f) : null;
                if (resolved) pushTable('global', locale, resolved);
                else unresolved(locale ? 'table' : 'locale');
                return;
            }
            if (!SCOPED_FACTORIES.has(name)) return;
            const outer = resolveTableObject(ast, n.arguments[0], f);
            if (!outer || outer.file !== f) {
                unresolved('tables argument');
                return;
            }
            for (const p of outer.obj.properties) {
                const locale = propKey(p);
                const resolved = locale ? resolveTableObject(ast, p.value, f) : null;
                if (resolved) pushTable('scoped', locale, resolved);
                else unresolved(locale ? `${locale} table` : 'locale');
            }
        });
    }

    /** literal occurrences outside locale tables: key -> Set(owner) and key -> Set(file) */
    const literalOwners = new Map();
    const literalFiles = new Map();
    const addLiteral = (k, r) => {
        if (!literalOwners.has(k)) { literalOwners.set(k, new Set()); literalFiles.set(k, new Set()); }
        literalOwners.get(k).add(ownerOfFile(r));
        literalFiles.get(k).add(r);
    };
    /** precise translator call sites in shared code: key -> Set('file:line') */
    const sharedCalls = new Map();
    const addShared = (k, site) => {
        if (!sharedCalls.has(k)) sharedCalls.set(k, new Set());
        sharedCalls.get(k).add(site);
    };
    /** translator call sites per owner (plugin dir, 'shared' or 'core'): owner -> key -> Set('file:line') */
    const callsByOwner = new Map();
    const addOwnerCall = (owner, k, site) => {
        if (!callsByOwner.has(owner)) callsByOwner.set(owner, new Map());
        const byKey = callsByOwner.get(owner);
        if (!byKey.has(k)) byKey.set(k, new Set());
        byKey.get(k).add(site);
    };
    /** raw data-i18n attribute values: [{file, line, raw}] (line is null for .html files) */
    const dataI18n = [];
    /** shared translator calls whose argument is (partly) dynamic: [{site, expression, keys}] */
    const unresolvedSharedCalls = [];
    /** non-tagged translator calls passed an interpolated template literal: [{site, expression}] */
    const interpolatedCalls = [];
    /** Luker plugin reads of addLocaleData: [{file, line}] */
    const addLocaleDataRefs = [];
    /** Luker plugin reads of the core translate / t from the Luker context: [{file, line, name}] */
    const coreTranslateRefs = [];
    const unwrapChain = n => (n?.type === 'ChainExpression' ? n.expression : n);
    const isGetContextCall = n => {
        const u = unwrapChain(n);
        return u?.type === 'CallExpression' && calleeName(u.callee) === 'getContext';
    };
    // A local const/let counts as the Luker context when its initializer is a
    // getContext() call or a ternary / logical with such a call as a direct
    // branch. Parameters carry no initializer, so caller-supplied contexts
    // (the simulation callers) stay out.
    const isContextInit = n => {
        const u = unwrapChain(n);
        if (!u) return false;
        if (isGetContextCall(u)) return true;
        if (u.type === 'ConditionalExpression') return isGetContextCall(u.consequent) || isGetContextCall(u.alternate);
        if (u.type === 'LogicalExpression') return isGetContextCall(u.left) || isGetContextCall(u.right);
        return false;
    };
    const isContextObject = (ast, o) => {
        const u = unwrapChain(o);
        if (isGetContextCall(u)) return true;
        if (u?.type !== 'Identifier') return false;
        if (CONTEXT_OBJECT_NAMES.has(u.name)) return true;
        return isContextInit(lookupBinding(ast, u.name, u.start)?.declInit);
    };

    for (const [f, { ast, src }] of asts) {
        const r = rel(f);
        const ranges = tableRanges.get(f) || [];
        const inTable = n => ranges.some(([a, b]) => n.start >= a && n.end <= b);
        const owner = ownerOfFile(r);
        const shared = owner === 'shared';
        const lukerPlugin = LUKER_PLUGINS.includes(owner);
        walk(ast, n => {
            if (inTable(n)) return;
            if (n.type === 'Literal' && typeof n.value === 'string') {
                addLiteral(n.value, r);
                for (const raw of dataI18nValues(n.value)) {
                    dataI18n.push({ file: r, line: n.loc.start.line, raw });
                    for (const k of splitI18nKeys(raw)) {
                        addLiteral(k, r);
                        if (shared) addShared(k, `${r}:${n.loc.start.line}`);
                    }
                }
            } else if (n.type === 'TemplateLiteral') {
                addLiteral(templateKey(n), r);
                for (const raw of dataI18nValues(n.quasis.map(q => q.value.cooked).join('\u0000'))) {
                    dataI18n.push({ file: r, line: n.loc.start.line, raw });
                    for (const k of splitI18nKeys(raw)) {
                        addLiteral(k, r);
                        if (shared) addShared(k, `${r}:${n.loc.start.line}`);
                    }
                }
            }
            if (lukerPlugin) {
                if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
                    if (n.property.name === 'addLocaleData') addLocaleDataRefs.push({ file: r, line: n.loc.start.line });
                    else if (CORE_TRANSLATOR_PROPS.has(n.property.name) && isContextObject(ast, n.object)) coreTranslateRefs.push({ file: r, line: n.loc.start.line, name: n.property.name });
                } else if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.init && isContextObject(ast, n.init)) {
                    for (const p of n.id.properties) {
                        const k = propKey(p);
                        if (k === 'addLocaleData') addLocaleDataRefs.push({ file: r, line: p.loc.start.line });
                        else if (CORE_TRANSLATOR_PROPS.has(k)) coreTranslateRefs.push({ file: r, line: p.loc.start.line, name: k });
                    }
                }
            }
            const site = `${r}:${n.loc.start.line}`;
            if (n.type === 'CallExpression') {
                const name = calleeName(n.callee);
                let arg = n.arguments[0];
                let isTranslator = name && TRANSLATOR_NAMES.has(name);
                const first = n.arguments[0];
                const firstName = first && (first.type === 'Identifier' ? first.name : (first.type === 'MemberExpression' && !first.computed ? first.property.name : null));
                if (firstName && TRANSLATOR_NAMES.has(firstName) && n.arguments[1]) {
                    isTranslator = true;
                    arg = n.arguments[1];
                }
                if (!isTranslator || !arg) return;
                if (hasInterpolatedTemplate(arg)) {
                    interpolatedCalls.push({ site, expression: src.slice(arg.start, arg.end) });
                }
                const { keys, unresolved } = argumentKeys(ast, arg);
                for (const key of keys) {
                    if (key === '') continue;
                    addOwnerCall(owner, key, site);
                    if (shared) addShared(key, site);
                }
                if (unresolved && shared) unresolvedSharedCalls.push({ site, expression: src.slice(arg.start, arg.end), keys });
            } else if (n.type === 'TaggedTemplateExpression') {
                const name = n.tag.type === 'Identifier' ? n.tag.name : null;
                if (!name || !TRANSLATOR_NAMES.has(name)) return;
                const key = templateKey(n.quasi);
                if (key === '') return;
                addOwnerCall(owner, key, site);
                if (shared) addShared(key, site);
            }
        });
    }

    const stringsFile = resolve(root, 'public/scripts/iteration-library/ui/strings.js');
    const stringsEntry = asts.get(stringsFile);
    if (stringsEntry) {
        walk(stringsEntry.ast, n => {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'STR' && n.init?.type === 'ObjectExpression') {
                for (const p of n.init.properties) {
                    const v = stringValue(p.value);
                    if (v) addShared(v, `public/scripts/iteration-library/ui/strings.js:${p.loc.start.line} (STR)`);
                }
            }
        });
    }

    for (const f of htmlFiles) {
        const r = rel(f);
        const text = readFileSync(f, 'utf8');
        for (const raw of dataI18nValues(text)) {
            dataI18n.push({ file: r, line: null, raw });
            for (const k of splitI18nKeys(raw)) {
                addLiteral(k, r);
                if (ownerOfFile(r) === 'shared') addShared(k, r);
            }
        }
    }

    const json = {};
    const jsonDuplicates = {};
    for (const locale of LOCALES) {
        const file = resolve(root, `public/locales/${locale}.json`);
        const text = readFileSync(file, 'utf8');
        const entries = scanJsonEntries(text);
        const seen = new Map();
        for (const e of entries) {
            if (!seen.has(e.key)) seen.set(e.key, []);
            seen.get(e.key).push(e);
        }
        jsonDuplicates[locale] = [...seen].filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({ key, occurrences: arr }));
        json[locale] = JSON.parse(text);
    }

    return { root, tables, json, jsonDuplicates, literalOwners, literalFiles, sharedCalls, callsByOwner, unresolvedSharedCalls, interpolatedCalls, dataI18n, addLocaleDataRefs, coreTranslateRefs, unresolvedTables, parseErrors };
}

/** Template-literal attribute values join quasis with NUL in place of each `${…}`; show it as `$`. */
function shownRaw(raw) {
    return raw.replaceAll('\u0000', '$');
}

/**
 * @param {ReturnType<typeof collectInventory>} inv
 * @returns {Array<{check:string, message:string}>}
 */
export function runChecks(inv) {
    const violations = [];
    const push = (check, message) => violations.push({ check, message });

    for (const e of inv.parseErrors) push('parse', `${e.file}: cannot parse (${e.message})`);

    for (const locale of LOCALES) {
        for (const d of inv.jsonDuplicates[locale]) {
            push('json-duplicate', `public/locales/${locale}.json: ${JSON.stringify(d.key)} defined on lines ${d.occurrences.map(o => o.line).join(', ')}`);
        }
    }

    {
        const cnKeys = new Set(Object.keys(inv.json['zh-cn']));
        const twKeys = new Set(Object.keys(inv.json['zh-tw']));
        for (const k of [...cnKeys].sort()) if (!twKeys.has(k)) push('json-parity', `public/locales/zh-tw.json lacks key ${JSON.stringify(k)} present in zh-cn.json`);
        for (const k of [...twKeys].sort()) if (!cnKeys.has(k)) push('json-parity', `public/locales/zh-cn.json lacks key ${JSON.stringify(k)} present in zh-tw.json`);
    }

    for (const c of inv.interpolatedCalls || []) {
        push('interpolated-call', `${c.site}: interpolated template literal ${c.expression} passed to a non-tagged translator; use i18nFormat/tFormat with '\${0}' placeholders or tagged t\`...\``);
    }

    const simTables = Object.fromEntries(LOCALES.map(l => [l, inv.tables.find(t => t.owner === SIM_TABLE_OWNER && t.locale === l)]));
    const coreLocaleDataEntries = Object.fromEntries(LOCALES.map(l => {
        const keys = new Set();
        for (const t of inv.tables) {
            if (CORE_LOCALE_DATA_OWNERS.has(t.owner) && t.locale === l) {
                for (const k of t.entries.keys()) keys.add(k);
            }
        }
        return [l, keys];
    }));
    for (const [key, sites] of [...inv.sharedCalls].sort((a, b) => a[0].localeCompare(b[0]))) {
        const where = [...sites].sort().join(', ');
        for (const locale of LOCALES) {
            if (key.startsWith(SIM_PREFIX)) {
                if (!simTables[locale]?.entries.has(key)) push('shared-sim-missing', `${locale}: ${JSON.stringify(key)} missing from the simulation-review table (used at ${where})`);
            } else if (!Object.hasOwn(inv.json[locale], key) && !coreLocaleDataEntries[locale].has(key)) {
                push('shared-missing', `public/locales/${locale}.json lacks shared key ${JSON.stringify(key)} (used at ${where})`);
            }
        }
    }

    for (const t of inv.tables) {
        if (t.owner.startsWith('core:') && !CORE_LOCALE_DATA_OWNERS.has(t.owner)) {
            for (const [k, e] of t.entries) {
                if (!k.startsWith(SIM_PREFIX)) push('core-table', `${t.file}:${e.line} (${t.locale}): non-plugin addLocaleData table defines ${JSON.stringify(k)}; move it to public/locales/${t.locale}.json`);
            }
            continue;
        }
        if (!LOCALES.includes(t.locale)) continue;
        for (const [k, line] of t.duplicates) push('table-duplicate', `${t.file}:${line} (${t.owner}, ${t.locale}): ${JSON.stringify(k)} defined twice in the same table`);
    }

    for (const t of inv.tables) {
        if (t.kind === 'global' && LUKER_PLUGINS.includes(t.owner)) push('plugin-add-locale-data', `${t.file}:${t.startLine} (${t.owner}, ${t.locale}): table registered with addLocaleData; pass it to createPluginI18n`);
    }
    for (const ref of inv.addLocaleDataRefs) push('plugin-add-locale-data', `${ref.file}:${ref.line}: Luker plugin reads addLocaleData`);
    for (const u of inv.unresolvedTables) {
        if (/^_?addLocaleData$/.test(u.callee)) push('plugin-add-locale-data', `${u.file}:${u.line}: Luker plugin calls ${u.callee} with an unresolvable ${u.what}; pass the table to createPluginI18n`);
        else push('unresolved-table', `${u.file}:${u.line}: ${u.callee} ${u.what} is not a same-file object literal or const; the checker cannot verify it`);
    }
    for (const ref of inv.coreTranslateRefs) push('plugin-core-translate', `${ref.file}:${ref.line}: Luker plugin reads the core ${ref.name} from the Luker context; translate through its createPluginI18n translator`);
    for (const d of inv.dataI18n) {
        if (LUKER_PLUGINS.includes(ownerOfFile(d.file))) push('plugin-data-i18n', `${d.file}${d.line ? `:${d.line}` : ''}: data-i18n="${shownRaw(d.raw)}" in plugin-rendered markup; render the text through the plugin translator`);
    }

    const otherGlobal = inv.tables.filter(t => t.kind === 'global' && (!t.owner.startsWith('core:') || CORE_LOCALE_DATA_OWNERS.has(t.owner)) && !LUKER_PLUGINS.includes(t.owner) && LOCALES.includes(t.locale));
    for (const t of otherGlobal) {
        for (const [k, e] of t.entries) {
            if (Object.hasOwn(inv.json[t.locale], k) && inv.json[t.locale][k] !== e.value) {
                push('global-table-override', `${t.file}:${e.line} (${t.owner}, ${t.locale}): ${JSON.stringify(k)} = ${JSON.stringify(e.value)} replaces the public/locales/${t.locale}.json value ${JSON.stringify(inv.json[t.locale][k])} everywhere`);
            }
        }
    }
    for (const locale of LOCALES) {
        const byKey = new Map();
        for (const t of otherGlobal.filter(x => x.locale === locale)) {
            for (const [k, e] of t.entries) {
                if (!byKey.has(k)) byKey.set(k, []);
                byKey.get(k).push({ owner: t.owner, value: e.value, at: `${t.file}:${e.line}` });
            }
        }
        for (const [k, list] of byKey) {
            if (new Set(list.map(x => x.owner)).size > 1 && new Set(list.map(x => x.value)).size > 1) {
                push('global-table-collision', `${locale}: ${JSON.stringify(k)} differs between ${list.map(x => `${x.owner} (${x.at}) ${JSON.stringify(x.value)}`).join(', ')}`);
            }
        }
    }

    const byOwner = new Map();
    for (const t of inv.tables) {
        if (!LOCALES.includes(t.locale)) continue;
        if (!byOwner.has(t.owner)) byOwner.set(t.owner, {});
        const slot = byOwner.get(t.owner);
        slot[t.locale] = new Set([...(slot[t.locale] || []), ...t.entries.keys()]);
    }
    for (const [owner, slot] of byOwner) {
        const cn = slot['zh-cn'] || new Set();
        const tw = slot['zh-tw'] || new Set();
        for (const k of cn) if (!tw.has(k)) push('parity', `${owner}: ${JSON.stringify(k)} has zh-cn but no zh-tw entry`);
        for (const k of tw) if (!cn.has(k)) push('parity', `${owner}: ${JSON.stringify(k)} has zh-tw but no zh-cn entry`);
    }

    for (const plugin of LUKER_PLUGINS) {
        const calls = inv.callsByOwner.get(plugin);
        if (!calls) continue;
        const slot = byOwner.get(plugin) || {};
        for (const [key, sites] of [...calls].sort((a, b) => a[0].localeCompare(b[0]))) {
            const where = [...sites].sort().join(', ');
            for (const locale of LOCALES) {
                if (key.startsWith(SIM_PREFIX)) {
                    if (!simTables[locale]?.entries.has(key)) push('plugin-missing', `${plugin} (${locale}): ${JSON.stringify(key)} missing from the simulation-review table (used at ${where})`);
                } else if (!slot[locale]?.has(key) && !Object.hasOwn(inv.json[locale], key) && !coreLocaleDataEntries[locale].has(key)) {
                    push('plugin-missing', `${plugin} (${locale}): lacks key ${JSON.stringify(key)} (used at ${where})`);
                }
            }
        }
    }

    const semicolonKeys = new Set();
    for (const locale of LOCALES) for (const k of Object.keys(inv.json[locale])) if (k.includes(';')) semicolonKeys.add(k);
    for (const t of inv.tables) for (const k of t.entries.keys()) if (k.includes(';')) semicolonKeys.add(k);
    for (const { file, raw } of inv.dataI18n) {
        for (const k of semicolonKeys) {
            const bare = k.replace(/^\[\S+\]/, '');
            // An escaped occurrence reads `\;`, so any verbatim match of the
            // bare key is an unescaped one, even if an escaped copy also exists.
            if (raw.includes(bare)) push('data-i18n-semicolon', `${file}: data-i18n="${shownRaw(raw)}" contains ${JSON.stringify(bare)} with an unescaped ';' (write \\; inside the attribute)`);
        }
    }

    return violations;
}

function main() {
    const args = process.argv.slice(2);
    const jsonIdx = args.indexOf('--json');
    const inv = collectInventory(process.env.LUKER_I18N_ROOT ? resolve(process.env.LUKER_I18N_ROOT) : DEFAULT_ROOT);
    if (jsonIdx !== -1 && args[jsonIdx + 1]) {
        const dump = {
            tables: inv.tables.map(t => ({ ...t, entries: Object.fromEntries([...t.entries].map(([k, e]) => [k, { value: e.value, line: e.line }])) })),
            jsonDuplicates: inv.jsonDuplicates,
            sharedCalls: Object.fromEntries([...inv.sharedCalls].map(([k, s]) => [k, [...s]])),
            callsByOwner: Object.fromEntries([...inv.callsByOwner].map(([o, m]) => [o, Object.fromEntries([...m].map(([k, s]) => [k, [...s]]))])),
            unresolvedSharedCalls: inv.unresolvedSharedCalls,
            literalOwners: Object.fromEntries([...inv.literalOwners].map(([k, s]) => [k, [...s]])),
        };
        writeFileSync(args[jsonIdx + 1], JSON.stringify(dump, null, 2));
    }
    const violations = runChecks(inv);
    if (violations.length === 0) {
        console.log('i18n coverage: no violations.');
        process.exit(0);
    }
    const byCheck = new Map();
    for (const v of violations) {
        if (!byCheck.has(v.check)) byCheck.set(v.check, []);
        byCheck.get(v.check).push(v.message);
    }
    for (const [check, list] of byCheck) {
        console.log(`[${check}] ${list.length}`);
        for (const m of list) console.log(`  ${m}`);
    }
    console.error(`\n${violations.length} i18n violation(s) found.`);
    console.error('Fix:');
    console.error('  - shared-missing: keys rendered by iteration-library/, lib/, run-panel/ or skills/ need entries in public/locales/zh-cn.json and zh-tw.json.');
    console.error('  - plugin-missing: keys rendered by a Luker plugin need entries in its createPluginI18n table (or public/locales/*.json).');
    console.error('  - interpolated-call: pass a static format string with \'${0}\' placeholders to i18nFormat/tFormat, or use tagged t`...`.');
    console.error('  - json-parity: keep public/locales/zh-cn.json and zh-tw.json key sets aligned.');
    console.error('  - plugin-add-locale-data / plugin-core-translate: Luker plugins pass their tables to createPluginI18n (lib/plugin-i18n.js) and translate through it.');
    console.error('  - unresolved-table: write the createPluginI18n tables argument as a same-file object literal or const of locale objects.');
    console.error('  - plugin-data-i18n: render Luker plugin text through the plugin translator; data-i18n is translated from the global table only.');
    console.error('  - global-table-override / global-table-collision: an extension addLocaleData table must not change a JSON value or disagree with another extension table.');
    console.error('  - parity: add the missing locale entry to the same table.');
    console.error('  - json-duplicate: keep the last occurrence (the value JSON.parse uses) and delete the others.');
    console.error('  - core-table: move non-sim.* keys from core addLocaleData tables into the JSON files.');
    console.error('  - data-i18n-semicolon: escape ; as \\; inside data-i18n, or reword the key without ;.');
    process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
