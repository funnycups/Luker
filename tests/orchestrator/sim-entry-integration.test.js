/**
 * Integration smoke test for sim entry wrap (Task 4).
 *
 * Cannot drive runDirectorSimulationLoop end-to-end from jest because it
 * pulls in SillyTavern's full chat completion stack. Instead, verify the
 * import surface is consistent: main.js imports beginSimulation +
 * endSimulation from loop-tools.js so the wrap can compile. The actual
 * runtime wrap behavior is covered by the hand e2e step in the spec.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mainPath = resolve('../public/scripts/extensions/orchestrator/main.js');
const source = readFileSync(mainPath, 'utf8');

function extractFunctionBody(name) {
    // Accept either `async function NAME(` or `const NAME = async (...) => {`
    // — runOneOrchestrationSimulationAttempt is declared as an arrow assigned
    // to a `const` inside runAiIterationSimulation, not as a top-level
    // function statement.
    const candidates = [
        `async function ${name}(`,
        `const ${name} = async (`,
        `const ${name} = async function`,
    ];
    let start = -1;
    for (const probe of candidates) {
        const idx = source.indexOf(probe);
        if (idx !== -1) { start = idx; break; }
    }
    if (start === -1) return null;
    // Track brace balance from the first '{' after the signature
    let i = source.indexOf('{', start);
    if (i === -1) return null;
    let depth = 1;
    let j = i + 1;
    while (j < source.length && depth > 0) {
        const ch = source[j];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        j++;
    }
    return depth === 0 ? source.slice(start, j) : null;
}

describe('main.js sim wrap (Task 4)', () => {
    test('imports beginSimulation and endSimulation from loop-tools', () => {
        expect(source).toMatch(/from '\.\/loop-tools\.js'/);
        const importBlock = source.match(/import \{[^}]*\} from '\.\/loop-tools\.js'/);
        expect(importBlock).toBeTruthy();
        expect(importBlock[0]).toMatch(/beginSimulation/);
        expect(importBlock[0]).toMatch(/endSimulation/);
    });

    test('runDirectorSimulationLoop does NOT call beginSimulation (covered by outer wrap)', () => {
        const body = extractFunctionBody('runDirectorSimulationLoop');
        expect(body).toBeTruthy();
        expect(body).not.toMatch(/beginSimulation\s*\(/);
        expect(body).not.toMatch(/endSimulation\s*\(/);
    });

    test('runOneOrchestrationSimulationAttempt wraps its body in beginSimulation/endSimulation', () => {
        const body = extractFunctionBody('runOneOrchestrationSimulationAttempt');
        expect(body).toBeTruthy();
        expect(body).toMatch(/beginSimulation\s*\(/);
        expect(body).toMatch(/finally\s*\{[\s\S]*?endSimulation\s*\(/);
    });
});
