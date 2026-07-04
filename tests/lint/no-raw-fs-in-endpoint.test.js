import { RuleTester } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const rule = requireCjs('../../eslint-rules/no-raw-fs-in-endpoint.cjs');

// The rule anchors its allowlist paths against `path.resolve(__dirname,
// '..', entry)` — i.e. the repo root, one level above eslint-rules/.
// This suite's `filename` fields have to resolve against the SAME
// anchor or the allowlist match silently fails (and the "avatars.js is
// allowlisted" valid case turns into a bogus rule report). Anchoring
// against `process.cwd()` here would resolve into `<repo>/tests/src/...`
// when the suite runs from tests/, which mismatches the rule's
// `<repo>/src/...` anchor. Use the test-file directory (`tests/lint/`)
// walked up two levels to get the repo root deterministically.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const endpointPath = (rel) => path.resolve(REPO_ROOT, rel);

const ruleTester = new RuleTester({
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('no-raw-fs-in-endpoint', rule, {
    valid: [
        // Only Repo usage — no fs, no req.user.directories. Clean.
        {
            code: `import { getChatRepo } from '../storage/index.js';
                   async function h(request) {
                       return getChatRepo().get(request.user.profile.handle, 'x');
                   }`,
            filename: endpointPath('src/endpoints/test-clean.js'),
        },
        // Allowlisted file — uses fs.* and request.user.directories together, but exempt.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       fs.writeFileSync(request.user.directories.chats + '/x', 'data');
                   }`,
            filename: endpointPath('src/endpoints/avatars.js'),
        },
        // Non-endpoint file (rule scoped to src/endpoints/). Same code, outside scope.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       fs.writeFileSync(request.user.directories.chats + '/x', 'data');
                   }`,
            filename: endpointPath('src/users.js'),
        },
        // Same file uses fs and req.user.directories but not in the same function — OK.
        {
            code: `import fs from 'fs';
                   function a(request) { return request.user.directories.chats; }
                   function b() { fs.writeFileSync('/tmp/x', 'data'); }`,
            filename: endpointPath('src/endpoints/clean-split.js'),
        },
        // fs.* without request.user.directories — OK (e.g. writing to /tmp).
        {
            code: `import fs from 'fs';
                   function h() { fs.writeFileSync('/tmp/x', 'data'); }`,
            filename: endpointPath('src/endpoints/tmp-only.js'),
        },
        // request.user.directories without fs.* — OK (e.g. read-only path inspection).
        {
            code: `function h(request) { return request.user.directories.chats; }`,
            filename: endpointPath('src/endpoints/path-only.js'),
        },
        // Outer reads request.user.directories.* but the fs.* call lives in a
        // nested helper that does NOT touch req.user.dirs. Each function gets
        // its own :function visitor call, so the walker must stop at nested
        // function boundaries — otherwise the outer is falsely flagged.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       const dir = request.user.directories.chats;
                       function logToTmp() { fs.writeFileSync('/tmp/log', 'data'); }
                       logToTmp();
                       return dir;
                   }`,
            filename: endpointPath('src/endpoints/nested-helper.js'),
        },
        // Allowlisted file uses fs.promises.* with request.user.directories.* — exempt.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       await fs.promises.writeFile(request.user.directories.backups + '/x', 'data');
                   }`,
            filename: endpointPath('src/endpoints/backups.js'),
        },
        // Allowlisted file uses fsPromises alias with request.user.directories.* — exempt.
        {
            code: `import { promises as fsPromises } from 'node:fs';
                   async function h(request) {
                       await fsPromises.readdir(request.user.directories.avatars);
                   }`,
            filename: endpointPath('src/endpoints/avatars.js'),
        },
        // fs.promises.* without request.user.directories — OK (e.g. writing to /tmp).
        {
            code: `import fs from 'fs';
                   async function h() { await fs.promises.writeFile('/tmp/x', 'data'); }`,
            filename: endpointPath('src/endpoints/tmp-only-async.js'),
        },
        // fsPromises.* alias without request.user.directories — OK.
        {
            code: `import { promises as fsPromises } from 'node:fs';
                   async function h() { await fsPromises.readdir('/tmp'); }`,
            filename: endpointPath('src/endpoints/tmp-only-async2.js'),
        },
    ],
    invalid: [
        // request + writeFileSync in the same function — flagged.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       fs.writeFileSync(request.user.directories.chats + '/x', 'data');
                   }`,
            filename: endpointPath('src/endpoints/regression.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
        // req alias + readdirSync — flagged.
        {
            code: `import fs from 'fs';
                   async function h(req) {
                       fs.readdirSync(req.user.directories.worlds);
                   }`,
            filename: endpointPath('src/endpoints/regression2.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
        // fsPromises alias also caught.
        {
            code: `import fsPromises from 'node:fs/promises';
                   async function h(request) {
                       fsPromises.unlinkSync(request.user.directories.chats + '/x');
                   }`,
            filename: endpointPath('src/endpoints/regression3.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
        // Inner IIFE is the real offender — fs.* and request.user.directories
        // live in the same nested function body. The rule must still fire on
        // the inner via its own :function visitor call, even after the walker
        // is taught to stop at nested function boundaries.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       const handle = request.user.profile.handle;
                       return (function inner() {
                           fs.writeFileSync(request.user.directories.chats + '/x', 'data');
                       })();
                   }`,
            filename: endpointPath('src/endpoints/inner-offender.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
        // Non-allowlisted endpoint uses fs.promises.writeFile with request.user.directories.* — flagged.
        {
            code: `import fs from 'fs';
                   async function h(request) {
                       await fs.promises.writeFile(request.user.directories.chats + '/x', 'data');
                   }`,
            filename: endpointPath('src/endpoints/regression-async1.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
        // Non-allowlisted endpoint uses fsPromises.readdir with req.user.directories.* — flagged.
        {
            code: `import { promises as fsPromises } from 'node:fs';
                   async function h(req) {
                       await fsPromises.readdir(req.user.directories.worlds);
                   }`,
            filename: endpointPath('src/endpoints/regression-async2.js'),
            errors: [{ messageId: 'rawFsInEndpoint' }],
        },
    ],
});
