/**
 * iteration-library/runner is a thin re-export of lib/iter-tool-calling
 * and lib/abort-utils. The test asserts identity (same function references)
 * so a future rename or accidental drop of an export is caught.
 */

import { describe, test, expect } from '@jest/globals';
import * as runner from '../../public/scripts/iteration-library/runner.js';
import * as iterToolCalling from '../../public/scripts/lib/iter-tool-calling.js';
import * as abortUtils from '../../public/scripts/lib/abort-utils.js';

describe('iteration-library/runner — public surface', () => {
    test('LLM primitives identity-match lib/iter-tool-calling exports', () => {
        expect(runner.requestToolCallsWithRetry).toBe(iterToolCalling.requestToolCallsWithRetry);
        expect(runner.buildExecutionToolCalls).toBe(iterToolCalling.buildExecutionToolCalls);
        expect(runner.buildPendingToolResults).toBe(iterToolCalling.buildPendingToolResults);
        expect(runner.makeAiIterationMessageId).toBe(iterToolCalling.makeAiIterationMessageId);
    });

    test('abortUtils namespace re-exports lib/abort-utils', () => {
        // identity-check whatever the abort-utils module actually exports
        for (const key of Object.keys(abortUtils)) {
            expect(runner.abortUtils[key]).toBe(abortUtils[key]);
        }
        expect(Object.keys(runner.abortUtils).length).toBeGreaterThan(0);
    });
});
