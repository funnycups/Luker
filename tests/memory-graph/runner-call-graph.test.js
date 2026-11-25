/**
 * Code-shape contract: memory-graph's LLM requests go through the shared
 * tool-call runner in lib/iter-tool-calling.js. Parses main.js with acorn and
 * asserts structural call-graph invariants rather than formatting or brittle
 * total helper counts.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const MAIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/scripts/extensions/memory-graph/main.js');
const source = readFileSync(MAIN_PATH, 'utf8');
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

function walkAst(node, visitor, parents = []) {
    if (!node || typeof node !== 'object') return;
    visitor(node, parents);
    const nextParents = [...parents, node];
    for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item.type === 'string') walkAst(item, visitor, nextParents);
            }
        } else if (value && typeof value.type === 'string') {
            walkAst(value, visitor, nextParents);
        }
    }
}

function propertyName(prop) {
    if (!prop || prop.type !== 'Property') return null;
    if (!prop.computed && prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

function getObjectProperty(objNode, name) {
    if (!objNode || objNode.type !== 'ObjectExpression') return null;
    return objNode.properties.find(prop => propertyName(prop) === name) || null;
}

function enclosingFunctionName(parents) {
    for (let i = parents.length - 1; i >= 0; i -= 1) {
        const node = parents[i];
        if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') && node.id?.name) {
            return node.id.name;
        }
    }
    return null;
}

function collectCalls(calleeName) {
    const calls = [];
    walkAst(ast, (node, parents) => {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === calleeName) {
            calls.push({ node, enclosingFunction: enclosingFunctionName(parents) });
        }
    });
    return calls;
}

describe('memory-graph main.js — shared runner call graph', () => {
    test('the local runner, RPM fork, and legacy function-call-runtime import are gone', () => {
        const declaredFunctions = new Set();
        const identifiers = new Set();
        const importSources = new Set();

        walkAst(ast, (node) => {
            if (node.type === 'FunctionDeclaration' && node.id?.name) {
                declaredFunctions.add(node.id.name);
            }
            if (node.type === 'Identifier') {
                identifiers.add(node.name);
            }
            if (node.type === 'ImportDeclaration' && typeof node.source.value === 'string') {
                importSources.add(node.source.value);
            }
        });

        for (const removedFn of [
            'requestSingleFunctionCallWithRetry',
            'requestToolCallsWithRetry',
            'waitForRpmSlot',
            'createLinkedAbortController',
        ]) {
            expect(declaredFunctions.has(removedFn)).toBe(false);
        }
        expect(identifiers.has('_rpmTimestamps')).toBe(false);
        expect(identifiers.has('generateTask')).toBe(false);
        expect(importSources.has('../function-call-runtime.js')).toBe(false);
    });

    test('the runner is imported from lib/iter-tool-calling.js', () => {
        const runnerImport = ast.body.find(
            node => node.type === 'ImportDeclaration' && node.source.value === '../../lib/iter-tool-calling.js',
        );
        expect(runnerImport).toBeDefined();
        const importedNames = runnerImport.specifiers
            .filter(spec => spec.type === 'ImportSpecifier')
            .map(spec => spec.imported.name);
        expect(importedNames).toContain('requestToolCallsWithRetry');
    });

    test('every shared runner call renders macros on the memory-graph RPM bucket with a logLabel and preserves single-function vs multi-tool contracts', () => {
        const calls = collectCalls('requestToolCallsWithRetry');
        expect(calls.length).toBeGreaterThanOrEqual(2);

        const singleFunctionCalls = [];
        const multiToolCalls = [];
        for (const call of calls) {
            const optionsArg = call.node.arguments[2];
            expect(optionsArg?.type).toBe('ObjectExpression');

            const substituteMacros = getObjectProperty(optionsArg, 'substituteMacros');
            expect(substituteMacros?.value?.type).toBe('Literal');
            expect(substituteMacros?.value?.value).toBe(true);

            const rpmBucket = getObjectProperty(optionsArg, 'rpmBucket');
            expect(rpmBucket?.value?.type).toBe('Identifier');
            expect(rpmBucket?.value?.name).toBe('MODULE_NAME');

            expect(getObjectProperty(optionsArg, 'logLabel')).not.toBeNull();

            if (call.enclosingFunction === 'requestMgFunctionCall') {
                singleFunctionCalls.push(optionsArg);
            } else {
                multiToolCalls.push(optionsArg);
            }
        }

        // Single-function wrapper forces the requested function unless preamble is allowed.
        expect(singleFunctionCalls).toHaveLength(1);
        const [singleOpts] = singleFunctionCalls;
        const allowedNames = getObjectProperty(singleOpts, 'allowedNames');
        expect(allowedNames?.value?.type).toBe('ArrayExpression');
        expect(allowedNames.value.elements).toHaveLength(1);
        expect(allowedNames.value.elements[0]).toMatchObject({ type: 'Identifier', name: 'fnName' });

        const toolChoice = getObjectProperty(singleOpts, 'toolChoice');
        expect(toolChoice?.value?.type).toBe('ConditionalExpression');
        expect(toolChoice.value.test).toMatchObject({ type: 'Identifier', name: 'allowPreamble' });
        expect(toolChoice.value.consequent).toMatchObject({ type: 'Literal', value: 'auto' });
        expect(toolChoice.value.alternate?.type).toBe('ObjectExpression');
        expect(getObjectProperty(toolChoice.value.alternate, 'type')?.value).toMatchObject({ type: 'Literal', value: 'function' });
        const forcedFnObj = getObjectProperty(toolChoice.value.alternate, 'function')?.value;
        expect(getObjectProperty(forcedFnObj, 'name')?.value).toMatchObject({ type: 'Identifier', name: 'fnName' });

        const requiredFn = getObjectProperty(singleOpts, 'requiredFunctionName');
        expect(requiredFn?.value?.type).toBe('ConditionalExpression');
        expect(requiredFn.value.test).toMatchObject({ type: 'Identifier', name: 'allowPreamble' });
        expect(requiredFn.value.consequent).toMatchObject({ type: 'Literal', value: '' });
        expect(requiredFn.value.alternate).toMatchObject({ type: 'Identifier', name: 'fnName' });

        // Multi-tool callers outside requestMgFunctionCall allow empty responses.
        expect(multiToolCalls.length).toBeGreaterThanOrEqual(1);
        for (const opts of multiToolCalls) {
            const allowEmpty = getObjectProperty(opts, 'allowEmptyResponse');
            expect(allowEmpty?.value).toMatchObject({ type: 'Literal', value: true });
        }
    });

    test('runFunctionCallTask delegates to requestMgFunctionCall and callers invoke both helpers', () => {
        const mgCalls = collectCalls('requestMgFunctionCall');
        expect(mgCalls.some(call => call.enclosingFunction === 'runFunctionCallTask')).toBe(true);
        expect(mgCalls.some(call => call.enclosingFunction !== 'runFunctionCallTask')).toBe(true);

        const taskCalls = collectCalls('runFunctionCallTask');
        expect(taskCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('a new recall start aborts the superseded run', () => {
        const abortCalls = collectCalls('abortActiveRecallRequests');
        const hasSupersedeAbort = abortCalls.some(({ node }) =>
            node.arguments.length >= 2
            && node.arguments[0]?.type === 'Identifier'
            && node.arguments[0].name === 'previousRecallRunToken'
            && node.arguments[1]?.type === 'Literal'
            && node.arguments[1].value === 0,
        );
        expect(hasSupersedeAbort).toBe(true);
    });
});
