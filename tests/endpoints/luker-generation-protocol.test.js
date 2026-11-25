// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from '@jest/globals';
import {
    accumulateChunkTextIntoJob,
    completeGenerationJobFromText,
    createGenerationJob,
    failGenerationJob,
    finalizeJobProtocolStream,
    persistGenerationJobIfUnacked,
} from '../../src/endpoints/backends/luker-generation.js';

let seq = 0;
function makeReq(body = {}) {
    return {
        user: { profile: { handle: 'proto-alice' }, directories: {} },
        body,
    };
}

describe('luker-generation SSE framing detection & terminal job guards', () => {
    test('non-streaming JSON with blank-line keepalives or pretty-printed blank lines is not misclassified as SSE', () => {
        const chatReq = makeReq({ chat_completion_source: 'openai', stream: false });
        const chatJob = createGenerationJob(chatReq, { job_id: `json-keepalive-${++seq}` });
        accumulateChunkTextIntoJob(chatJob, Buffer.from('\n\n'));
        accumulateChunkTextIntoJob(chatJob, Buffer.from(
            '{\n\n  "choices": [\n\n    { "message": { "role": "assistant", "content": "Clean JSON reply" } }\n  ]\n}',
        ));
        finalizeJobProtocolStream(chatJob);
        expect(chatJob.parseError).toBeFalsy();
        expect(chatJob._streamMode).toBe('json');
        expect(chatJob.text).toBe('Clean JSON reply');

        const legacyReq = makeReq({ api_type: 'kobold', streaming: false });
        const legacyJob = createGenerationJob(legacyReq, { job_id: `legacy-keepalive-${++seq}` });
        accumulateChunkTextIntoJob(legacyJob, Buffer.from('\n\n{\n\n  "results": [{ "text": "Legacy JSON reply" }]\n}'));
        finalizeJobProtocolStream(legacyJob);
        expect(legacyJob._streamMode).not.toBe('sse');
        expect(legacyJob.text).toBe('Legacy JSON reply');
    });

    test('genuine SSE frames preceded by blank lines are still detected as SSE', () => {
        const req = makeReq({ chat_completion_source: 'openai' });
        const job = createGenerationJob(req, { job_id: `sse-leading-blank-${++seq}` });
        accumulateChunkTextIntoJob(job, Buffer.from('\n\n'));
        accumulateChunkTextIntoJob(job, Buffer.from('data: {"choices":[{"delta":{"content":"Streamed"}}]}\n\ndata: [DONE]\n\n'));
        finalizeJobProtocolStream(job);
        expect(job._streamMode).toBe('sse');
        expect(job.parseError).toBeFalsy();
        expect(job.text).toBe('Streamed');
    });

    test('finalizeJobProtocolStream records json parseError for malformed non-streaming response bodies', () => {
        const htmlReq = makeReq({ chat_completion_source: 'openai', stream: false });
        const htmlJob = createGenerationJob(htmlReq, { job_id: `bad-html-${++seq}` });
        accumulateChunkTextIntoJob(htmlJob, Buffer.from('<html>502 Bad Gateway</html>'));
        finalizeJobProtocolStream(htmlJob);
        expect(htmlJob.parseError?.stage).toBe('json');

        const truncReq = makeReq({ chat_completion_source: 'openai', stream: false });
        const truncJob = createGenerationJob(truncReq, { job_id: `bad-trunc-${++seq}` });
        accumulateChunkTextIntoJob(truncJob, Buffer.from('{"choices": ['));
        finalizeJobProtocolStream(truncJob);
        expect(truncJob.parseError?.stage).toBe('json');
    });

    test('explicit non-streaming job rejects SSE-framed response body instead of switching to SSE mode', () => {
        const req = makeReq({ chat_completion_source: 'openai', stream: false });
        const job = createGenerationJob(req, { job_id: `nonstream-sse-${++seq}` });
        accumulateChunkTextIntoJob(job, Buffer.from('data: {"choices":[{"delta":{"content":"leaked"}}]}\n\ndata: [DONE]\n\n'));
        finalizeJobProtocolStream(job);
        expect(job._streamMode).not.toBe('sse');
        expect(job.text).toBe('');
        expect(job.parsedTurn ?? null).toBeNull();
        expect(job.parseError?.stage).toBe('json');
    });

    test('completeGenerationJobFromText guards failed, cancelled, completed, and aborted jobs', async () => {
        const req = makeReq({ model: 'gpt-4o' });

        const failedJob = createGenerationJob(req, { job_id: `guard-failed-${++seq}` });
        failGenerationJob(failedJob, 'aborted by client');
        await completeGenerationJobFromText(req, failedJob, 'should not overwrite', 'gpt-4o');
        expect(failedJob.status).toBe('failed');
        expect(failedJob.error).toBe('aborted by client');
        expect(failedJob.persistenceTimer).toBeNull();

        const abortedJob = createGenerationJob(req, { job_id: `guard-aborted-${++seq}` });
        const ac = new AbortController();
        abortedJob.abortController = ac;
        ac.abort('user stopped');
        await completeGenerationJobFromText(req, abortedJob, 'partial', 'gpt-4o');
        expect(abortedJob.status).toBe('failed');
        expect(abortedJob.persistenceTimer).toBeNull();

        const completedJob = createGenerationJob(req, { job_id: `guard-completed-${++seq}` });
        completedJob.status = 'completed';
        completedJob.persisted = true;
        const result = await completeGenerationJobFromText(req, completedJob, 'duplicate', 'gpt-4o');
        expect(result).toBe(true);
        expect(completedJob.status).toBe('completed');
        expect(completedJob.persistenceTimer).toBeNull();
    });

    test('failGenerationJob does not overwrite terminal jobs and persistGenerationJobIfUnacked skips jobs with parseError', async () => {
        const req = makeReq({ chat_completion_source: 'openai', model: 'gpt-4o' });

        const doneJob = createGenerationJob(req, { job_id: `term-done-${++seq}` });
        doneJob.status = 'completed';
        failGenerationJob(doneJob, 'late error');
        expect(doneJob.status).toBe('completed');

        const failedJob = createGenerationJob(req, { job_id: `term-failed-${++seq}` });
        failGenerationJob(failedJob, 'first error');
        failGenerationJob(failedJob, 'second error');
        expect(failedJob.error).toBe('first error');

        const errJob = createGenerationJob(req, {
            job_id: `parse-err-persist-${++seq}`,
            persist_target: { kind: 'group', id: 'g1', char_name: 'Iris' },
        });
        errJob.text = 'partial text before error';
        errJob.parseError = { protocol: 'openai_chat', stage: 'provider_error', message: 'Overloaded' };
        const persisted = await persistGenerationJobIfUnacked(errJob);
        expect(persisted).toBe(false);
    });
});
