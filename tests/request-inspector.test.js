// SPDX-License-Identifier: AGPL-3.0-or-later
import {
    startInspection,
    completeInspection,
    completeInspectionFromStream,
    getBufferForHandle,
} from '../src/request-inspector.js';

// Each test gets a unique handle so the module-level ring buffer stays
// isolated between cases; findEntry() keys on handle + __inspectorId.
let counter = 0;
function newRequest(source = 'openai') {
    counter++;
    return {
        user: { profile: { handle: `ri-test-${counter}` } },
        body: {
            chat_completion_source: source,
            model: 'test-model',
            messages: [{ role: 'user', content: 'hi' }],
        },
    };
}

function getEntry(request) {
    const handle = request.user.profile.handle;
    const buf = getBufferForHandle(handle);
    return buf.find(e => e.id === request.__inspectorId);
}

describe('request-inspector: 200-but-error detection', () => {
    describe('completeInspection (non-streaming)', () => {
        test('payload.error with .message → status=error, entry.error populated, httpStatus stays 200', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { message: 'rate limit exceeded' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('rate limit exceeded');
            // Truthful HTTP status preserved — the fetch itself returned 200.
            // UI shows status=error + httpStatus=200 so the user can see the
            // "HTTP succeeded but body was an error" case at a glance.
            expect(e.httpStatus).toBe(200);
        });

        test('payload.error with .code (no .message) → uses code as error message', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { code: 'insufficient_quota' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('insufficient_quota');
        });

        test('payload.error with .type (Anthropic-style) → uses type as error message', () => {
            const req = newRequest('claude');
            startInspection(req);
            completeInspection(req, { error: { type: 'overloaded_error' } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('overloaded_error');
        });

        test('payload.error as plain string → stringifies to that string', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: 'plain string error' });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('plain string error');
        });

        test('payload.error object with no .message/.code/.type → JSON.stringify fallback', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, { error: { details: 'weird shape', http: 429 } });

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe(JSON.stringify({ details: 'weird shape', http: 429 }));
        });

        test('normal success payload (no error field) still marks status=success', () => {
            const req = newRequest();
            startInspection(req);
            completeInspection(req, {
                choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
            });

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
            expect(e.responseText).toBe('hello');
            expect(e.usage.prompt_tokens).toBe(5);
        });

        test('Makersuite-style blocked payload (dispatch-constructed {error:{message}}) → status=error', () => {
            // Mirrors makersuite dispatch's blocked-prompt branch which posts
            // `{error:{message:'...blocked...'}}` through inspection.complete
            // so the inspector sees the payload and classifies it.
            const req = newRequest('makersuite');
            startInspection(req);
            completeInspection(
                req,
                { error: { message: 'no candidate returned (blocked by SAFETY)' } },
                { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] },
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toContain('blocked by SAFETY');
            expect(e.httpStatus).toBe(200);
        });
    });

    describe('completeInspectionFromStream (SSE)', () => {
        test('single error frame → status=error, entry.error populated, httpStatus=200', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [JSON.stringify({ error: { message: 'context_length_exceeded' } })],
                '',
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('context_length_exceeded');
            expect(e.httpStatus).toBe(200);
        });

        test('partial success: content deltas then error frame → status=error but accumulated text preserved', () => {
            const req = newRequest();
            startInspection(req);
            const events = [
                JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
                JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
                JSON.stringify({ error: { message: 'stream cut short' } }),
            ];
            completeInspectionFromStream(req, events, 'Hello world');

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('stream cut short');
            // Partial content the model already produced is preserved so the
            // user can see how far the stream got before it broke.
            expect(e.responseText).toBe('Hello world');
            expect(e.responseParts).toEqual([{ type: 'text', text: 'Hello world' }]);
        });

        test('normal stream (no error frame) still marks status=success', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })],
                'ok',
            );

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
            expect(e.responseText).toBe('ok');
        });

        test('error frame in { data } event object shape (luker-generation envelope)', () => {
            // runner.js pushes plain-string SSE data lines, but the reader path
            // (normalizeEvent) also accepts {seq, data, ts} envelopes so error
            // detection must handle both shapes.
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [{ seq: 1, data: JSON.stringify({ error: { message: 'upstream timeout' } }), ts: Date.now() }],
                '',
            );

            const e = getEntry(req);
            expect(e.status).toBe('error');
            expect(e.error).toBe('upstream timeout');
        });

        test('non-JSON frames and [DONE] sentinel do not trip false positives', () => {
            const req = newRequest();
            startInspection(req);
            completeInspectionFromStream(
                req,
                [
                    JSON.stringify({ choices: [{ delta: { content: 'a' } }] }),
                    '[DONE]',
                    'garbage-not-json',
                ],
                'a',
            );

            const e = getEntry(req);
            expect(e.status).toBe('success');
            expect(e.error).toBe('');
        });
    });
});
