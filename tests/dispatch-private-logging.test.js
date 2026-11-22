// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { parse } from 'espree';

const dispatchDirectory = fileURLToPath(new URL('../src/luker-dispatch/', import.meta.url));
const loggingModule = path.join(dispatchDirectory, 'logging.js');

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type) visit(node);
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(child => walk(child, visit));
        else if (value && typeof value === 'object') walk(value, visit);
    }
}

const providerFiles = fs.readdirSync(path.join(dispatchDirectory, 'providers'), { recursive: true })
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(dispatchDirectory, 'providers', name));

describe('private dispatch logging boundaries', () => {
    test.each([
        ...providerFiles,
        path.join(dispatchDirectory, 'runner.js'),
        path.join(dispatchDirectory, 'context.js'),
        path.join(dispatchDirectory, '../endpoints/backends/luker-generation.js'),
        path.join(dispatchDirectory, '../endpoints/generation-control.js'),
    ])('console calls in %s use the scoped logger', (filename) => {
        const ast = parse(fs.readFileSync(filename, 'utf8'), { sourceType: 'module', ecmaVersion: 'latest' });
        const calls = [];
        walk(ast, node => {
            if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
                && node.callee.object.type === 'Identifier' && node.callee.object.name === 'console') {
                calls.push(node);
            }
        });
        const binding = ast.body.find(node => node.type === 'ImportDeclaration' && node.specifiers.some(specifier =>
            specifier.type === 'ImportSpecifier' && specifier.imported.name === 'dispatchLog' && specifier.local.name === 'console'));
        const expectedBinding = calls.length ? loggingModule : null;
        expect({
            filename: path.relative(dispatchDirectory, filename),
            binding: binding ? path.resolve(path.dirname(filename), binding.source.value) : null,
        }).toEqual({
            filename: path.relative(dispatchDirectory, filename),
            binding: expectedBinding,
        });
    });
});
