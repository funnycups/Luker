// tests/i18n/scoped-i18n-exposure.test.js
import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

test('st-context.js imports createScopedI18n and exposes it on the context', () => {
    const src = readFileSync(fileURLToPath(new URL('../../public/scripts/st-context.js', import.meta.url)), 'utf8');
    const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    const imported = ast.body.find(node => node.type === 'ImportDeclaration' && node.source.value === './i18n.js');
    const binding = imported.specifiers.find(node => node.imported?.name === 'createScopedI18n')?.local.name;
    expect(binding).toBeDefined();
    const properties = [];
    const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Property' && node.key?.name === 'createScopedI18n') properties.push(node.value.name);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    };
    visit(ast);
    expect(properties).toContain(binding);
});
