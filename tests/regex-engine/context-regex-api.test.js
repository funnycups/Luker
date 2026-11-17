// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

function walkJsFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...walkJsFiles(full));
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    }
    return out;
}

describe('Luker.getContext().regex API and plugin import boundary', () => {
    test('st-context.js exposes the complete runtime and script regex API surface on context.regex', () => {
        const stContextSrc = fs.readFileSync(path.join(REPO_ROOT, 'public/scripts/st-context.js'), 'utf8');
        const requiredKeys = [
            'applyRegex:',
            'runRegexScript:',
            'placement:',
            'substituteFindRegex:',
            'SCRIPT_TYPES:',
            'registerRegexProvider:',
            'registerManagedRegexProvider:',
            'unregisterRegexProvider:',
            'getScripts:',
            'getScriptsByType:',
            'saveScriptsByType:',
            'getPluginLanes:',
            'omitLegacyPluginScope:',
            'normalizePluginScriptRecord:',
        ];
        for (const key of requiredKeys) {
            expect(stContextSrc).toContain(key);
        }
    });

    test('no built-in extension outside public/scripts/extensions/regex/ directly imports regex/engine.js', () => {
        const extensionsDir = path.join(REPO_ROOT, 'public/scripts/extensions');
        const offenders = [];
        for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name === 'regex' || entry.name === 'third-party') continue;
            for (const file of walkJsFiles(path.join(extensionsDir, entry.name))) {
                const src = fs.readFileSync(file, 'utf8');
                const stripped = src
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                if (/regex\/engine\.js/.test(stripped)) {
                    offenders.push(path.relative(REPO_ROOT, file));
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
