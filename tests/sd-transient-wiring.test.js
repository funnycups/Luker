// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';
import { parse } from 'espree';

function nodes(root, predicate) {
    const found = [];
    function visit(node, ancestors = []) {
        if (!node || typeof node.type !== 'string') return;
        if (predicate(node)) found.push({ node, ancestors });
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const child of value) visit(child, [...ancestors, node]);
            } else if (value && typeof value === 'object') {
                visit(value, [...ancestors, node]);
            }
        }
    }
    visit(root);
    return found;
}

function moduleTree(relativePath) {
    return parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), {
        ecmaVersion: 'latest',
        sourceType: 'module',
    });
}

function functions(tree) {
    return new Map(nodes(tree, node => node.type === 'FunctionDeclaration')
        .map(({ node }) => [node.id.name, node]));
}

const imageModule = moduleTree('../public/scripts/extensions/stable-diffusion/index.js');
const imageFunctions = functions(imageModule);
const send = imageFunctions.get('sendGenerationRequest');
const backendCalls = nodes(send, node => node.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && /^generate.*Image$/.test(node.callee.name));

describe('temporary image transport wiring', () => {
    // These assertions inspect call-graph contracts, not prompt wording or
    // substituted core behavior. Real media I/O runs in transient-sessions.test.
    test('every dispatched image backend receives the request scope', () => {
        expect(backendCalls.length).toBeGreaterThan(0);
        for (const { node } of backendCalls) {
            expect(node.arguments.at(-1)).toMatchObject({ type: 'Identifier', name: 'extraOptions' });
        }
        const assignments = nodes(send, node => node.type === 'AssignmentExpression'
            && node.left.type === 'MemberExpression'
            && node.left.object.name === 'extraOptions'
            && node.left.property.name === 'transientSessionId');
        expect(assignments).toHaveLength(1);
        expect(assignments[0].node.right).toMatchObject({
            type: 'MemberExpression',
            object: { name: 'structuredOptions' },
            property: { name: 'transientSessionId' },
        });
    });

    test('backend HTTP calls use the scope-aware header builder', () => {
        const names = new Set(backendCalls.map(({ node }) => node.callee.name));
        names.add('generateComfyImageCommon');
        for (const name of names) {
            const declaration = imageFunctions.get(name);
            expect(declaration.params.at(-1)).toMatchObject({
                type: 'AssignmentPattern', left: { name: 'extraOptions' },
            });
            const headers = nodes(declaration, node => node.type === 'Property' && node.key.name === 'headers');
            for (const { node } of headers) {
                expect(node.value).toMatchObject({
                    type: 'CallExpression',
                    callee: { name: 'generationRequestHeaders' },
                    arguments: [{ type: 'Identifier', name: 'extraOptions' }],
                });
            }
        }
    });

    test.each([
        ['createIllustrationBridge', 'generateImage'],
        ['createImageGenerationService', 'generate'],
    ])('%s keeps global tracking out of its untracked %s path', (factory, methodName) => {
        const method = nodes(imageFunctions.get(factory), node => node.type === 'Property'
            && node.key.name === methodName)[0].node.value;
        const tracking = nodes(method, node => node.type === 'CallExpression'
            && ['registerAbortController', 'unregisterAbortController', 'startGenerationTracking', 'endGenerationTracking']
                .includes(node.callee.name));
        expect(tracking).toHaveLength(4);
        for (const { ancestors } of tracking) {
            expect(ancestors.some(node => node.type === 'IfStatement'
                && node.test.type === 'Identifier' && node.test.name === 'trackActivity')).toBe(true);
        }
    });

    test('global state writes forward the optional owner through the existing API', () => {
        const stateFunctions = functions(moduleTree('../public/scripts/extensions.js'));
        for (const name of ['setGlobalState', 'patchGlobalState']) {
            const declaration = stateFunctions.get(name);
            expect(declaration.params[2]).toMatchObject({
                type: 'AssignmentPattern', left: { name: 'options' },
            });
            const headers = nodes(declaration, node => node.type === 'CallExpression'
                && node.callee.name === 'transientSessionHeaders');
            expect(headers).toHaveLength(1);
            expect(headers[0].node.arguments[0]).toMatchObject({
                type: 'MemberExpression',
                object: { name: 'options' },
                property: { name: 'transientSessionId' },
            });
        }
        const patches = nodes(stateFunctions.get('updateGlobalState'), node => node.type === 'CallExpression'
            && node.callee.name === 'patchGlobalState');
        expect(patches).toHaveLength(1);
        expect(patches[0].node.arguments[2]).toMatchObject({ type: 'Identifier', name: 'options' });
    });

    test('base64 uploads forward the optional owner without changing ordinary folder rules', () => {
        const save = functions(moduleTree('../public/scripts/utils.js')).get('saveBase64AsFile');
        expect(save.params[5]).toMatchObject({ type: 'AssignmentPattern', left: { type: 'ObjectPattern' } });
        const headers = nodes(save, node => node.type === 'CallExpression'
            && node.callee.name === 'transientSessionHeaders');
        expect(headers).toHaveLength(1);
        expect(headers[0].node.arguments[0]).toMatchObject({ type: 'Identifier', name: 'transientSessionId' });
    });

    test('reference downloads and local promotions forward staging and ownership', () => {
        const declarations = functions(moduleTree('../public/scripts/extensions/stable-diffusion/character-sources-client.js'));
        for (const name of ['fetchReferenceImage', 'promoteLocalReferenceImage']) {
            const declaration = declarations.get(name);
            expect(declaration.params[0].properties.map(property => property.key.name))
                .toEqual(expect.arrayContaining(['staging', 'transientSessionId']));
            const headers = nodes(declaration, node => node.type === 'CallExpression'
                && node.callee.name === 'transientSessionHeaders');
            expect(headers).toHaveLength(1);
            expect(headers[0].node.arguments[0]).toMatchObject({ type: 'Identifier', name: 'transientSessionId' });
            const bodies = nodes(declaration, node => node.type === 'CallExpression'
                && node.callee.type === 'MemberExpression'
                && node.callee.object.name === 'JSON' && node.callee.property.name === 'stringify');
            expect(bodies[0].node.arguments[0].properties.map(property => property.key.name)).toContain('staging');
        }
    });

    test('profile commits pass their owner to the existing state updater', () => {
        const store = functions(moduleTree('../public/scripts/extensions/stable-diffusion/character-archive/store.js'))
            .get('createCharacterProfileStore');
        for (const name of ['upsertProfile', 'deleteProfile']) {
            const method = nodes(store, node => node.type === 'Property' && node.key.name === name)[0].node.value;
            const updates = nodes(method, node => node.type === 'CallExpression'
                && node.callee.type === 'MemberExpression' && node.callee.property.name === 'updateGlobalState');
            expect(updates).toHaveLength(1);
            expect(updates[0].node.arguments[2].properties.map(property => property.key.name)).toContain('transientSessionId');
        }
    });
});
