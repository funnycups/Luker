import { describe, test, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-plugin-imports.js');

const trees = [];
afterEach(() => {
    while (trees.length) rmSync(trees.pop(), { recursive: true, force: true });
});

function makeTree(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'luker-plugin-imports-'));
    trees.push(root);
    mkdirSync(path.join(root, 'public', 'scripts', 'extensions'), { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(root, rel);
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
    }
    return root;
}

function lint(root) {
    return spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, LUKER_LINT_ROOT: root },
        encoding: 'utf8',
    });
}

describe('check-plugin-imports', () => {
    test.each([
        ['public/scripts/core.js', 'import { x } from \'./extensions/orchestrator/x.js\';'],
        ['public/scripts/extensions/search-tools/a.js', 'import { x } from \'../orchestrator/x.js\';'],
        ['public/scripts/extensions/search-tools/a.js', 'import {\n x\n} from \'../orchestrator/x.js\';'],
        ['public/scripts/extensions/search-tools/a.js', 'import \'../orchestrator/x.js\';'],
    ])('detects forbidden import in %s with source %s', (file, source) => {
        const root = makeTree({ [file]: source });
        expect(lint(root).status).toBe(1);
    });
    test('a clean tree exits 0', () => {
        const root = makeTree({
            'public/scripts/lib/leaf.js': 'export const leaf = 1;\n',
            'public/scripts/extensions/orchestrator/a.js': 'import { leaf } from \'../../lib/leaf.js\';\nimport { x } from \'/scripts/lib/leaf.js\';\nexport * from \'/scripts/run-panel/events.js\';\n',
        });
        const out = lint(root);
        expect(out.status).toBe(0);
        expect(out.stdout).toContain('No plugin boundary violations.');
    });

    test('a platform dir importing a plugin is a violation', () => {
        const root = makeTree({
            'public/scripts/extensions/orchestrator/y.js': 'export const y = 1;\n',
            'public/scripts/iteration-library/x.js': '// header\nimport { y } from \'../extensions/orchestrator/y.js\';\n',
        });
        const out = lint(root);
        expect(out.status).toBe(1);
        expect(out.stdout).toContain('Platform → plugin violations:');
        expect(out.stdout).toContain('public/scripts/iteration-library/x.js:2');
    });

    test('absolute /scripts/ specifiers resolve to core, platform and plugin dirs', () => {
        const root = makeTree({
            'public/scripts/extensions/orchestrator/a.js': [
                'import { b } from \'/scripts/utils.js\';',
                'import { c } from \'/scripts/lib/c.js\';',
                'const mg = import(\'/scripts/extensions/memory-graph/main.js\');',
                '',
            ].join('\n'),
        });
        const out = lint(root);
        expect(out.status).toBe(1);
        expect(out.stdout).toContain('public/scripts/extensions/orchestrator/a.js:1  import \'/scripts/utils.js\'');
        expect(out.stdout).not.toContain('\'/scripts/lib/c.js\'');
        expect(out.stdout).toContain('(peer: memory-graph)');
    });

    test('re-exports from core are violations', () => {
        const root = makeTree({
            'public/scripts/extensions/search-tools/a.js': 'export * from \'../../utils.js\';\n',
        });
        const out = lint(root);
        expect(out.status).toBe(1);
        expect(out.stdout).toContain('public/scripts/extensions/search-tools/a.js:1');
    });

    test('the repository has no boundary violations', () => {
        const out = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
        expect(out.stdout).toContain('No plugin boundary violations.');
        expect(out.status).toBe(0);
    });
});
