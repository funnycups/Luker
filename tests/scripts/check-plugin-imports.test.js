// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    LUKER_PLATFORM_DIRS,
    findPluginViolations,
    findReverseViolations,
} from '../../scripts/check-plugin-imports.js';

function writeFile(root, relPath, content) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
}

describe('scripts/check-plugin-imports.js', () => {
    let tmpRoot;

    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-check-plugin-imports-'));
        fs.mkdirSync(path.join(tmpRoot, 'public/scripts/extensions'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('LUKER_PLATFORM_DIRS includes workbench, lens-shared, and run-panel', () => {
        expect(LUKER_PLATFORM_DIRS.has('workbench')).toBe(true);
        expect(LUKER_PLATFORM_DIRS.has('lens-shared')).toBe(true);
        expect(LUKER_PLATFORM_DIRS.has('run-panel')).toBe(true);
    });

    test('allows plugins to import platform modules while flagging core and peer plugin imports', () => {
        writeFile(tmpRoot, 'public/scripts/workbench/registry.js', 'export const ok = true;\n');
        writeFile(tmpRoot, 'public/scripts/lens-shared/util.js', 'export const h = () => {};\n');
        writeFile(tmpRoot, 'public/scripts/run-panel/store.js', 'export const s = 1;\n');
        writeFile(tmpRoot, 'public/scripts/openai.js', 'export const x = 1;\n');
        writeFile(tmpRoot, 'public/scripts/extensions/memory-graph/api.js', 'export const mg = 1;\n');

        writeFile(
            tmpRoot,
            'public/scripts/extensions/orchestrator/main.js',
            [
                'import { ok } from \'../../workbench/registry.js\';',
                'import { h } from \'../../lens-shared/util.js\';',
                'import { s } from \'/scripts/run-panel/store.js\';',
                'import { x } from \'../../openai.js\';',
                'import { mg } from \'../memory-graph/api.js\';',
                'import { registerRegexProvider } from \'../regex/engine.js\';',
            ].join('\n'),
        );

        const { coreViolations, pluginViolations } = findPluginViolations(tmpRoot);

        expect(coreViolations.get('orchestrator')).toEqual([
            {
                file: 'public/scripts/extensions/orchestrator/main.js',
                line: 3,
                spec: '../../openai.js',
                target: 'public/scripts/openai.js',
            },
        ]);
        expect(pluginViolations.get('orchestrator')).toEqual([
            {
                file: 'public/scripts/extensions/orchestrator/main.js',
                line: 4,
                spec: '../memory-graph/api.js',
                target: 'public/scripts/extensions/memory-graph/api.js',
                peer: 'memory-graph',
            },
            {
                file: 'public/scripts/extensions/orchestrator/main.js',
                line: 5,
                spec: '../regex/engine.js',
                target: 'public/scripts/extensions/regex/engine.js',
                peer: 'regex',
            },
        ]);
    });

    test('recursively flags any extension import from workbench, lens-shared, and run-panel', () => {
        writeFile(
            tmpRoot,
            'public/scripts/workbench/model/bad.js',
            [
                'import { a } from \'../../extensions/connection-manager/profile-resolver.js\';',
                'import { b } from \'/scripts/extensions/orchestrator/main.js\';',
                'import { util } from \'../../lens-shared/util.js\';',
                'import { ctx } from \'../../st-context.js\';',
            ].join('\n'),
        );
        writeFile(
            tmpRoot,
            'public/scripts/lens-shared/nested/bad.js',
            'import { c } from \'../../extensions/shared.js\';\n',
        );
        writeFile(
            tmpRoot,
            'public/scripts/run-panel/sub/bad.js',
            'const mod = await import(\'../../extensions/regex/engine.js\');\n',
        );
        writeFile(
            tmpRoot,
            'public/script.js',
            [
                'import { getRegexedString } from \'./scripts/extensions/regex/engine.js\';',
                'import { bad } from \'./scripts/extensions/card-app/main.js\';',
            ].join('\n'),
        );

        const hits = findReverseViolations(tmpRoot);

        expect(hits).toEqual([
            {
                file: 'public/script.js',
                line: 1,
                spec: './scripts/extensions/card-app/main.js',
                target: 'public/scripts/extensions/card-app/main.js',
            },
            {
                file: 'public/scripts/workbench/model/bad.js',
                line: 1,
                spec: '../../extensions/connection-manager/profile-resolver.js',
                target: 'public/scripts/extensions/connection-manager/profile-resolver.js',
            },
            {
                file: 'public/scripts/workbench/model/bad.js',
                line: 1,
                spec: '/scripts/extensions/orchestrator/main.js',
                target: 'public/scripts/extensions/orchestrator/main.js',
            },
            {
                file: 'public/scripts/lens-shared/nested/bad.js',
                line: 1,
                spec: '../../extensions/shared.js',
                target: 'public/scripts/extensions/shared.js',
            },
            {
                file: 'public/scripts/run-panel/sub/bad.js',
                line: 1,
                spec: '../../extensions/regex/engine.js',
                target: 'public/scripts/extensions/regex/engine.js',
            },
        ]);
    });

    test('real repo has zero plugin, core, and reverse violations', () => {
        const { coreViolations, pluginViolations } = findPluginViolations();
        expect([...coreViolations.entries()]).toEqual([]);
        expect([...pluginViolations.entries()]).toEqual([]);
        const hits = findReverseViolations();
        const platformHits = hits.filter(h => (
            h.file.startsWith('public/scripts/workbench/')
            || h.file.startsWith('public/scripts/lens-shared/')
            || h.file.startsWith('public/scripts/run-panel/')
        ));
        expect(platformHits).toEqual([]);
    });
});
