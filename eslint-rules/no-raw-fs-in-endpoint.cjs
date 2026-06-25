// eslint-rules/no-raw-fs-in-endpoint.cjs
//
// Custom ESLint rule for the Luker project. Flags any function inside
// src/endpoints/<file>.js that references BOTH:
//   * a raw fs.* (or fsPromises.*) sync call from the FS_METHODS set, AND
//   * a request.user.directories.* / req.user.directories.* member access.
//
// The motivating bug class: endpoints that read/write through raw fs while
// the canonical storage layer (Repos) is the supported path. Once an
// endpoint is converted to use a Repo, it can be removed from
// no-raw-fs-allowlist.json and this rule will keep it honest.
//
// Allowlisted filenames are exempt; non-endpoint files are out of scope.

const fs = require('node:fs');
const path = require('node:path');

const allowlist = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'no-raw-fs-allowlist.json'), 'utf8'),
);
// Anchor allowlist entries to the repo root (one level above this rule file)
// so the resolved absolute paths don't depend on ESLint's CWD. Without this,
// invoking ESLint from a subdirectory would silently make allowlisted files
// trip the rule.
const ALLOWED = new Set(
    allowlist.allowedFiles.map((p) => path.resolve(__dirname, '..', p)),
);

const FS_METHODS = new Set([
    'writeFileSync',
    'readFileSync',
    'readdirSync',
    'unlinkSync',
    'renameSync',
    'copyFileSync',
    'cpSync',
    'rmSync',
    'writeFileAtomicSync',
    'tryWriteFileSync',
]);

// Async equivalents reached via `fs.promises.X` or via `fsPromises.X`
// (when imported as `import { promises as fsPromises } from 'node:fs'`).
// These slip past the sync set entirely, so endpoints can launder
// raw-disk access through the async surface unless we look for them
// here too.
const ASYNC_FS_METHODS = new Set([
    'writeFile',
    'readFile',
    'readdir',
    'unlink',
    'rename',
    'copyFile',
    'cp',
    'rm',
    'mkdir',
    'stat',
    'access',
    'appendFile',
    'chmod',
    'truncate',
    'realpath',
]);

function isFsCall(node) {
    if (node.type !== 'CallExpression') return false;
    const callee = node.callee;
    if (!callee || callee.type !== 'MemberExpression') return false;
    if (!callee.property || callee.property.type !== 'Identifier') return false;
    const methodName = callee.property.name;

    // Pattern A: fs.<sync> or fsPromises.<method>
    //   `fsPromises.X` is the alias form of `fs.promises.X`, so accept
    //   either sync OR async method names on it.
    if (callee.object && callee.object.type === 'Identifier') {
        const objName = callee.object.name;
        if (objName === 'fs') {
            return FS_METHODS.has(methodName);
        }
        if (objName === 'fsPromises') {
            return FS_METHODS.has(methodName) || ASYNC_FS_METHODS.has(methodName);
        }
        return false;
    }

    // Pattern B: fs.promises.<async-method>
    //   callee.object is itself a MemberExpression: { object: Identifier('fs'),
    //   property: Identifier('promises') }, with `methodName` as the leaf.
    if (
        callee.object && callee.object.type === 'MemberExpression' &&
        callee.object.object && callee.object.object.type === 'Identifier' &&
        callee.object.object.name === 'fs' &&
        callee.object.property && callee.object.property.type === 'Identifier' &&
        callee.object.property.name === 'promises'
    ) {
        return ASYNC_FS_METHODS.has(methodName);
    }

    return false;
}

function isReqUserDirectories(node) {
    // Match: request.user.directories.X OR req.user.directories.X
    // AST shape for `request.user.directories.X` is MemberExpression chains:
    //   { object: { object: { object: Identifier('request'),
    //                         property: Identifier('user') },
    //               property: Identifier('directories') },
    //     property: Identifier('X') }
    if (!node || node.type !== 'MemberExpression') return false;
    const obj = node.object;
    if (!obj || obj.type !== 'MemberExpression') return false;
    const obj2 = obj.object;
    if (!obj2 || obj2.type !== 'MemberExpression') return false;
    const root = obj2.object;
    return (
        root && root.type === 'Identifier' &&
        (root.name === 'request' || root.name === 'req') &&
        obj2.property && obj2.property.name === 'user' &&
        obj.property && obj.property.name === 'directories'
    );
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Endpoints must go through storage Repos, not raw fs on request.user.directories',
        },
        schema: [],
        messages: {
            rawFsInEndpoint:
                'Endpoint handler uses raw fs.* together with request.user.directories.*. ' +
                'Route this through a storage Repo (getChatRepo / getSettingsRepo / etc.) instead. ' +
                'See src/storage/README.md. If this file legitimately stays on disk, add it to eslint-rules/no-raw-fs-allowlist.json.',
        },
    },
    create(context) {
        const filename = context.getFilename();
        const resolved = path.resolve(filename);
        // Rule is scoped to src/endpoints/ — no-ops elsewhere.
        if (!resolved.includes(path.sep + 'src' + path.sep + 'endpoints' + path.sep)) {
            return {};
        }
        if (ALLOWED.has(resolved)) return {};

        // Walk each function body; flag when the SAME function body contains
        // both an fs.* call and a request.user.directories.* access.
        return {
            ':function'(node) {
                let hasFs = false;
                let hasReqUserDir = false;
                let firstBadNode = null;
                const stack = [node.body];
                while (stack.length) {
                    const cur = stack.pop();
                    if (!cur || typeof cur !== 'object') continue;
                    // Stop at nested function boundaries — each nested function
                    // gets its own :function visitor call from ESLint, so this
                    // walker must only see code inside the outer function's
                    // own lexical scope. Without this prune, an outer that
                    // touches request.user.directories.* gets falsely credited
                    // with fs.* calls that live inside a nested helper.
                    if (cur !== node && (
                        cur.type === 'FunctionDeclaration' ||
                        cur.type === 'FunctionExpression' ||
                        cur.type === 'ArrowFunctionExpression'
                    )) {
                        continue;
                    }
                    if (cur.type) {
                        if (isFsCall(cur)) {
                            hasFs = true;
                            firstBadNode = firstBadNode || cur;
                        }
                        if (isReqUserDirectories(cur)) {
                            hasReqUserDir = true;
                            firstBadNode = firstBadNode || cur;
                        }
                    }
                    for (const key of Object.keys(cur)) {
                        if (key === 'parent' || key === 'loc' || key === 'range') continue;
                        const child = cur[key];
                        if (child && typeof child === 'object') {
                            if (Array.isArray(child)) {
                                for (const c of child) stack.push(c);
                            } else {
                                stack.push(child);
                            }
                        }
                    }
                }
                if (hasFs && hasReqUserDir) {
                    context.report({
                        node: firstBadNode || node,
                        messageId: 'rawFsInEndpoint',
                    });
                }
            },
        };
    },
};
