import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KEEP_ALIVE = path.join(REPO_ROOT, 'harmony-app', 'entry', 'src', 'main', 'ets', 'KeepAliveManager.ets');
const INDEX = path.join(REPO_ROOT, 'harmony-app', 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets');
const SCRIPT = path.join(REPO_ROOT, 'public', 'script.js');

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

// Slice the brace-balanced body of the first `{...}` group at or after `from`.
// This lets an assertion look inside one class or one call without matching the
// same text somewhere else in the file.
function bracedBody(source, from) {
    const open = source.indexOf('{', from);
    if (open === -1) {
        return null;
    }
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') {
            depth++;
        } else if (source[i] === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(open + 1, i);
            }
        }
    }
    return null;
}

function classBody(source, className) {
    const start = source.indexOf(`class ${className}`);
    return start === -1 ? null : bracedBody(source, start);
}

test('the HarmonyOS bridge exposes openExternalUrl', () => {
    const body = classBody(read(KEEP_ALIVE), 'LukerHarmonyBridge');
    expect(body).not.toBeNull();
    expect(body).toContain('openExternalUrl(');
});

test('the page registers openExternalUrl on the javaScriptProxy method list', () => {
    const source = read(INDEX);
    const start = source.indexOf('.javaScriptProxy(');
    expect(start).toBeGreaterThan(-1);

    const body = bracedBody(source, start);
    expect(body).not.toBeNull();

    const methodList = /methodList\s*:\s*\[([^\]]*)\]/.exec(body);
    expect(methodList).not.toBeNull();
    expect(methodList[1]).toContain('\'openExternalUrl\'');
});

test('the frontend opens the harmony release page before it falls back to the git flow', () => {
    const source = read(SCRIPT);
    const harmonyCall = source.indexOf('window.LukerHarmony.openExternalUrl(');
    const gitCall = source.indexOf('await runServerGitUpdateFlow(');

    expect(harmonyCall).toBeGreaterThan(-1);
    expect(gitCall).toBeGreaterThan(-1);
    expect(harmonyCall).toBeLessThan(gitCall);
});
